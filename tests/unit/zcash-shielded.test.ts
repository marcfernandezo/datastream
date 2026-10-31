import { randomBytes } from "node:crypto";
import { bech32m } from "@scure/base";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAdaptersForTests } from "@/server/chains/registry";
import { SyncPendingError } from "@/server/chains/types";
import { createZcashAdapter, ZEC } from "@/server/chains/zcash/adapter";
import { estimateHeight, parseBirthday, parseUfvk } from "@/server/chains/zcash/shielded";
import { schema } from "@/server/db/client";
import { createHttpClient } from "@/server/http/client";
import { handlers } from "@/server/jobs/handlers";
import { claimNext, enqueue, reschedule, RetryLaterError } from "@/server/jobs/queue";
import { maskSensitive } from "@/server/log/mask";
import { createWallet, deleteWallet } from "@/server/wallets/service";
import { syncWallet } from "@/server/wallets/sync";
import { useTestDb } from "./helpers/db";
import { makeCtx, server, setupMsw } from "./helpers/msw";

setupMsw();

/** Synthetic: valid Bech32m with the UFVK prefix, not a real key. */
const fakeUfvk = (hrp = "uview", bytes = 200) =>
  bech32m.encode(hrp, bech32m.toWords(randomBytes(bytes)), false);
const UFVK = fakeUfvk();
const VIEWER = "http://zcash-viewer.test:8232";
const TOKEN = "t".repeat(40);
const ACCOUNT = "616aac93-bb47-4f21-9dc1-0337e3603cdc";

const zecWithViewer = () =>
  createZcashAdapter({
    apiUrl: "https://zec.test/zcash",
    apiKey: undefined,
    explorerUrl: "https://blockchair.test/zcash",
    rps: 1000,
    viewer: { url: VIEWER, token: TOKEN },
  });

interface SidecarState {
  ready: boolean;
  imports: unknown[];
  deletes: string[];
  lastError?: string | null;
  lastSyncAt?: number | null;
}

