import "server-only";
import {
  and,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  like,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getAdapter } from "@/server/chains/registry";
import { db, schema } from "@/server/db/client";
import { decryptSource } from "./sync";

export type WalletRow = typeof schema.wallets.$inferSelect;

export interface BalanceView {
  assetId: string;
  symbol: string;
  name: string;
  decimals: number;
  contract: string | null;
  coingeckoId: string | null;
  hidden: boolean | null;
  amount: string;
}

export function listWallets(opts: { includeArchived?: boolean } = {}) {
  const wallets = db()
    .select()
    .from(schema.wallets)
    .where(opts.includeArchived ? undefined : eq(schema.wallets.archived, false))
    .orderBy(schema.wallets.createdAt)
    .all();
  const pending = new Set(
    db()
      .select({ key: schema.jobs.key })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.kind, "wallet.sync"),
          inArray(schema.jobs.status, ["queued", "running"]),
        ),
      )
      .all()
      .map((j) => j.key),
  );
  return wallets.map((w) => ({
    ...w,
    syncing: pending.has(`sync:${w.id}`),
    balances: walletBalances(w.id),
  }));
}

export function walletBalances(walletId: string): BalanceView[] {
  return db()
    .select({
      assetId: schema.assets.id,
      symbol: schema.assets.symbol,
      name: schema.assets.name,
      decimals: schema.assets.decimals,
      contract: schema.assets.contract,
      coingeckoId: schema.assets.coingeckoId,
      hidden: schema.assets.hidden,
      amount: schema.balances.amount,
    })
    .from(schema.balances)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.balances.assetId))
    .where(eq(schema.balances.walletId, walletId))
    .all();
}

export function getWallet(id: string) {
  const wallet = db().select().from(schema.wallets).where(eq(schema.wallets.id, id)).get();
  if (!wallet) return null;
  const adapter = getAdapter(wallet.network);
  const source = decryptSource(wallet);
  const syncing = !!db()
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(eq(schema.jobs.key, `sync:${id}`), inArray(schema.jobs.status, ["queued", "running"])),
    )
    .get();
  return {
    wallet,
    syncing,
    /** Full source for the authenticated detail view only. */
    source: adapter.displaySource?.(source) ?? source.value,
    explorerAddressUrl:
      source.kind === "address" ? adapter.explorerUrl("address", source.value) : null,
    nativeAsset: adapter.nativeAsset,
  };
}

export const TX_PAGE_SIZE = 25;

export interface TxFilters {
  page: number;
  direction?: "in" | "out" | "self" | "swap" | undefined;
  assetId?: string | undefined;
  q?: string | undefined;
  from?: number | undefined; // unix seconds
  to?: number | undefined;
}

export function txWhere(walletIds: string[], f: Omit<TxFilters, "page">) {
  const conds: SQL[] = [inArray(schema.transactions.walletId, walletIds)];
  if (f.direction) conds.push(eq(schema.transactions.direction, f.direction));
  if (f.from) conds.push(gte(schema.transactions.blockTime, f.from));
  if (f.to) conds.push(lte(schema.transactions.blockTime, f.to));
  if (f.q) conds.push(like(schema.transactions.txid, `${f.q.replace(/[%_]/g, "")}%`));
  if (f.assetId) {
    conds.push(
      exists(
        db()
          .select({ one: sql`1` })
          .from(schema.txMovements)
          .where(
            and(
              eq(schema.txMovements.txId, schema.transactions.id),
              eq(schema.txMovements.assetId, f.assetId),
            ),
          ),
      ),
    );
  }
  return and(...conds);
}

export function listTransactions(walletIds: string[], f: TxFilters) {
  const where = txWhere(walletIds, f);
  const total = db().select({ n: count() }).from(schema.transactions).where(where).get()?.n ?? 0;
  const rows = db()
    .select()
    .from(schema.transactions)
    .where(where)
    // Pending first, then newest.
    .orderBy(
      sql`${schema.transactions.blockTime} IS NOT NULL`,
      desc(schema.transactions.blockTime),
      desc(schema.transactions.id),
    )
    .limit(TX_PAGE_SIZE)
    .offset((Math.max(1, f.page) - 1) * TX_PAGE_SIZE)
    .all();
  const movements = rows.length
    ? db()
        .select({
          txId: schema.txMovements.txId,
          amount: schema.txMovements.amount,
          assetId: schema.assets.id,
          symbol: schema.assets.symbol,
          decimals: schema.assets.decimals,
          coingeckoId: schema.assets.coingeckoId,
        })
        .from(schema.txMovements)
        .innerJoin(schema.assets, eq(schema.assets.id, schema.txMovements.assetId))
        .where(
          inArray(
            schema.txMovements.txId,
            rows.map((r) => r.id),
          ),
        )
        .all()
    : [];
  return {
    total,
    pages: Math.max(1, Math.ceil(total / TX_PAGE_SIZE)),
    rows: rows.map((r) => ({ ...r, movements: movements.filter((m) => m.txId === r.id) })),
  };
}

export function walletAssets(walletIds: string[]) {
  return db()
    .selectDistinct({ id: schema.assets.id, symbol: schema.assets.symbol })
    .from(schema.txMovements)
    .innerJoin(schema.transactions, eq(schema.transactions.id, schema.txMovements.txId))
    .innerJoin(schema.assets, eq(schema.assets.id, schema.txMovements.assetId))
    .where(or(inArray(schema.transactions.walletId, walletIds)))
    .orderBy(schema.assets.symbol)
    .all();
}
