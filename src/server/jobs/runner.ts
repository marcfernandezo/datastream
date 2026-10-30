import { logger } from "@/server/log/logger";
import { claimNext, complete, enqueue, fail, type Job } from "./queue";

export type JobHandler = (job: Job, signal: AbortSignal) => Promise<void>;

export interface PeriodicTask {
  kind: string;
  everyMs: number;
  payload?: Record<string, unknown>;
}

interface RunnerOptions {
  handlers: Record<string, JobHandler>;
  periodic: PeriodicTask[];
  concurrency?: number;
  pollMs?: number;
}

export function startRunner({
  handlers,
  periodic,
  concurrency = 2,
  pollMs = 2_000,
}: RunnerOptions) {
  const controller = new AbortController();
  const lastScheduled = new Map<string, number>();
  const inFlight = new Set<Promise<void>>();
  let timer: NodeJS.Timeout | undefined;

  function schedulePeriodic(now: number) {
    for (const task of periodic) {
      const last = lastScheduled.get(task.kind) ?? 0;
      if (now - last >= task.everyMs) {
        enqueue(task.kind, task.payload ?? {}, { key: `periodic:${task.kind}` });
        lastScheduled.set(task.kind, now);
      }
    }
  }

  async function run(job: Job) {
    const log = logger.child({ job: job.kind, jobId: job.id, attempt: job.attempts });
    const handler = handlers[job.kind];
    if (!handler) {
      fail({ ...job, attempts: Number.MAX_SAFE_INTEGER }, `no handler for ${job.kind}`);
      log.error("no handler registered");
      return;
    }
    const started = Date.now();
    try {
      await handler(job, controller.signal);
      complete(job.id);
      log.debug({ ms: Date.now() - started }, "job done");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retrying = fail(job, message.slice(0, 1000));
      log.warn({ err, retrying }, "job failed");
    }
  }

  function tick() {
    if (controller.signal.aborted) return;
    try {
      schedulePeriodic(Date.now());
      while (inFlight.size < concurrency) {
        const job = claimNext();
        if (!job) break;
        const p = run(job).finally(() => {
          inFlight.delete(p);
          // A slot freed up: look for more work right away.
          if (!controller.signal.aborted) setImmediate(tick);
        });
        inFlight.add(p);
      }
    } catch (err) {
      logger.error({ err }, "runner tick failed");
    }
  }

  tick();
  timer = setInterval(tick, pollMs);

  return {
    async stop(timeoutMs = 15_000) {
      clearInterval(timer);
      timer = undefined;
      controller.abort();
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((r) => setTimeout(r, timeoutMs)),
      ]);
    },
  };
}