/** Mocks the zcash-viewer API and records what the adapter sends. */
function mockSidecar(state: SidecarState) {
  const authed = (request: Request) => request.headers.get("authorization") === `Bearer ${TOKEN}`;
  server.use(
    http.post(`${VIEWER}/v1/accounts`, async ({ request }) => {
      if (!authed(request)) return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      state.imports.push(await request.json());
      return HttpResponse.json({ accountId: ACCOUNT, created: true, birthdayHeight: 2_990_000 });
    }),
    http.get(`${VIEWER}/v1/accounts/${ACCOUNT}`, () =>
      HttpResponse.json({
        accountId: ACCOUNT,
        birthdayHeight: 2_990_000,
        ready: state.ready,
        progress: { scanned: 43, total: 100 },
        balance: {
          total: "150000000",
          sapling: "0",
          orchard: "150000000",
          ironwood: "0",
          transparent: "0",
        },
        syncing: !state.ready,
        lastSyncAt:
          state.lastSyncAt === undefined ? Math.floor(Date.now() / 1000) : state.lastSyncAt,
        lastError: state.lastError ?? null,
        chainTipHeight: 3_536_895,
        fullyScannedHeight: state.ready ? 3_536_895 : 3_100_000,
      }),
    ),
    http.get(`${VIEWER}/v1/accounts/${ACCOUNT}/transactions`, () =>
      HttpResponse.json({
        transactions: [
          // Sent 0.5 ZEC, paid a 10 000 zat fee: delta includes the fee.
          {
            txid: "b".repeat(64),
            minedHeight: 3_536_000,
            blockTime: 1_793_400_000,
            delta: -50_010_000,
            fee: 10_000,
            expiredUnmined: false,
          },
          // Received 2 ZEC; the sender paid the fee.
          {
            txid: "a".repeat(64),
            minedHeight: 3_400_000,
            blockTime: 1_783_000_000,
            delta: 200_000_000,
            fee: null,
            expiredUnmined: false,
          },
        ],
        hasMore: false,
      }),
    ),
    http.delete(`${VIEWER}/v1/accounts/:id`, ({ params }) => {
      state.deletes.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
  );
}

describe("viewing key and birthday parsing", () => {
  it("accepts a mainnet UFVK envelope and canonicalizes case", () => {
    expect(parseUfvk(UFVK.toUpperCase())).toBe(UFVK);
  });

  it("rejects incoming-only, testnet, malformed and truncated keys", () => {
    expect(() => parseUfvk(fakeUfvk("uivk"))).toThrow(/incoming viewing key/);
    expect(() => parseUfvk(fakeUfvk("uviewtest"))).toThrow(/Testnet/);
    expect(() => parseUfvk(UFVK.slice(0, -1) + (UFVK.endsWith("q") ? "p" : "q"))).toThrow(
      /Invalid/,
    );
    expect(() => parseUfvk(fakeUfvk("uview", 40))).toThrow(/Invalid/);
  });

  it("never logs a UFVK in full", () => {
    expect(maskSensitive(`import ${UFVK}`)).not.toContain(UFVK);
  });

  it("estimates heights from real checkpoints", () => {
    expect(estimateHeight(1_654_019_405)).toBe(1_687_104); // NU5
    expect(estimateHeight(1_752_983_473)).toBe(3_000_000);
    expect(estimateHeight(0)).toBe(419_200);
    // Past the last checkpoint: 75 s blocks.
    expect(estimateHeight(1_790_662_825 + 75 * 1000)).toBe(3_501_000);
  });

  it("parses heights and dates, starting a little early", () => {
    expect(parseBirthday("")).toBeUndefined();
    expect(parseBirthday(undefined)).toBeUndefined();
    expect(parseBirthday("2500000")).toBe(2_500_000);
    // 2025-07-20 00:00 UTC is ~3h50m before block 3 000 000.
    const h = parseBirthday("2025-07-20")!;
    expect(h).toBeLessThan(3_000_000 - 2 * 1152);
    expect(h).toBeGreaterThan(3_000_000 - 2 * 1152 - 300);
    expect(() => parseBirthday("1000")).toThrow(/Sapling/);
    expect(() => parseBirthday("2025-02-30")).toThrow(/YYYY-MM-DD/);
    expect(() => parseBirthday("yesterday")).toThrow(/YYYY-MM-DD/);
    expect(() => parseBirthday("2099-01-01")).toThrow(/future/);
  });
});

describe("zcash adapter (zcash-viewer sidecar)", () => {
  it("rejects viewing keys when the sidecar isn't configured", () => {
    const zec = createZcashAdapter({
      apiUrl: "https://zec.test/zcash",
      apiKey: undefined,
      explorerUrl: "https://blockchair.test/zcash",
      rps: 1000,
    });
    expect(() => zec.parseSource("ufvk", UFVK, {})).toThrow(/zcash-viewer sidecar/);
  });

  it("stores the birthday as a height option and a masked hint", () => {
    const { source, displayHint } = zecWithViewer().parseSource("ufvk", UFVK, {
      birthday: "2600000",
    });
    expect(source).toEqual({ kind: "ufvk", value: UFVK, options: { birthdayHeight: 2_600_000 } });
    expect(displayHint).toMatch(/^uview1.…/);
    expect(displayHint).not.toContain(UFVK.slice(10, 30));
  });

  it("reports scan progress as pending until the account is ready", async () => {
    const sidecar: SidecarState = { ready: false, imports: [], deletes: [] };
    mockSidecar(sidecar);
    const zec = zecWithViewer();
    const ctx = makeCtx();
    const src = { kind: "ufvk" as const, value: UFVK, options: { birthdayHeight: 2_990_000 } };
    const err = await zec
      .getTransactions(ctx, src, { knownTxids: new Set(), maxPages: 5 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncPendingError);
    expect((err as Error).message).toBe("Scanning shielded history 43%");
    expect(ctx.state.viewerAccountId).toBe(ACCOUNT);
    expect(sidecar.imports).toEqual([{ ufvk: UFVK, birthdayHeight: 2_990_000 }]);
  });

  it("maps balance and history, separating fees from sends", async () => {
    mockSidecar({ ready: true, imports: [], deletes: [] });
    const zec = zecWithViewer();
    const ctx = makeCtx();
    const src = { kind: "ufvk" as const, value: UFVK, options: {} };
    const txs = await zec.getTransactions(ctx, src, { knownTxids: new Set(), maxPages: 5 });
    expect(txs).toEqual([
      {
        txid: "b".repeat(64),
        blockTime: 1_793_400_000,
        blockHeight: 3_536_000,
        status: "confirmed",
        fee: 10_000n,
        movements: [{ asset: ZEC, amount: -50_000_000n }],
      },
      {
        txid: "a".repeat(64),
        blockTime: 1_783_000_000,
        blockHeight: 3_400_000,
        status: "confirmed",
        fee: null,
        movements: [{ asset: ZEC, amount: 200_000_000n }],
      },
    ]);
    expect(await zec.getBalance(ctx, src)).toEqual([{ asset: ZEC, amount: 150_000_000n }]);
  });

  it("fails loudly when the sidecar has stopped syncing", async () => {
    mockSidecar({
      ready: true,
      imports: [],
      deletes: [],
      lastError: "lightwalletd GetLatestBlock: unavailable",
      lastSyncAt: Math.floor(Date.now() / 1000) - 3 * 3600,
    });
    await expect(
      zecWithViewer().getBalance(makeCtx(), { kind: "ufvk", value: UFVK, options: {} }),
    ).rejects.toThrow(/can't sync: lightwalletd/);
  });

  it("explains a token mismatch", async () => {
    mockSidecar({ ready: true, imports: [], deletes: [] });
    const zec = createZcashAdapter({
      apiUrl: "https://zec.test/zcash",
      apiKey: undefined,
      explorerUrl: "https://blockchair.test/zcash",
      rps: 1000,
      viewer: { url: VIEWER, token: "wrong".repeat(10) },
    });
    await expect(
      zec.getBalance(makeCtx(), { kind: "ufvk", value: UFVK, options: {} }),
    ).rejects.toThrow(/ZCASH_VIEWER_TOKEN/);
  });
});

describe("shielded wallet lifecycle", () => {
  let handle: ReturnType<typeof useTestDb>;
  const deps = () => ({
    http: createHttpClient({ timeoutMs: 2_000, defaultRps: 1_000 }),
    signal: new AbortController().signal,
  });
  const walletRow = (id: string) =>
    handle.db.select().from(schema.wallets).where(eq(schema.wallets.id, id)).get()!;

  beforeEach(() => {
    handle = useTestDb();
    setAdaptersForTests([zecWithViewer()]);
  });
  afterEach(() => setAdaptersForTests(undefined));

  it("stores nothing until the first scan finishes, then syncs and forgets on delete", async () => {
    const sidecar: SidecarState = { ready: false, imports: [], deletes: [] };
    mockSidecar(sidecar);
    const { id } = createWallet({
      network: "zec",
      input: UFVK,
      label: "Shielded",
      options: { birthday: "2600000" },
    });
    expect(walletRow(id).options).toEqual({ birthdayHeight: 2_600_000 });

    // Pending: progress and adapter state are kept, no balances or history.
    await expect(syncWallet(id, deps())).rejects.toBeInstanceOf(SyncPendingError);
    let w = walletRow(id);
    expect(w.syncNote).toBe("Scanning shielded history 43%");
    expect(w.syncState).toEqual({ viewerAccountId: ACCOUNT });
    expect(w.initialSyncDone).toBe(false);
    expect(w.lastSyncError).toBeNull();
    expect(handle.db.select().from(schema.balances).all()).toHaveLength(0);
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);

    // The job handler defers instead of failing.
    await expect(
      handlers["wallet.sync"]!(
        {
          id: 1,
          kind: "wallet.sync",
          payload: { walletId: id },
          attempts: 1,
        } as never,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RetryLaterError);

    // Ready: full history lands as the initial sync (no alerts for old txs).
    sidecar.ready = true;
    const result = await syncWallet(id, deps());
    expect(result).toEqual({ newTxIds: [], txCount: 2 });
    w = walletRow(id);
    expect(w.syncNote).toBeNull();
    expect(w.initialSyncDone).toBe(true);
    expect(handle.db.select().from(schema.balances).get()?.amount).toBe("150000000");

    // Delete: the worker is asked to release the key from the sidecar.
    deleteWallet(id);
    const job = handle.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.kind, "wallet.forget"))
      .get()!;
    expect(job.payload).toEqual({ network: "zec", state: { viewerAccountId: ACCOUNT } });
    expect(JSON.stringify(job.payload)).not.toContain(UFVK);
    await handlers["wallet.forget"]!(job as never, new AbortController().signal);
    expect(sidecar.deletes).toEqual([ACCOUNT]);
  });

  it("defers a job without using up an attempt", () => {
    enqueue("wallet.sync", { walletId: "x" }, { key: "sync:x" });
    const job = claimNext()!;
    expect(job.attempts).toBe(1);
    reschedule(job, 60_000);
    expect(claimNext()).toBeNull();
    const again = claimNext(new Date(Date.now() + 61_000))!;
    expect(again.id).toBe(job.id);
    expect(again.attempts).toBe(1);
  });
});
