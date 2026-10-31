import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreBackup, selectForPruning } from "@/server/backup/backup";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "ds-backup-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sourceDb(dir: string) {
  const db = new Database(path.join(dir, "src.db"));
  db.exec("create table t (v text); insert into t values ('bc1q-secret-history');");
  return db;
}

describe("backups", () => {
  const key = Buffer.alloc(32, 3);

  it("round-trips an encrypted backup and hides its contents", async () => {
    const dir = tmp();
    const db = sourceDb(dir);
    const file = await createBackup(db, path.join(dir, "backups"), {
      key,
      now: new Date("2026-10-31T03:05:09Z"),
    });
    expect(path.basename(file)).toBe("datastream-2026-10-31T030509Z.db.gz.enc");
    expect(readFileSync(file).includes(Buffer.from("bc1q-secret-history"))).toBe(false);
    expect(readdirSync(path.join(dir, "backups"))).toEqual([path.basename(file)]);

    const dest = path.join(dir, "restored.db");
    await restoreBackup(file, dest, key);
    const restored = new Database(dest, { readonly: true });
    expect(restored.prepare("select v from t").get()).toEqual({ v: "bc1q-secret-history" });
  });

  it("rejects the wrong key and tampered files", async () => {
    const dir = tmp();
    const file = await createBackup(sourceDb(dir), dir, { key });
    await expect(
      restoreBackup(file, path.join(dir, "a.db"), Buffer.alloc(32, 4)),
    ).rejects.toThrow();
    const bytes = readFileSync(file);
    bytes[bytes.length - 20]! ^= 0xff;
    writeFileSync(file, bytes);
    await expect(restoreBackup(file, path.join(dir, "b.db"), key)).rejects.toThrow();
    await expect(restoreBackup(file, path.join(dir, "c.db"))).rejects.toThrow(/DATASTREAM_ENC_KEY/);
  });

  it("supports unencrypted backups", async () => {
    const dir = tmp();
    const file = await createBackup(sourceDb(dir), dir, {});
    expect(file.endsWith(".db.gz")).toBe(true);
    const dest = path.join(dir, "plain.db");
    await restoreBackup(file, dest);
    expect(new Database(dest).prepare("select count(*) n from t").get()).toEqual({ n: 1 });
  });
});

describe("retention", () => {
  const name = (d: string) => `/b/datastream-${d}T030000Z.db.gz.enc`;

  it("keeps the newest N daily and one per week for M weeks", () => {
    // 60 consecutive daily backups ending Sat 2026-10-31.
    const files = Array.from({ length: 60 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 9, 31) - i * 86_400_000);
      return name(d.toISOString().slice(0, 10));
    });
    const doomed = new Set(selectForPruning([...files, "/b/unrelated.txt"], 7, 4));
    const kept = files.filter((f) => !doomed.has(f));
    // Dailies: Oct 25–31. Weeklies (newest per ISO week): Oct 31, 25, 18, 11.
    const expected = ["31", "30", "29", "28", "27", "26", "25", "18", "11"].map((d) =>
      name(`2026-10-${d}`),
    );
    expect(kept).toEqual(expected);
    expect(doomed.has("/b/unrelated.txt")).toBe(false);
  });
});
