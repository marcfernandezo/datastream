import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { createChannel, dispatchAlerts, formatAlert, listChannels } from "@/server/alerts/service";
import { schema } from "@/server/db/client";
import { exportCsv, textCell } from "@/server/export/csv";
import { createGroup, deleteGroup, setMembership, walletIdsInGroup } from "@/server/wallets/groups";
import { useTestDb } from "./helpers/db";
import { server, setupMsw } from "./helpers/msw";

setupMsw();

const BOT = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ";
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

let handle: ReturnType<typeof useTestDb>;

function seed() {
  for (const [id, label] of [
    [W1, "Cold"],
    [W2, "Hot"],
  ] as const) {
    handle.db
      .insert(schema.wallets)
      .values({
        id,
        label,
        network: "btc",
        sourceKind: "address",
        sourceEnc: "x",
        fingerprint: id,
        displayHint: "x",
      })
      .run();
  }
  handle.db
    .insert(schema.assets)
    .values([
      {
        id: "btc",
        network: "btc",
        symbol: "BTC",
        name: "Bitcoin",
        decimals: 8,
        coingeckoId: "bitcoin",
      },
      {
        id: "btc:spam",
        network: "btc",
        contract: "spam",
        symbol: '=HYPERLINK("x")',
        name: "Spam",
        decimals: 0,
        coingeckoId: null,
      },
    ])
    .run();
  handle.db
    .insert(schema.priceSpot)
    .values({ coingeckoId: "bitcoin", eur: 50_000, change24h: null, updatedAt: new Date() })
    .run();
}

function tx(
  walletId: string,
  txid: string,
  amount: bigint,
  assetId = "btc",
  fee: string | null = null,
) {
  const id = handle.db
    .insert(schema.transactions)
    .values({
      walletId,
      network: "btc",
      txid,
      blockTime: 1_700_000_000,
      blockHeight: 1,
      status: "confirmed",
      direction: amount > 0n ? "in" : "out",
      fee,
      firstSeenAt: new Date(),
    })
    .returning({ id: schema.transactions.id })
    .get().id;
  handle.db
    .insert(schema.txMovements)
    .values({ txId: id, assetId, amount: amount.toString() })
    .run();
  return id;
}

beforeEach(() => {
  handle = useTestDb();
  seed();
});

describe("alert formatting", () => {
  const base = {
    id: 1,
    walletId: W1,
    walletLabel: "Cold",
    direction: "in" as const,
    status: "confirmed" as const,
    blockTime: 1,
    movements: [{ amount: "5000000", decimals: 8, symbol: "BTC", coingeckoId: "bitcoin" }],
  };

  it("describes the movement without addresses or txids", () => {
    const msg = formatAlert(base, 2_500, false);
    expect(msg.body).toBe("Received on Cold: +0.05 BTC (≈ €2,500.00)");
    expect(msg.tags).toEqual(["inbox_tray"]);
  });

  it("can hide amounts and masks anything address-like in labels", () => {
    expect(formatAlert(base, 2_500, true).body).toBe("Received on Cold");
    const sneaky = formatAlert({ ...base, walletLabel: ADDRESS }, null, false);
    expect(sneaky.body).not.toContain(ADDRESS);
  });
});

