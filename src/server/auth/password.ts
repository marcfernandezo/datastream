import { hash, verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db/client";

// Argon2id (the library default algorithm). 64 MiB / t=3 takes ~300 ms on a Pi 4.
const OPTIONS = { memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 } as const;
const KEY = "auth.passwordHash";

export const PASSWORD_MIN_LENGTH = 12;

export async function hashPassword(password: string) {
  return hash(password, OPTIONS);
}

export function getPasswordHash(): string | undefined {
  return db().select().from(schema.settings).where(eq(schema.settings.key, KEY)).get()?.value;
}

export function hasPassword(): boolean {
  return getPasswordHash() !== undefined;
}

export async function setPassword(password: string) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  const value = await hashPassword(password);
  db()
    .insert(schema.settings)
    .values({ key: KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } })
    .run();
}

// Verified against when no password is set, so timing doesn't reveal that state.
let dummyHash: Promise<string> | undefined;

export async function verifyPassword(password: string): Promise<boolean> {
  const stored = getPasswordHash();
  if (!stored) {
    dummyHash ??= hashPassword("datastream-dummy-password");
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}
