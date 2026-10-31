import { and, eq, inArray, lt } from "drizzle-orm";
import { getAdapter } from "@/server/chains/registry";
import {
  SyncPendingError,
  type AssetAmount,
  type AssetInfo,
  type NormalizedTx,
  type WalletSource,
} from "@/server/chains/types";
import { AAD, open } from "@/server/crypto/keyring";
import { db, getHandle, schema } from "@/server/db/client";
import type { HttpClient } from "@/server/http/client";
import { maskSensitive } from "@/server/log/mask";
import { logger } from "@/server/log/logger";

const INITIAL_MAX_PAGES = 40;
const INCREMENTAL_MAX_PAGES = 5;
/** Pending txs not seen again after this long are considered dropped/replaced. */
const DROPPED_AFTER_MS = 24 * 3_600_000;

export interface SyncResult {
  /** New tx row ids, only populated after the wallet's initial sync. */
  newTxIds: number[];
  txCount: number;
}

export function decryptSource(wallet: typeof schema.wallets.$inferSelect): WalletSource {
  return {
    kind: wallet.sourceKind,
    value: open(wallet.sourceEnc, AAD.walletSource),
    options: wallet.options,
  };
}

function upsertAssets(assets: AssetInfo[]) {
  for (const a of assets) {
    db()
      .insert(schema.assets)
      .values({
        id: a.id,
        network: a.network,
        contract: a.contract,
        symbol: a.symbol,
        name: a.name,
        decimals: a.decimals,
        coingeckoId: a.coingeckoId,
      })
      .onConflictDoNothing()
      .run();
  }
}

export async function syncWallet(
  walletId: string,
  deps: { http: HttpClient; signal: AbortSignal },
): Promise<SyncResult> {
  const wallet = db().select().from(schema.wallets).where(eq(schema.wallets.id, walletId)).get();
  if (!wallet || wallet.archived) return { newTxIds: [], txCount: 0 };

  const log = logger.child({ walletId, network: wallet.network });
  const adapter = getAdapter(wallet.network);
  const ctx = {
    http: deps.http,
    signal: deps.signal,
    log,
    state: structuredClone(wallet.syncState),
    memo: new Map<string, unknown>(),
  };

  const knownRows = db()
    .select({ txid: schema.transactions.txid, status: schema.transactions.status })
    .from(schema.transactions)
    .where(eq(schema.transactions.walletId, walletId))
    .all();
  const knownTxids = new Set(knownRows.filter((r) => r.status !== "pending").map((r) => r.txid));

  const started = Date.now();
  let txs: NormalizedTx[];
  let balances: AssetAmount[];
  try {
    const source = decryptSource(wallet);
    // History first: some adapters learn token contracts from it.
    txs = await adapter.getTransactions(ctx, source, {
      knownTxids,
      maxPages: wallet.initialSyncDone
        ? INCREMENTAL_MAX_PAGES
        : (adapter.initialMaxPages ?? INITIAL_MAX_PAGES),
    });
    balances = [
      ...(await adapter.getBalance(ctx, source)),
      ...(await adapter.getTokens(ctx, source)),
    ];
  } catch (err) {
    const message = maskSensitive(err instanceof Error ? err.message : String(err)).slice(0, 300);
    if (err instanceof SyncPendingError) {
      // Nothing partial is stored; only progress and the adapter's state
      // (which may hold a provider-side id that deletion must release).
      db()
        .update(schema.wallets)
        .set({ syncNote: message, lastSyncError: null, syncState: ctx.state })
        .where(eq(schema.wallets.id, walletId))
        .run();
      log.debug({ note: message }, "wallet sync pending");
      throw err;
    }
    db()
      .update(schema.wallets)
      .set({ lastSyncError: message, syncNote: null })
      .where(eq(schema.wallets.id, walletId))
      .run();
    throw err;
  }

  const result = persist(wallet, txs, balances, ctx.state);
  log.info(
    { ms: Date.now() - started, txs: txs.length, new: result.newTxIds.length },
    "wallet synced",
  );
  return result;
}