describe("alert dispatch", () => {
  it("delivers once per channel/tx, honours scope and threshold, retries only failures", async () => {
    const ntfyCalls: { topic: string; message: string; auth: string | null }[] = [];
    let telegramUp = false;
    let telegramCalls = 0;
    server.use(
      http.post("https://ntfy.test/", async ({ request }) => {
        const body = (await request.json()) as { topic: string; message: string };
        ntfyCalls.push({ ...body, auth: request.headers.get("authorization") });
        return HttpResponse.json({ id: "n1" });
      }),
      http.post(`https://api.telegram.org/bot${BOT}/sendMessage`, () => {
        telegramCalls++;
        return telegramUp
          ? HttpResponse.json({ ok: true })
          : HttpResponse.json({ ok: false }, { status: 401 });
      }),
    );

    createChannel({
      name: "phone",
      config: {
        kind: "ntfy",
        url: "https://ntfy.test/secret-topic",
        token: "tk_abc",
        hideAmounts: false,
      },
      scope: null,
      minEur: 100,
    });
    createChannel({
      name: "tg",
      config: { kind: "telegram", botToken: BOT, chatId: "12345", hideAmounts: true },
      scope: { walletIds: [W2], groupIds: [] },
      minEur: 0,
    });

    const big = tx(W1, "a".repeat(64), 1_000_000n); // 0.01 BTC = €500
    const small = tx(W1, "b".repeat(64), 1_000n); // €0.50, under the ntfy threshold
    const hot = tx(W2, "c".repeat(64), 2_000_000n);
    const spam = tx(W2, "d".repeat(64), 1_000n, "btc:spam");

    await expect(dispatchAlerts([big, small, hot, spam])).rejects.toThrow(/1 alert/);
    // ntfy: big + hot (small is below €100, spam has no priced movement).
    expect(ntfyCalls.map((c) => c.topic)).toEqual(["secret-topic", "secret-topic"]);
    expect(ntfyCalls[0]!.auth).toBe("Bearer tk_abc");
    expect(ntfyCalls.every((c) => !c.message.includes("aaaa"))).toBe(true);

    // Telegram failed for the hot wallet tx; the error never contains the token.
    const failed = handle.db
      .select()
      .from(schema.alertLog)
      .all()
      .filter((r) => r.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).not.toContain(BOT.split(":")[1]);

    // Retry: only the failed delivery is attempted again.
    telegramUp = true;
    const before = { ntfy: ntfyCalls.length, tg: telegramCalls };
    await expect(dispatchAlerts([big, small, hot, spam])).resolves.toEqual({ sent: 1, failed: 0 });
    expect(ntfyCalls.length).toBe(before.ntfy);
    expect(telegramCalls).toBeGreaterThan(before.tg);

    // Fully delivered: a third run is a no-op.
    await expect(dispatchAlerts([big, small, hot, spam])).resolves.toEqual({ sent: 0, failed: 0 });
  });

  it("stores channel secrets encrypted and never lists them", () => {
    createChannel({
      name: "tg",
      config: { kind: "telegram", botToken: BOT, chatId: "12345", hideAmounts: false },
      scope: null,
      minEur: 0,
    });
    const raw = JSON.stringify(handle.db.select().from(schema.alertChannels).all());
    expect(raw).not.toContain(BOT);
    expect(JSON.stringify(listChannels())).not.toContain(BOT);
    expect(listChannels()[0]!.target).toBe("chat 123••••");
  });

  it("validates channel configs", () => {
    expect(() =>
      createChannel({
        name: "x",
        config: { kind: "telegram", botToken: "nope", chatId: "1", hideAmounts: false },
        scope: null,
        minEur: 0,
      }),
    ).toThrow();
    expect(() =>
      createChannel({
        name: "x",
        config: { kind: "ntfy", url: "ftp://x/y", hideAmounts: false },
        scope: null,
        minEur: 0,
      }),
    ).toThrow();
  });
});

describe("csv export", () => {
  it("escapes formula injection in text cells only", () => {
    expect(textCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(textCell("@SUM(1)")).toBe("'@SUM(1)");
    expect(textCell("Cold, storage")).toBe('"Cold, storage"');
    expect(textCell("BTC")).toBe("BTC");
  });

  it("writes one row per movement with fees, EUR values and safe text", async () => {
    tx(W1, "e".repeat(64), -150_000_000n, "btc", "1000");
    tx(W1, "f".repeat(64), 7n, "btc:spam");
    const csv = await new Response(exportCsv({ walletIds: [W1] })).text();
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "date_utc,wallet,network,txid,direction,status,asset,amount,fee,fee_asset,eur_value_at_time,explorer_url",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(",out,confirmed,BTC,-1.5,0.00001,BTC,-75000.00,");
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")",7,,,,`);
  });
});

describe("groups", () => {
  it("manages membership and cascades on delete", () => {
    const { id } = createGroup("Cold storage");
    expect(() => createGroup("Cold storage")).toThrow(/already exists/);
    setMembership(W1, id, true);
    setMembership(W1, id, true);
    setMembership(W2, id, true);
    setMembership(W2, id, false);
    expect(walletIdsInGroup(id)).toEqual([W1]);
    deleteGroup(id);
    expect(handle.db.select().from(schema.walletGroups).all()).toHaveLength(0);
  });
});
