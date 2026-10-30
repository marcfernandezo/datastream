import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db, getHandle, schema } from "@/server/db/client";

/**
 * Minimal durable job queue on SQLite. The web process only enqueues; the
 * worker claims and runs. Claiming happens inside a write transaction, so
 * two workers could never take the same job.
 */

export type Job = typeof schema.jobs.$inferSelect;

const MAX_ATTEMPTS = 5;

export function enqueue(
  kind: string,
  payload: Record<string, unknown> = {},
  opts: { key?: string; runAfter?: Date } = {},
): number | null {
  const { sqlite } = getHandle();
  return sqlite
    .transaction(() => {
      if (opts.key) {
        const existing = db()
          .select({ id: schema.jobs.id })
          .from(schema.jobs)
          .where(
            and(eq(schema.jobs.key, opts.key), inArray(schema.jobs.status, ["queued", "running"])),
          )
          .get();
        if (existing) return null;
      }
      const row = db()
        .insert(schema.jobs)
        .values({ kind, key: opts.key ?? null, payload, runAfter: opts.runAfter ?? new Date() })
        .returning({ id: schema.jobs.id })
        .get();
      return row.id;
    })
    .immediate();
}

export function claimNext(now = new Date()): Job | null {
  const { sqlite } = getHandle();
  return sqlite
    .transaction(() => {
      const job = db()
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.status, "queued"), lte(schema.jobs.runAfter, now)))
        .orderBy(asc(schema.jobs.runAfter), asc(schema.jobs.id))
        .limit(1)
        .get();
      if (!job) return null;
      db()
        .update(schema.jobs)
        .set({ status: "running", startedAt: now, attempts: sql`${schema.jobs.attempts} + 1` })
        .where(eq(schema.jobs.id, job.id))
        .run();
      return { ...job, status: "running" as const, attempts: job.attempts + 1, startedAt: now };
    })
    .immediate();
}

export function complete(id: number) {
  db()
    .update(schema.jobs)
    .set({ status: "done", finishedAt: new Date(), error: null })
    .where(eq(schema.jobs.id, id))
    .run();
}

/** Retries with exponential backoff (30s, 1m, 2m, 4m) until MAX_ATTEMPTS. */
export function fail(job: Job, error: string) {
  const retry = job.attempts < MAX_ATTEMPTS;
  db()
    .update(schema.jobs)
    .set(
      retry
        ? {
            status: "queued",
            error,
            runAfter: new Date(Date.now() + 30_000 * 2 ** (job.attempts - 1)),
          }
        : { status: "failed", error, finishedAt: new Date() },
    )
    .where(eq(schema.jobs.id, job.id))
    .run();
  return retry;
}

/** On worker start: anything left "running" was interrupted. */
export function requeueInterrupted() {
  return db()
    .update(schema.jobs)
    .set({ status: "queued" })
    .where(eq(schema.jobs.status, "running"))
    .run().changes;
}

/** Keep the table small: drop finished jobs older than a week. */
export function pruneJobs(olderThanMs = 7 * 24 * 3_600_000) {
  return db()
    .delete(schema.jobs)
    .where(
      and(
        inArray(schema.jobs.status, ["done", "failed"]),
        lte(schema.jobs.createdAt, new Date(Date.now() - olderThanMs)),
      ),
    )
    .run().changes;
}
