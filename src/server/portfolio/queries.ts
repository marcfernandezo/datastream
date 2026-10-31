import "server-only";
import { and, asc, eq, gte, inArray, lte, max } from "drizzle-orm";
import { db, schema } from "@/server/db/client";
import { unitsToNumber } from "@/lib/format";

const DAY = 86_400;

export interface Holding {
  assetId: string;
  network: string;
  symbol: string;
  name: string;
  decimals: number;
  coingeckoId: string | null;
  amount: bigint;
  price: number | null;
  change24h: number | null;
  value: number | null;
  /** Stable color slot, assigned by asset creation order (never by rank). */
  colorSlot: number;
}

export function isVisible(a: {
  contract: string | null;
  coingeckoId: string | null;
  hidden: boolean | null;
}) {
  if (a.hidden !== null) return !a.hidden;
  // Auto: native assets always; tokens only when CoinGecko knows them (spam filter).
  return a.contract === null || a.coingeckoId !== null;
}

/** Aggregated holdings across the given (or all active) wallets, most valuable first. */
export function getHoldings(walletIds?: string[]): Holding[] {
  const ids =
    walletIds ??
    db()
      .select({ id: schema.wallets.id })
      .from(schema.wallets)
      .where(eq(schema.wallets.archived, false))
      .all()
      .map((w) => w.id);
  if (ids.length === 0) return [];

  const rows = db()
    .select({
      assetId: schema.assets.id,
      network: schema.assets.network,
      symbol: schema.assets.symbol,
      name: schema.assets.name,
      decimals: schema.assets.decimals,
      contract: schema.assets.contract,
      coingeckoId: schema.assets.coingeckoId,
      hidden: schema.assets.hidden,
      createdAt: schema.assets.createdAt,
      amount: schema.balances.amount,
      price: schema.priceSpot.eur,
      change24h: schema.priceSpot.change24h,
    })
    .from(schema.balances)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.balances.assetId))
    .leftJoin(schema.priceSpot, eq(schema.priceSpot.coingeckoId, schema.assets.coingeckoId))
    .where(inArray(schema.balances.walletId, ids))
    .all();

  const slotOrder = db()
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .orderBy(asc(schema.assets.createdAt), asc(schema.assets.id))
    .all()
    .map((a) => a.id);

  const byAsset = new Map<string, Holding>();
  for (const r of rows) {
    if (!isVisible(r)) continue;
    const h = byAsset.get(r.assetId);
    if (h) {
      h.amount += BigInt(r.amount);
      continue;
    }
    byAsset.set(r.assetId, {
      assetId: r.assetId,
      network: r.network,
      symbol: r.symbol,
      name: r.name,
      decimals: r.decimals,
      coingeckoId: r.coingeckoId,
      amount: BigInt(r.amount),
      price: r.price,
      change24h: r.change24h,
      value: null,
      colorSlot: slotOrder.indexOf(r.assetId),
    });
  }
  const holdings = [...byAsset.values()].filter((h) => h.amount > 0n);
  for (const h of holdings)
    h.value = h.price === null ? null : unitsToNumber(h.amount, h.decimals) * h.price;
  return holdings.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
}

export function pricesUpdatedAt(): Date | null {
  return (
    db()
      .select({ t: max(schema.priceSpot.updatedAt) })
      .from(schema.priceSpot)
      .get()?.t ?? null
  );
}

export interface Change {
  /** Absolute EUR change of current holdings' value. */
  eur: number;
  pct: number;
}

/**
 * Change in value of the *current* holdings over a period (price
 * performance, excluding deposits/withdrawals). 24h uses CoinGecko's change;
 * 7d/30d use stored daily closes.
 */
export function holdingsChange(holdings: Holding[], days: 1 | 7 | 30): Change | null {
  let now = 0;
  let then = 0;
  const thenDay = Math.floor(Date.now() / 1000 / DAY) - days;
  const ids = holdings.map((h) => h.coingeckoId).filter((id): id is string => !!id);
  const past =
    days === 1 || ids.length === 0
      ? new Map<string, number>()
      : new Map(
          db()
            .select({ id: schema.priceDaily.coingeckoId, eur: schema.priceDaily.eur })
            .from(schema.priceDaily)
            .where(
              and(inArray(schema.priceDaily.coingeckoId, ids), eq(schema.priceDaily.day, thenDay)),
            )
            .all()
            .map((r) => [r.id, r.eur]),
        );
  for (const h of holdings) {
    if (h.value === null || h.price === null) continue;
    let pastPrice: number | undefined;
    if (days === 1)
      pastPrice = h.change24h === null ? undefined : h.price / (1 + h.change24h / 100);
    else pastPrice = h.coingeckoId ? past.get(h.coingeckoId) : undefined;
    if (pastPrice === undefined) continue;
    now += h.value;
    then += unitsToNumber(h.amount, h.decimals) * pastPrice;
  }
  if (then === 0) return null;
  return { eur: now - then, pct: ((now - then) / then) * 100 };
}