function persist(
  wallet: typeof schema.wallets.$inferSelect,
  txs: NormalizedTx[],
  balances: AssetAmount[],
  state: Record<string, unknown>,
): SyncResult {
  const now = new Date();
  const notifyNew = wallet.initialSyncDone;
  const newTxIds: number[] = [];

  getHandle().sqlite.transaction(() => {
    upsertAssets([
      ...balances.map((b) => b.asset),
      ...txs.flatMap((t) => t.movements.map((m) => m.asset)),
    ]);

    db().delete(schema.balances).where(eq(schema.balances.walletId, wallet.id)).run();
    for (const b of balances) {
      if (b.amount === 0n && b.asset.contract) continue;
      db()
        .insert(schema.balances)
        .values({
          walletId: wallet.id,
          assetId: b.asset.id,
          amount: b.amount.toString(),
          updatedAt: now,
        })
        .run();
    }

    const fetched = new Set<string>();
    for (const tx of txs) {
      fetched.add(tx.txid);
      const direction = directionOf(tx);
      const existing = db()
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(
          and(eq(schema.transactions.walletId, wallet.id), eq(schema.transactions.txid, tx.txid)),
        )
        .get();

      let rowId: number;
      if (existing) {
        rowId = existing.id;
        db()
          .update(schema.transactions)
          .set({
            blockTime: tx.blockTime,
            blockHeight: tx.blockHeight,
            status: tx.status,
            direction,
            fee: tx.fee?.toString() ?? null,
          })
          .where(eq(schema.transactions.id, rowId))
          .run();
        db().delete(schema.txMovements).where(eq(schema.txMovements.txId, rowId)).run();
      } else {
        rowId = db()
          .insert(schema.transactions)
          .values({
            walletId: wallet.id,
            network: wallet.network,
            txid: tx.txid,
            blockTime: tx.blockTime,
            blockHeight: tx.blockHeight,
            status: tx.status,
            direction,
            fee: tx.fee?.toString() ?? null,
            firstSeenAt: now,
          })
          .returning({ id: schema.transactions.id })
          .get().id;
        if (notifyNew && tx.status !== "failed") newTxIds.push(rowId);
      }
      for (const m of tx.movements) {
        db()
          .insert(schema.txMovements)
          .values({ txId: rowId, assetId: m.asset.id, amount: m.amount.toString() })
          .run();
      }
    }

    // Pending txs that vanished (RBF-replaced or dropped) are marked failed.
    const stale = db()
      .select({ id: schema.transactions.id, txid: schema.transactions.txid })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.walletId, wallet.id),
          eq(schema.transactions.status, "pending"),
          lt(schema.transactions.firstSeenAt, new Date(now.getTime() - DROPPED_AFTER_MS)),
        ),
      )
      .all()
      .filter((r) => !fetched.has(r.txid));
    if (stale.length) {
      db()
        .update(schema.transactions)
        .set({ status: "failed" })
        .where(
          inArray(
            schema.transactions.id,
            stale.map((r) => r.id),
          ),
        )
        .run();
    }

    db()
      .update(schema.wallets)
      .set({
        syncState: state,
        lastSyncedAt: now,
        lastSyncError: null,
        syncNote: null,
        initialSyncDone: true,
      })
      .where(eq(schema.wallets.id, wallet.id))
      .run();
  })();

  return { newTxIds, txCount: txs.length };
}

export function directionOf(tx: NormalizedTx): "in" | "out" | "self" | "swap" {
  const hasIn = tx.movements.some((m) => m.amount > 0n);
  const hasOut = tx.movements.some((m) => m.amount < 0n);
  if (hasIn && hasOut) return "swap";
  if (hasIn) return "in";
  if (hasOut) return "out";
  // Fee-only: consolidation, approval, contract call.
  return "self";
}
