import { and, eq, gt, inArray, isNotNull, isNull, max, sql } from "drizzle-orm";
import { env } from "@/env";
import { sharedHttp } from "@/server/chains/registry";
import { db, getHandle, schema } from "@/server/db/client";
import { logger } from "@/server/log/logger";
import { unitsToNumber } from "@/lib/format";
import { createCoinGecko, PLATFORM_FOR_NETWORK, type CoinGecko } from "./coingecko";

const HISTORY_DAYS = 365;
const DAY = 86_400;

let client: CoinGecko | undefined;
export function coingecko(): CoinGecko {
  if (!client) {
    const e = env();
    client = createCoinGecko(sharedHttp(), {
      apiKey: e.COINGECKO_API_KEY,
      tier: e.COINGECKO_API_TIER,
      baseUrl: e.COINGECKO_BASE_URL,
      requestsPerMinute: e.COINGECKO_REQUESTS_PER_MINUTE,
    });
  }
  return client;
}

/** Test helper. */
export function setCoinGeckoForTests(c: CoinGecko | undefined) {
  client = c;
}

/** CoinGecko ids worth pricing: anything we hold or have moved. */
export function trackedCoinIds(): string[] {
  const rows = db()
    .selectDistinct({ id: schema.assets.coingeckoId })
    .from(schema.assets)
    .where(
      and(
        isNotNull(schema.assets.coingeckoId),
        sql`(${schema.assets.id} IN (SELECT asset_id FROM balances) OR ${schema.assets.id} IN (SELECT asset_id FROM tx_movements))`,
      ),
    )
    .all();
  return rows.map((r) => r.id!).sort();
}

export async function refreshSpotPrices(signal?: AbortSignal) {
  const ids = trackedCoinIds();
  if (ids.length === 0) return 0;
  const prices = await coingecko().simplePrice(ids, signal);
  const now = new Date();
  getHandle().sqlite.transaction(() => {
    for (const [id, p] of prices) {
      db()
        .insert(schema.priceSpot)
        .values({ coingeckoId: id, eur: p.eur, change24h: p.change24h, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.priceSpot.coingeckoId,
          set: { eur: p.eur, change24h: p.change24h, updatedAt: now },
        })
        .run();
    }
  })();
  return prices.size;
}

/** Fetches daily history for coins whose stored history is missing or stale. */
export async function refreshPriceHistory(signal?: AbortSignal) {
  const today = Math.floor(Date.now() / 1000 / DAY);
  const latest = new Map(
    db()
      .select({ id: schema.priceDaily.coingeckoId, day: max(schema.priceDaily.day) })
      .from(schema.priceDaily)
      .groupBy(schema.priceDaily.coingeckoId)
      .all()
      .map((r) => [r.id, r.day ?? 0]),
  );
  let fetched = 0;
  for (const id of trackedCoinIds()) {
    const last = latest.get(id);
    if (last !== undefined && last >= today - 1) continue;
    const days = last === undefined ? HISTORY_DAYS : Math.min(HISTORY_DAYS, today - last + 1);
    const series = await coingecko().dailyHistory(id, days, signal);
    getHandle().sqlite.transaction(() => {
      for (const [day, eur] of series) {
        db()
          .insert(schema.priceDaily)
          .values({ coingeckoId: id, day, eur })
          .onConflictDoUpdate({
            target: [schema.priceDaily.coingeckoId, schema.priceDaily.day],
            set: { eur },
          })
          .run();
      }
    })();
    fetched++;
  }
  return fetched;
}