export const RANGES = { "7d": 7, "30d": 30, "90d": 90, "1y": 365, all: null } as const;
export type RangeKey = keyof typeof RANGES;

/** Portfolio value series. Hourly within 30 days; one point per day beyond. */
export function performanceSeries(range: RangeKey): { ts: number; value: number }[] {
  const days = RANGES[range];
  const from = days === null ? 0 : Math.floor(Date.now() / 1000) - days * DAY;
  const rows = db()
    .select({ ts: schema.portfolioSnapshots.ts, value: schema.portfolioSnapshots.totalEur })
    .from(schema.portfolioSnapshots)
    .where(
      and(
        gte(schema.portfolioSnapshots.ts, from),
        lte(schema.portfolioSnapshots.ts, Math.floor(Date.now() / 1000)),
      ),
    )
    .orderBy(asc(schema.portfolioSnapshots.ts))
    .all();
  if (days !== null && days <= 30) return rows;
  // Downsample to the last point of each day.
  const daily = new Map<number, { ts: number; value: number }>();
  for (const r of rows) daily.set(Math.floor(r.ts / DAY), r);
  return [...daily.values()];
}

/** Value per wallet, using the same visibility and price rules as the overview. */
export function walletValues(): Map<string, number> {
  const out = new Map<string, number>();
  const wallets = db().select({ id: schema.wallets.id }).from(schema.wallets).all();
  for (const w of wallets) {
    const total = getHoldings([w.id]).reduce((sum, h) => sum + (h.value ?? 0), 0);
    out.set(w.id, total);
  }
  return out;
}

/** EUR price per (coin, day), for valuing historical transactions. */
export function dailyPriceLookup(coinIds: string[], days: number[]) {
  const map = new Map<string, number>();
  if (coinIds.length === 0 || days.length === 0) return map;
  const rows = db()
    .select()
    .from(schema.priceDaily)
    .where(
      and(inArray(schema.priceDaily.coingeckoId, coinIds), inArray(schema.priceDaily.day, days)),
    )
    .all();
  for (const r of rows) map.set(`${r.coingeckoId}:${r.day}`, r.eur);
  return map;
}

export function spotPrices(coinIds: string[]) {
  if (coinIds.length === 0) return new Map<string, number>();
  return new Map(
    db()
      .select({ id: schema.priceSpot.coingeckoId, eur: schema.priceSpot.eur })
      .from(schema.priceSpot)
      .where(inArray(schema.priceSpot.coingeckoId, coinIds))
      .all()
      .map((r) => [r.id, r.eur]),
  );
}

/**
 * EUR value of each tx's movements at the time it happened (daily close),
 * falling back to the spot price for pending/today's txs.
 */
export function txEurValues(
  rows: {
    id: number;
    blockTime: number | null;
    movements: { amount: string; decimals: number; coingeckoId: string | null }[];
  }[],
) {
  const coinIds = [
    ...new Set(
      rows.flatMap((r) => r.movements.map((m) => m.coingeckoId).filter((id): id is string => !!id)),
    ),
  ];
  const days = [
    ...new Set(
      rows.map((r) => (r.blockTime ? Math.floor(r.blockTime / DAY) : -1)).filter((d) => d >= 0),
    ),
  ];
  const daily = dailyPriceLookup(coinIds, days);
  const spot = spotPrices(coinIds);
  const out = new Map<number, number | null>();
  for (const r of rows) {
    let total = 0;
    let priced = false;
    for (const m of r.movements) {
      if (!m.coingeckoId) continue;
      const day = r.blockTime ? Math.floor(r.blockTime / DAY) : null;
      const price =
        (day !== null ? daily.get(`${m.coingeckoId}:${day}`) : undefined) ??
        spot.get(m.coingeckoId);
      if (price === undefined) continue;
      priced = true;
      total += unitsToNumber(m.amount, m.decimals) * price;
    }
    out.set(r.id, priced ? total : null);
  }
  return out;
}
