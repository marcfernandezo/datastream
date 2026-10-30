import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBitcoinAdapter, BTC } from "@/server/chains/bitcoin/adapter";
import { setAdaptersForTests } from "@/server/chains/registry";
import type { ChainAdapter, NormalizedTx } from "@/server/chains/types";
import { PrivateKeyMaterialError } from "@/server/crypto/secret-guard";
import { schema } from "@/server/db/client";
import { createHttpClient } from "@/server/http/client";
import { claimNext } from "@/server/jobs/queue";
import { createWallet, deleteWallet, DuplicateWalletError } from "@/server/wallets/service";
import { syncWallet } from "@/server/wallets/sync";
import { useTestDb } from "./helpers/db";

const ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

/** BTC adapter with parsing intact but network calls replaced by fixtures. */
function fakeBtc(fixture: { balance: bigint; txs: NormalizedTx[] }): ChainAdapter {
  const real = createBitcoinAdapter({
    esploraUrl: "https://unused.test",
    explorerUrl: "https://x.test",
    gapLimit: 20,
  });
  return {
    ...real,
    getBalance: async () => [{ asset: BTC, amount: fixture.balance }],
    getTokens: async () => [],
    getTransactions: async () => fixture.txs,
  };
}

const tx = (txid: string, amount: bigint, extra: Partial<NormalizedTx> = {}): NormalizedTx => ({
  txid,
  blockTime: 1_700_000_000,
  blockHeight: 1,
  status: "confirmed",
  fee: null,
  movements: [{ asset: BTC, amount }],
  ...extra,
});

let handle: ReturnType<typeof useTestDb>;
const deps = () => ({
  http: createHttpClient({ timeoutMs: 1000 }),
  signal: new AbortController().signal,
  log: pino({ level: "silent" }),
});

beforeEach(() => {
  handle = useTestDb();
});
afterEach(() => setAdaptersForTests(undefined));

describe("wallet service", () => {
  it("encrypts the source at rest and enqueues an initial sync", () => {
    setAdaptersForTests([fakeBtc({ balance: 0n, txs: [] })]);
    const { id } = createWallet({ network: "btc", input: ZPUB, label: "Cold" });
    const row = handle.db.select().from(schema.wallets).where(eq(schema.wallets.id, id)).get()!;

    expect(row.sourceKind).toBe("xpub");
    expect(row.sourceEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(ZPUB.slice(4, 30));
    expect(row.displayHint).toBe("zpub…ZYs".replace("ZYs", ZPUB.slice(-4)));
    expect(row.options).toEqual({ scriptType: "p2wpkh", prefix: "zpub" });
    expect(claimNext()?.payload).toEqual({ walletId: id });
  });

  it("rejects duplicates, private keys and invalid input", () => {
    setAdaptersForTests([fakeBtc({ balance: 0n, txs: [] })]);
    createWallet({ network: "btc", input: ADDRESS, label: "A" });
    expect(() =>
      createWallet({ network: "btc", input: ADDRESS.toUpperCase(), label: "B" }),
    ).toThrow(DuplicateWalletError);
    expect(() =>
      createWallet({
        network: "btc",
        input:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        label: "nope",
      }),
    ).toThrow(PrivateKeyMaterialError);
    expect(() => createWallet({ network: "btc", input: "bc1qnotanaddress", label: "x" })).toThrow();
    expect(() => createWallet({ network: "doge", input: ADDRESS, label: "x" })).toThrow();
    expect(() => createWallet({ network: "btc", input: ADDRESS + "x", label: "" })).toThrow();
  });
});

describe("wallet sync", () => {
  it("persists balances and history; only reports new txs after the initial sync", async () => {
    const fixture = { balance: 150n, txs: [tx("t1", 100n), tx("t2", 50n)] };
    setAdaptersForTests([fakeBtc(fixture)]);
    const { id } = createWallet({ network: "btc", input: ADDRESS, label: "Hot" });

    const first = await syncWallet(id, deps());
    expect(first.newTxIds).toEqual([]);
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(2);
    expect(handle.db.select().from(schema.balances).get()?.amount).toBe("150");

    fixture.txs = [tx("t3", -20n, { status: "pending", blockTime: null, fee: 5n }), ...fixture.txs];
    fixture.balance = 125n;
    const second = await syncWallet(id, deps());
    expect(second.newTxIds).toHaveLength(1);
    const t3 = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.txid, "t3"))
      .get()!;
    expect(t3).toMatchObject({ status: "pending", direction: "out", fee: "5" });

    // Confirmation updates the existing row instead of duplicating it.
    fixture.txs = [tx("t3", -20n, { fee: 5n, blockTime: 1_700_000_500 }), ...fixture.txs.slice(1)];
    const third = await syncWallet(id, deps());
    expect(third.newTxIds).toEqual([]);
    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.txid, "t3"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "confirmed", blockTime: 1_700_000_500 });
    expect(
      handle.db
        .select()
        .from(schema.txMovements)
        .where(eq(schema.txMovements.txId, rows[0]!.id))
        .all(),
    ).toHaveLength(1);
  });

  it("records a masked error when the provider fails", async () => {
    const failing = fakeBtc({ balance: 0n, txs: [] });
    failing.getTransactions = async () => {
      throw new Error(`esplora down for ${ADDRESS}`);
    };
    setAdaptersForTests([failing]);
    const { id } = createWallet({ network: "btc", input: ADDRESS, label: "Hot" });
    await expect(syncWallet(id, deps())).rejects.toThrow();
    const row = handle.db.select().from(schema.wallets).where(eq(schema.wallets.id, id)).get()!;
    expect(row.lastSyncError).toContain("esplora down");
    expect(row.lastSyncError).not.toContain(ADDRESS);
  });

  it("deleting a wallet cascades to its data", async () => {
    setAdaptersForTests([fakeBtc({ balance: 1n, txs: [tx("t1", 1n)] })]);
    const { id } = createWallet({ network: "btc", input: ADDRESS, label: "Hot" });
    await syncWallet(id, deps());
    deleteWallet(id);
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);
    expect(handle.db.select().from(schema.txMovements).all()).toHaveLength(0);
    expect(handle.db.select().from(schema.balances).all()).toHaveLength(0);
  });
});
