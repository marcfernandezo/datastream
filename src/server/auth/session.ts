import { createHash, randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { db, schema } from "@/server/db/client";

const BUMP_INTERVAL_MS = 60_000;

export interface SessionConfig {
  ttlMs: number;
  idleMs: number;
}

export interface SessionInfo {
  id: string;
  expiresAt: Date;
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function createSession(cfg: SessionConfig, userAgent: string | null) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = new Date(now + cfg.ttlMs);
  db()
    .insert(schema.sessions)
    .values({
      id: hashToken(token),
      lastSeenAt: new Date(now),
      expiresAt,
      userAgent: userAgent?.slice(0, 200) ?? null,
    })
    .run();
  return { token, expiresAt };
}

/** Validates the token, enforcing absolute and idle expiry, and slides lastSeenAt. */
export function validateSession(cfg: SessionConfig, token: string | undefined): SessionInfo | null {
  if (!token || token.length > 100) return null;
  const id = hashToken(token);
  const row = db().select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt.getTime() <= now || row.lastSeenAt.getTime() + cfg.idleMs <= now) {
    db().delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
    return null;
  }
  if (now - row.lastSeenAt.getTime() > BUMP_INTERVAL_MS) {
    db()
      .update(schema.sessions)
      .set({ lastSeenAt: new Date(now) })
      .where(eq(schema.sessions.id, id))
      .run();
  }
  return { id, expiresAt: row.expiresAt };
}

export function deleteSessionByToken(token: string) {
  db()
    .delete(schema.sessions)
    .where(eq(schema.sessions.id, hashToken(token)))
    .run();
}

export function deleteAllSessions() {
  db().delete(schema.sessions).run();
}

export function purgeExpiredSessions() {
  return db().delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date())).run()
    .changes;
}
