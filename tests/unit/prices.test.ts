import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@/server/db/client";
import { createHttpClient } from "@/server/http/client";
import { createCoinGecko } from "@/server/prices/coingecko";
import {
  backfillSnapshots,
  linkTokenAssets,
  refreshSpotPrices,
  refreshTokenMap,
  setCoinGeckoForTests,
  writeSnapshot,
} from "@/server/prices/service";
import { getHoldings, holdingsChange, isVisible, txEurValues } from "@/server/portfolio/queries";
import { useTestDb } from "./helpers/db";
import { server, setupMsw } from "./helpers/msw";

setupMsw();

const CG = "https://cg.test/api/v3";
const DAY = 86_400;
let handle: ReturnType<typeof useTestDb>;

const cg = () =>
  createCoinGecko(createHttpClient({ timeoutMs: 2000, defaultRps: 1000 }), {
    apiKey: "demo-key",
    tier: "demo",
    baseUrl: CG,
    requestsPerMinute: 60_000,
  });

function seedWallet(id = "w1") {
  handle.db
    .insert(schema.wallets)
    .values({
      id,
      label: id,
      network: "btc",
      sourceKind: "address",
      sourceEnc: "x",
      fingerprint: `fp-${id}`,
      displayHint: "x",
    })
    .run();
}

function asset(id: string, extra: Partial<typeof schema.assets.$inferInsert> = {}) {
  handle.db
    .insert(schema.assets)
    .values({
      id,
      network: "btc",
      symbol: id.toUpperCase(),
      name: id,
      decimals: 8,
      coingeckoId: null,
      ...extra,
    })
    .run();
}

function balance(walletId: string, assetId: string, amount: bigint) {
  handle.db
    .insert(schema.balances)
    .values({ walletId, assetId, amount: amount.toString(), updatedAt: new Date() })
    .run();
}

beforeEach(() => {
  handle = useTestDb();
  setCoinGeckoForTests(cg());
});
afterEach(() => setCoinGeckoForTests(undefined));

describe("coingecko client", () => {
  it("sends the demo key header and batches ids", async () => {
    const seen: { ids: string; key: string | null }[] = [];
    server.use(
      http.get(`${CG}/simple/price`, ({ request }) => {
        const url = new URL(request.url);
        const ids = url.searchParams.get("ids")!;
        seen.push({ ids, key: request.headers.get("x-cg-demo-api-key") });
        return HttpResponse.json(
          Object.fromEntries(ids.split(",").map((id) => [id, { eur: 1, eur_24h_change: 2 }])),
        );
      }),
    );
    const ids = Array.from({ length: 150 }, (_, i) => `coin-${i}`);
    const prices = await cg().simplePrice(ids);
    expect(prices.size).toBe(150);
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.key === "demo-key")).toBe(true);
  });
});

describe("price refresh", () => {
  it("prices tracked assets and writes an hourly snapshot", async () => {
    seedWallet();
    asset("btc", { coingeckoId: "bitcoin" });
    balance("w1", "btc", 150_000_000n); // 1.5 BTC
    server.use(
      http.get(`${CG}/simple/price`, () =>
        HttpResponse.json({ bitcoin: { eur: 60_000, eur_24h_change: 10 } }),
      ),
    );
    expect(await refreshSpotPrices()).toBe(1);
    expect(writeSnapshot()).toBeCloseTo(90_000);

    const holdings = getHoldings();
    expect(holdings[0]).toMatchObject({ symbol: "BTC", value: 90_000 });
    const day = holdingsChange(holdings, 1)!;
    // 24h: price was 60000 / 1.1 → value then 81818.18
    expect(day.pct).toBeCloseTo(10);
    expect(day.eur).toBeCloseTo(90_000 - 90_000 / 1.1);
  });

  it("maps token contracts to CoinGecko ids and fills missing symbols", async () => {
    asset("eth:0xa0b8", { network: "eth", contract: "0xa0b8", symbol: "USDC" });
    asset("sol:Mint111", { network: "sol", contract: "Mint111", symbol: "Mint…111" });
    asset("eth:0xspam", { network: "eth", contract: "0xspam", symbol: "FREE" });
    server.use(
      http.get(`${CG}/coins/list`, () =>
        HttpResponse.json([
          {
            id: "usd-coin",
            symbol: "usdc",
            name: "USDC",
            platforms: { ethereum: "0xA0B8", solana: null },
          },
          { id: "jupiter", symbol: "jup", name: "Jupiter", platforms: { solana: "Mint111" } },
        ]),
      ),
    );
    expect(await refreshTokenMap()).toBe(2);
    const rows = Object.fromEntries(
      handle.db
        .select()
        .from(schema.assets)
        .all()
        .map((a) => [a.id, a]),
    );
    expect(rows["eth:0xa0b8"]).toMatchObject({ coingeckoId: "usd-coin", symbol: "USDC" });
    expect(rows["sol:Mint111"]).toMatchObject({
      coingeckoId: "jupiter",
      symbol: "JUP",
      name: "Jupiter",
    });
    expect(rows["eth:0xspam"]!.coingeckoId).toBeNull();
    expect(linkTokenAssets()).toBe(0);
  });

  it("hides unpriced tokens unless the user overrides", () => {
    expect(isVisible({ contract: null, coingeckoId: null, hidden: null })).toBe(true);
    expect(isVisible({ contract: "0x1", coingeckoId: null, hidden: null })).toBe(false);
    expect(isVisible({ contract: "0x1", coingeckoId: "x", hidden: null })).toBe(true);
    expect(isVisible({ contract: "0x1", coingeckoId: null, hidden: false })).toBe(true);
    expect(isVisible({ contract: null, coingeckoId: "bitcoin", hidden: true })).toBe(false);
  });
});

