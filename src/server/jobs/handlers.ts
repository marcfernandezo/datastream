import { purgeExpiredSessions } from "@/server/auth/session";
import { logger } from "@/server/log/logger";
import { pruneJobs } from "./queue";
import type { JobHandler, PeriodicTask } from "./runner";

export const handlers: Record<string, JobHandler> = {
  async "maintenance.cleanup"() {
    const sessions = purgeExpiredSessions();
    const jobs = pruneJobs();
    logger.info({ sessions, jobs }, "cleanup done");
  },
};

export function periodicTasks(): PeriodicTask[] {
  return [{ kind: "maintenance.cleanup", everyMs: 6 * 3_600_000 }];
}
