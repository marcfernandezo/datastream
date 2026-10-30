import { eq } from "drizzle-orm";
import { env } from "@/env";
import { purgeExpiredSessions } from "@/server/auth/session";
import { sharedHttp } from "@/server/chains/registry";
import { db, schema } from "@/server/db/client";
import { logger } from "@/server/log/logger";
import { enqueueSync } from "@/server/wallets/service";
import { syncWallet } from "@/server/wallets/sync";
import { pruneJobs } from "./queue";
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
    await syncWallet(walletId, { http: sharedHttp(), signal });
  },
};

export function periodicTasks(): PeriodicTask[] {
  const e = env();
  return [
    { kind: "maintenance.cleanup", everyMs: 6 * 3_600_000 },
    { kind: "wallet.syncAll", everyMs: e.SYNC_INTERVAL_MINUTES * 60_000 },
  ];
}
