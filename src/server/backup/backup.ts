import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type Database from "better-sqlite3";

/**
 * Daily SQLite backups.
 *
 * - `VACUUM INTO` gives a consistent, compacted snapshot while the app runs.
 * - The snapshot is gzipped and, by default, encrypted with AES-256-GCM using
 *   a key derived (HKDF "backup") from DATASTREAM_ENC_KEY, so backups can be
 *   copied off-device without exposing wallet history.
 *   File format: "DSBK1" | iv (12) | ciphertext | tag (16).
 * - Retention keeps the newest `keepDaily` backups plus the newest backup of
 *   each of the last `keepWeekly` ISO weeks.
 */

const MAGIC = Buffer.from("DSBK1");
const NAME = /^datastream-(\d{4}-\d{2}-\d{2})T(\d{6})Z\.db\.gz(\.enc)?$/;

export function backupKey(master: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "datastream:backup", 32));
}

function stamp(d: Date) {
  const iso = d.toISOString(); // 2026-10-31T09:15:00.000Z
  return `${iso.slice(0, 10)}T${iso.slice(11, 19).replace(/:/g, "")}Z`;
}

export async function createBackup(
  sqlite: Database.Database,
  dir: string,
  opts: { key?: Buffer | undefined; now?: Date } = {},
): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = `datastream-${stamp(opts.now ?? new Date())}.db`;
  const raw = path.join(dir, `.${base}.tmp`);
  const final = path.join(dir, `${base}.gz${opts.key ? ".enc" : ""}`);
  const partial = `${final}.partial`;
  rmSync(raw, { force: true });

  try {
    sqlite.prepare("VACUUM INTO ?").run(raw);
    const out = createWriteStream(partial, { mode: 0o600 });
    if (opts.key) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", backupKey(opts.key), iv);
      out.write(Buffer.concat([MAGIC, iv]));
      await pipeline(createReadStream(raw), createGzip(), cipher, out, { end: false });
      await new Promise<void>((resolve, reject) =>
        out.end(cipher.getAuthTag(), () => resolve()).once("error", reject),
      );
    } else {
      await pipeline(createReadStream(raw), createGzip(), out);
    }
    // Atomic publish: a crash never leaves a truncated file that looks valid.
    await rename(partial, final);
    return final;
  } finally {
    rmSync(raw, { force: true });
    rmSync(partial, { force: true });
  }
}

/** Decrypts (if needed) and gunzips a backup to a plain SQLite file. */
export async function restoreBackup(file: string, dest: string, key?: Buffer) {
  if (file.endsWith(".enc")) {
    if (!key) throw new Error("This backup is encrypted: DATASTREAM_ENC_KEY is required");
    const data = await readFile(file);
    if (data.length < MAGIC.length + 12 + 16 || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("Not a Datastream backup");
    }
    const iv = data.subarray(MAGIC.length, MAGIC.length + 12);
    const tag = data.subarray(data.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", backupKey(key), iv);
    decipher.setAuthTag(tag);
    const gz = Buffer.concat([
      decipher.update(data.subarray(MAGIC.length + 12, data.length - 16)),
      decipher.final(),
    ]);
    const { gunzipSync } = await import("node:zlib");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(dest, gunzipSync(gz), { mode: 0o600 });
    return;
  }
  await pipeline(createReadStream(file), createGunzip(), createWriteStream(dest, { mode: 0o600 }));
}

function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

/** Returns the files to delete under the retention policy (newest first logic). */
export function selectForPruning(files: string[], keepDaily: number, keepWeekly: number): string[] {
  const backups = files
    .map((f) => ({ f, m: NAME.exec(path.basename(f)) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => !!x.m)
    .map(({ f, m }) => ({
      f,
      date: new Date(`${m[1]}T${m[2]!.slice(0, 2)}:${m[2]!.slice(2, 4)}:${m[2]!.slice(4, 6)}Z`),
    }))
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const keep = new Set<string>();
  // Newest backup per calendar day, for the last `keepDaily` days with backups.
  const days = new Set<string>();
  for (const b of backups) {
    const day = b.date.toISOString().slice(0, 10);
    if (days.has(day)) continue;
    if (days.size >= keepDaily) break;
    days.add(day);
    keep.add(b.f);
  }
  const weeks = new Set<string>();
  for (const b of backups) {
    const w = isoWeek(b.date);
    if (weeks.has(w)) continue;
    if (weeks.size >= keepWeekly) break;
    weeks.add(w);
    keep.add(b.f);
  }
  return backups.filter((b) => !keep.has(b.f)).map((b) => b.f);
}

export function pruneBackups(dir: string, keepDaily: number, keepWeekly: number): string[] {
  let files: string[];
  try {
    files = readdirSync(dir).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
  const doomed = selectForPruning(
    files.filter((f) => statSync(f).isFile()),
    keepDaily,
    keepWeekly,
  );
  for (const f of doomed) rmSync(f, { force: true });
  return doomed;
}
