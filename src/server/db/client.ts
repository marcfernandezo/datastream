import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema>;

interface Handle {
  sqlite: Database.Database;
  db: DB;
}

// Survive Next dev HMR without leaking connections.
const g = globalThis as unknown as { __datastreamDb?: Handle };

export function openDatabase(file: string): Handle {
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

export function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");
}

export function runMigrations(db: DB) {
  migrate(db, { migrationsFolder: migrationsDir() });
}

export function getHandle(): Handle {
  if (!g.__datastreamDb) {
    g.__datastreamDb = openDatabase(process.env.DATABASE_PATH ?? "./data/datastream.db");
  }
  return g.__datastreamDb;
}

export function db(): DB {
  return getHandle().db;
}

/** Test helper: swap in an isolated database. */
export function setHandleForTests(handle: Handle | undefined) {
  g.__datastreamDb = handle;
}

export { schema };
