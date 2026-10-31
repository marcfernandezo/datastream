import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/env";
import { dispatchAlerts } from "@/server/alerts/service";
import { purgeExpiredSessions } from "@/server/auth/session";
import { getAdapter, isNetwork, sharedHttp } from "@/server/chains/registry";
import { SyncPendingError } from "@/server/chains/types";
import { db, getHandle, schema } from "@/server/db/client";
import { createBackup, pruneBackups } from "@/server/backup/backup";
import { keyring } from "@/server/crypto/keyring";
import { logger } from "@/server/log/logger";
import {
  backfillSnapshots,
  linkTokenAssets,
  refreshPriceHistory,
  refreshSpotPrices,
  refreshTokenMap,
  writeSnapshot,
} from "@/server/prices/service";
import { enqueueSync } from "@/server/wallets/service";
import { syncWallet } from "@/server/wallets/sync";
import { enqueue, pruneJobs, RetryLaterError } from "./queue";
import type { JobHandler, PeriodicTask } from "./runner";

export const handlers: Record<string, JobHandler> = {
  async "maintenance.cleanup"() {
    const sessions = purgeExpiredSessions();
    const jobs = pruneJobs();
    logger.info({ sessions, jobs }, "cleanup done");
  },

  async "wallet.syncAll"() {
    const wallets = db()
      .select({ id: schema.wallets.id })
      .from(schema.wallets)
      .where(eq(schema.wallets.archived, false))
      .all();
    // Stagger so providers see a trickle, not a burst.
    wallets.forEach((w, i) => enqueueSync(w.id, i * 5_000));
  },

  async "wallet.sync"(job, signal) {
    const walletId = String(job.payload.walletId ?? "");
    const wasInitial = !db()
      .select({ done: schema.wallets.initialSyncDone })
      .from(schema.wallets)
      .where(eq(schema.wallets.id, walletId))
      .get()?.done;
    let newTxIds: number[];
    try {
      ({ newTxIds } = await syncWallet(walletId, { http: sharedHttp(), signal }));
    } catch (err) {
      // syncWallet already recorded the progress note and adapter state.
      if (err instanceof SyncPendingError) throw new RetryLaterError(err.message, err.retryAfterMs);
      throw err;
    }
    if (newTxIds.length) enqueue("alerts.dispatch", { txIds: newTxIds });
    // Price new assets right away; a first sync also needs history + backfill.
    enqueue("prices.refresh", {}, { key: "prices.refresh" });
    if (wasInitial)
      enqueue("prices.daily", {}, { key: "prices.daily", runAfter: new Date(Date.now() + 10_000) });
  },

  /** After a wallet is deleted: let the adapter release provider-side data. */
  async "wallet.forget"(job, signal) {
    const payload = z
      .object({ network: z.string(), state: z.record(z.string(), z.unknown()) })
      .parse(job.payload);
    if (!isNetwork(payload.network)) return;
    const adapter = getAdapter(payload.network);
    await adapter.forget?.(
      { http: sharedHttp(), signal, log: logger.child({ job: "wallet.forget" }) },
      payload.state,
    );
  },

  async "maintenance.backup"() {
    const e = env();
    const now = new Date();
    // Runs hourly; acts once per UTC day, after BACKUP_HOUR_UTC.
    if (now.getUTCHours() < e.BACKUP_HOUR_UTC) return;
    const today = now.toISOString().slice(0, 10);
    const existing = existsSync(e.BACKUP_DIR) ? readdirSync(e.BACKUP_DIR) : [];
    if (existing.some((f) => f.startsWith(`datastream-${today}T`) && !f.endsWith(".partial")))
      return;
    const file = await createBackup(getHandle().sqlite, e.BACKUP_DIR, {
      key: e.BACKUP_ENCRYPT ? keyring().current : undefined,
      now,
    });
    const pruned = pruneBackups(e.BACKUP_DIR, e.BACKUP_KEEP_DAILY, e.BACKUP_KEEP_WEEKLY);
    logger.info({ file: path.basename(file), pruned: pruned.length }, "backup written");
  },

  async "alerts.dispatch"(job, signal) {
    const txIds = z
      .array(z.number().int())
      .max(10_000)
      .parse(job.payload.txIds ?? []);
    const result = await dispatchAlerts(txIds, signal);
    logger.info(result, "alerts dispatched");
  },

  async "prices.refresh"(_job, signal) {
    linkTokenAssets();
    const priced = await refreshSpotPrices(signal);
    const total = writeSnapshot();
    logger.debug({ priced, total: Math.round(total) }, "prices refreshed");
  },

  async "prices.daily"(_job, signal) {
    const fetched = await refreshPriceHistory(signal);
    const days = backfillSnapshots();
    logger.info({ fetched, days }, "price history refreshed");
  },

  async "prices.tokenMap"(_job, signal) {
    await refreshTokenMap(signal);
    enqueue("prices.refresh", {}, { key: "prices.refresh" });
  },
};

export function periodicTasks(): PeriodicTask[] {
  const e = env();
  return [
    { kind: "maintenance.cleanup", everyMs: 6 * 3_600_000 },
    { kind: "maintenance.backup", everyMs: 3_600_000 },
    { kind: "prices.tokenMap", everyMs: 24 * 3_600_000 },
    { kind: "wallet.syncAll", everyMs: e.SYNC_INTERVAL_MINUTES * 60_000 },
    { kind: "prices.refresh", everyMs: e.PRICE_INTERVAL_MINUTES * 60_000 },
    { kind: "prices.daily", everyMs: 6 * 3_600_000 },
  ];
}
