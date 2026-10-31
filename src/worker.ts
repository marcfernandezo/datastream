import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "@/env";
import { getHandle, runMigrations } from "@/server/db/client";
import { handlers, periodicTasks } from "@/server/jobs/handlers";
import { requeueInterrupted } from "@/server/jobs/queue";
import { startRunner } from "@/server/jobs/runner";
import { logger } from "@/server/log/logger";

async function main() {
  env(); // fail fast on bad config
  const { db, sqlite } = getHandle();
  runMigrations(db);
  const requeued = requeueInterrupted();
  const runner = startRunner({ handlers, periodic: periodicTasks() });
  logger.info({ requeued }, "datastream worker started");

  // Heartbeat for the container healthcheck (see compose.yml).
  const heartbeat = path.join(tmpdir(), "datastream-worker.alive");
  const beat = () => writeFileSync(heartbeat, String(Date.now()));
  beat();
  const beatTimer = setInterval(beat, 15_000);
  beatTimer.unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker shutting down");
    await runner.stop();
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