describe("history backfill", () => {
  it("walks balances back through movements and fees", () => {
    const T = 20_000; // "today" as a UTC day number
    const now = (T * DAY + 3600) * 1000;
    seedWallet();
    asset("btc", { coingeckoId: "bitcoin" });
    balance("w1", "btc", 200_000_000n); // 2 BTC now

    const tx = (txid: string, day: number, amount: bigint, fee: bigint | null) => {
      const id = handle.db
        .insert(schema.transactions)
        .values({
          walletId: "w1",
          network: "btc",
          txid,
          blockTime: day * DAY + 600,
          blockHeight: 1,
          status: "confirmed",
          direction: "in",
          fee: fee?.toString() ?? null,
          firstSeenAt: new Date(),
        })
        .returning({ id: schema.transactions.id })
        .get().id;
      handle.db
        .insert(schema.txMovements)
        .values({ txId: id, assetId: "btc", amount: amount.toString() })
        .run();
    };
    tx("a", T - 3, 100_000_000n, null); // +1
    tx("b", T - 1, 150_000_000n, 50_000_000n); // +1.5, paid 0.5 fee → net +1

    for (const [day, eur] of [
      [T - 1, 100],
      [T - 2, 90],
      [T - 3, 80],
      [T - 4, 70],
    ] as const) {
      handle.db.insert(schema.priceDaily).values({ coingeckoId: "bitcoin", day, eur }).run();
    }

    backfillSnapshots(now);
    const snaps = Object.fromEntries(
      handle.db
        .select()
        .from(schema.portfolioSnapshots)
        .where(eq(schema.portfolioSnapshots.source, "backfill"))
        .all()
        .map((s) => [s.ts / DAY, s.totalEur]),
    );
    expect(snaps).toEqual({ [T - 1]: 200, [T - 2]: 90, [T - 3]: 80 });
  });
});

describe("transaction EUR values", () => {
  it("uses the daily close of the tx day, falling back to spot", () => {
    handle.db
      .insert(schema.priceDaily)
      .values({ coingeckoId: "bitcoin", day: 19_000, eur: 30_000 })
      .run();
    handle.db
      .insert(schema.priceSpot)
      .values({ coingeckoId: "bitcoin", eur: 60_000, change24h: null, updatedAt: new Date() })
      .run();
    const m = (amount: string) => ({ amount, decimals: 8, coingeckoId: "bitcoin" });
    const values = txEurValues([
      { id: 1, blockTime: 19_000 * DAY + 10, movements: [m("-50000000")] },
      { id: 2, blockTime: null, movements: [m("10000000")] },
      {
        id: 3,
        blockTime: 19_000 * DAY,
        movements: [{ amount: "5", decimals: 0, coingeckoId: null }],
      },
    ]);
    expect(values.get(1)).toBeCloseTo(-15_000);
    expect(values.get(2)).toBeCloseTo(6_000);
    expect(values.get(3)).toBeNull();
  });
});