/** Refreshes the contract → coin id map and links unpriced token assets to it. */
export async function refreshTokenMap(signal?: AbortSignal) {
  const list = await coingecko().coinsList(signal);
  const rows: (typeof schema.tokenMap.$inferInsert)[] = [];
  for (const coin of list) {
    for (const [network, platform] of Object.entries(PLATFORM_FOR_NETWORK)) {
      const contract = coin.platforms?.[platform];
      if (!contract) continue;
      rows.push({
        network,
        contract: network === "eth" ? contract.toLowerCase() : contract,
        coingeckoId: coin.id,
        symbol: coin.symbol.toUpperCase().slice(0, 32),
        name: coin.name.slice(0, 64),
      });
    }
  }
  getHandle().sqlite.transaction(() => {
    db().delete(schema.tokenMap).run();
    for (let i = 0; i < rows.length; i += 500)
      db()
        .insert(schema.tokenMap)
        .values(rows.slice(i, i + 500))
        .run();
  })();
  const linked = linkTokenAssets();
  logger.info({ mapped: rows.length, linked }, "token map refreshed");
  return linked;
}

/**
 * Links token assets without a coin id to the token map. Fills in symbol/name
 * when the adapter had none (e.g. SPL mints without on-chain metadata).
 */
export function linkTokenAssets() {
  const unlinked = db()
    .select()
    .from(schema.assets)
    .where(and(isNull(schema.assets.coingeckoId), isNotNull(schema.assets.contract)))
    .all();
  let linked = 0;
  for (const a of unlinked) {
    const m = db()
      .select()
      .from(schema.tokenMap)
      .where(and(eq(schema.tokenMap.network, a.network), eq(schema.tokenMap.contract, a.contract!)))
      .get();
    if (!m) continue;
    const unnamed = a.symbol.includes("…") || a.symbol === "???";
    db()
      .update(schema.assets)
      .set({ coingeckoId: m.coingeckoId, ...(unnamed ? { symbol: m.symbol, name: m.name } : {}) })
      .where(eq(schema.assets.id, a.id))
      .run();
    linked++;
  }
  return linked;
}

/** Hourly snapshot of the live portfolio value, for the performance chart. */
export function writeSnapshot(now = Date.now()) {
  const holdings = db()
    .select({
      assetId: schema.balances.assetId,
      amount: schema.balances.amount,
      decimals: schema.assets.decimals,
      eur: schema.priceSpot.eur,
      hidden: schema.assets.hidden,
    })
    .from(schema.balances)
    .innerJoin(schema.wallets, eq(schema.wallets.id, schema.balances.walletId))
    .innerJoin(schema.assets, eq(schema.assets.id, schema.balances.assetId))
    .innerJoin(schema.priceSpot, eq(schema.priceSpot.coingeckoId, schema.assets.coingeckoId))
    .where(eq(schema.wallets.archived, false))
    .all();
  const byAsset: Record<string, number> = {};
  let total = 0;
  for (const h of holdings) {
    if (h.hidden === true) continue;
    const value = unitsToNumber(h.amount, h.decimals) * h.eur;
    byAsset[h.assetId] = (byAsset[h.assetId] ?? 0) + value;
    total += value;
  }
  const ts = Math.floor(now / 1000 / 3600) * 3600;
  db()
    .insert(schema.portfolioSnapshots)
    .values({ ts, totalEur: total, byAsset, source: "live" })
    .onConflictDoUpdate({
      target: schema.portfolioSnapshots.ts,
      set: { totalEur: total, byAsset, source: "live" },
    })
    .run();
  return total;
}

/**
 * Reconstructs daily portfolio values before the first live snapshot by
 * walking balances backwards through recorded movements and fees, valued at
 * that day's close. Approximate when a wallet's history was capped.
 */
