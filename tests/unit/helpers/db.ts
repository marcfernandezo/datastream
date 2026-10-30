import { openDatabase, runMigrations, setHandleForTests } from "@/server/db/client";

/** Fresh in-memory database with all migrations applied, installed as the global handle. */
export function useTestDb() {
  const handle = openDatabase(":memory:");
  runMigrations(handle.db);
  setHandleForTests(handle);
  return handle;
}
