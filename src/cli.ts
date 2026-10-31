/**
 * `pnpm ds <command>` — operational commands run on the server.
 *
 *   gen-key          print a new random 32-byte encryption key (base64)
 *   set-password     set or reset the login password (prompts, or DS_PASSWORD)
 *   revoke-sessions  sign out every session
 *   rotate-key       re-encrypt secrets with DATASTREAM_ENC_KEY, reading old
 *                    ones with DATASTREAM_ENC_KEY_PREVIOUS
 *   migrate          apply database migrations
 *   backup           write a backup now (same as the daily job)
 *   restore-backup <file> <dest.db>
 *                    decrypt/unpack a backup into a SQLite file; stop the app,
 *                    then replace DATABASE_PATH with it
 */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

async function promptHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

async function withDb() {
  const { getHandle, runMigrations } = await import("@/server/db/client");
  const handle = getHandle();
  runMigrations(handle.db);
  return handle;
}

const commands: Record<string, () => Promise<void>> = {
  async "gen-key"() {
    console.log(randomBytes(32).toString("base64"));
  },

  async migrate() {
    await withDb();
    console.log("Migrations applied.");
  },

  async "set-password"() {
    await withDb();
    const { setPassword, PASSWORD_MIN_LENGTH } = await import("@/server/auth/password");
    const { deleteAllSessions } = await import("@/server/auth/session");
    let password = process.env.DS_PASSWORD;
    if (!password) {
      password = await promptHidden(`New password (min ${PASSWORD_MIN_LENGTH} chars): `);
      const confirm = await promptHidden("Confirm: ");
      if (password !== confirm) throw new Error("Passwords do not match");
    }
    await setPassword(password);
    deleteAllSessions();
    console.log("Password set. All existing sessions were signed out.");
  },

  async "revoke-sessions"() {
    await withDb();
    const { deleteAllSessions } = await import("@/server/auth/session");
    deleteAllSessions();
    console.log("All sessions revoked.");
  },

  async backup() {
    const { sqlite } = await withDb();
    const { env } = await import("@/env");
    const { keyring } = await import("@/server/crypto/keyring");
    const { createBackup, pruneBackups } = await import("@/server/backup/backup");
    const e = env();
    const file = await createBackup(sqlite, e.BACKUP_DIR, {
      key: e.BACKUP_ENCRYPT ? keyring().current : undefined,
    });
    pruneBackups(e.BACKUP_DIR, e.BACKUP_KEEP_DAILY, e.BACKUP_KEEP_WEEKLY);
    console.log(`Backup written: ${file}`);
  },

  async "restore-backup"() {
    const [file, dest] = process.argv.slice(3);
    if (!file || !dest) throw new Error("Usage: ds restore-backup <backup-file> <dest.db>");
    const { existsSync } = await import("node:fs");
    if (existsSync(dest)) throw new Error(`${dest} already exists; refusing to overwrite`);
    const { restoreBackup } = await import("@/server/backup/backup");
    const { parseKey } = await import("@/server/crypto/envelope");
    const raw = process.env.DATASTREAM_ENC_KEY;
    const old = process.env.DATASTREAM_ENC_KEY_PREVIOUS;
    try {
      await restoreBackup(file, dest, raw ? parseKey(raw) : undefined);
    } catch (err) {
      // Backups made before a key rotation need the previous key.
      if (!old) throw err;
      await restoreBackup(file, dest, parseKey(old));
    }
    console.log(`Restored to ${dest}. Stop Datastream, then move it to DATABASE_PATH.`);
  },

  async "rotate-key"() {
    const { sqlite } = await withDb();
    const { rotateKeys } = await import("@/server/crypto/rotate");
    const result = sqlite.transaction(() => rotateKeys())();
    console.log(
      `Re-encrypted ${result.wallets} wallet(s) and ${result.channels} alert channel(s).`,
    );
    console.log("You can now remove DATASTREAM_ENC_KEY_PREVIOUS.");
  },
};

async function main() {
  const name = process.argv[2];
  const command = name ? commands[name] : undefined;
  if (!command) {
    console.error(`Usage: ds <${Object.keys(commands).join("|")}>`);
    process.exit(name ? 1 : 0);
  }
  await command();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