export function backfillSnapshots(now = Date.now()) {
  const firstLive =
    db()
      .select({ ts: sql<number>`min(${schema.portfolioSnapshots.ts})` })
      .from(schema.portfolioSnapshots)
      .where(eq(schema.portfolioSnapshots.source, "live"))
      .get()?.ts ?? Math.floor(now / 1000);
  const today = Math.floor(firstLive / DAY);
  const startDay = today - HISTORY_DAYS;

  const assets = new Map(
    db()
      .select()
      .from(schema.assets)
      .where(isNotNull(schema.assets.coingeckoId))
      .all()
      .filter((a) => a.hidden !== true)
      .map((a) => [a.id, a]),
  );
  if (assets.size === 0) return 0;
  const activeWallets = db()
    .select({ id: schema.wallets.id, network: schema.wallets.network })
    .from(schema.wallets)
    .where(eq(schema.wallets.archived, false))
    .all();
  const walletIds = activeWallets.map((w) => w.id);
  if (walletIds.length === 0) return 0;

  // Current holdings per asset.
  const balance = new Map<string, bigint>();
  for (const b of db()
    .select()
    .from(schema.balances)
    .where(inArray(schema.balances.walletId, walletIds))
    .all()) {
    if (assets.has(b.assetId))
      balance.set(b.assetId, (balance.get(b.assetId) ?? 0n) + BigInt(b.amount));
  }

  // Deltas per day (movements + fees as negative native movements).
  const deltasByDay = new Map<number, Map<string, bigint>>();
  const add = (day: number, assetId: string, amount: bigint) => {
    if (!assets.has(assetId)) return;
    let m = deltasByDay.get(day);
    if (!m) deltasByDay.set(day, (m = new Map()));
    m.set(assetId, (m.get(assetId) ?? 0n) + amount);
  };
  const txs = db()
    .select({
      id: schema.transactions.id,
      network: schema.transactions.network,
      blockTime: schema.transactions.blockTime,
      fee: schema.transactions.fee,
    })
    .from(schema.transactions)
    .where(
      and(
        inArray(schema.transactions.walletId, walletIds),
        isNotNull(schema.transactions.blockTime),
        gt(schema.transactions.blockTime, startDay * DAY),
      ),
    )
    .all();
  const txDay = new Map(txs.map((t) => [t.id, Math.floor(t.blockTime! / DAY)]));
  for (const t of txs) if (t.fee) add(txDay.get(t.id)!, t.network, -BigInt(t.fee));
  for (let i = 0; i < txs.length; i += 500) {
    const ids = txs.slice(i, i + 500).map((t) => t.id);
    for (const m of db()
      .select()
      .from(schema.txMovements)
      .where(inArray(schema.txMovements.txId, ids))
      .all()) {
      add(txDay.get(m.txId)!, m.assetId, BigInt(m.amount));
    }
  }

  const prices = new Map<string, Map<number, number>>();
  for (const p of db()
    .select()
    .from(schema.priceDaily)
    .where(gt(schema.priceDaily.day, startDay - 1))
    .all()) {
    let m = prices.get(p.coingeckoId);
    if (!m) prices.set(p.coingeckoId, (m = new Map()));
    m.set(p.day, p.eur);
  }

  const rows: {
    ts: number;
    totalEur: number;
    byAsset: Record<string, number>;
    source: "backfill";
  }[] = [];
  // Walk back from today: balance at the end of day D = balance at end of D+1 minus D+1's deltas.
  for (let day = today; day >= startDay; day--) {
    if (day < today) {
      for (const [assetId, delta] of deltasByDay.get(day + 1) ?? []) {
        balance.set(assetId, (balance.get(assetId) ?? 0n) - delta);
      }
    }
    if (day === today) continue; // live snapshots cover today onwards
    let total = 0;
    let priced = false;
    const byAsset: Record<string, number> = {};
    for (const [assetId, amount] of balance) {
      if (amount <= 0n) continue;
      const a = assets.get(assetId)!;
      const eur = prices.get(a.coingeckoId!)?.get(day);
      if (eur === undefined) continue;
      priced = true;
      const value = unitsToNumber(amount, a.decimals) * eur;
      byAsset[assetId] = value;
      total += value;
    }
    if (priced) rows.push({ ts: day * DAY, totalEur: total, byAsset, source: "backfill" });
  }

  getHandle().sqlite.transaction(() => {
    db()
      .delete(schema.portfolioSnapshots)
      .where(eq(schema.portfolioSnapshots.source, "backfill"))
      .run();
    for (const r of rows) {
      if (r.ts >= firstLive) continue;
      db().insert(schema.portfolioSnapshots).values(r).onConflictDoNothing().run();
    }
  })();
  return rows.length;
}
