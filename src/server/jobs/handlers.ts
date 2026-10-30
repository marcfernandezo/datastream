import { eq } from "drizzle-orm";
import { env } from "@/env";
import { purgeExpiredSessions } from "@/server/auth/session";
import { sharedHttp } from "@/server/chains/registry";
import { db, schema } from "@/server/db/client";
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
import { enqueue, pruneJobs } from "./queue";
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
    await syncWallet(walletId, { http: sharedHttp(), signal });
    // Price new assets right away; a first sync also needs history + backfill.
    enqueue("prices.refresh", {}, { key: "prices.refresh" });
    if (wasInitial)
      enqueue("prices.daily", {}, { key: "prices.daily", runAfter: new Date(Date.now() + 10_000) });
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
    { kind: "prices.tokenMap", everyMs: 24 * 3_600_000 },
    { kind: "wallet.syncAll", everyMs: e.SYNC_INTERVAL_MINUTES * 60_000 },
    { kind: "prices.refresh", everyMs: e.PRICE_INTERVAL_MINUTES * 60_000 },
    { kind: "prices.daily", everyMs: 6 * 3_600_000 },
  ];
}
