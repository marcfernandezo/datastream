import { beforeEach, describe, expect, it } from "vitest";
import { hasPassword, setPassword, verifyPassword } from "@/server/auth/password";
import { createSession, hashToken, validateSession } from "@/server/auth/session";
import { claimNext, complete, enqueue, fail, requeueInterrupted } from "@/server/jobs/queue";
import { schema } from "@/server/db/client";
import { useTestDb } from "./helpers/db";

let handle: ReturnType<typeof useTestDb>;
beforeEach(() => {
  handle = useTestDb();
});

describe("password", () => {
  it("hashes with argon2id and verifies", async () => {
    expect(hasPassword()).toBe(false);
    expect(await verifyPassword("anything at all")).toBe(false);
    await setPassword("correct horse battery");
    expect(hasPassword()).toBe(true);
    const row = handle.db.select().from(schema.settings).get();
    expect(row?.value).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword("correct horse battery")).toBe(true);
    expect(await verifyPassword("wrong")).toBe(false);
  });

  it("enforces a minimum length", async () => {
    await expect(setPassword("short")).rejects.toThrow(/at least/);
  });
});

describe("sessions", () => {
  const cfg = { ttlMs: 60_000, idleMs: 30_000 };

  it("stores only the token hash", () => {
    const { token } = createSession(cfg, "ua");
    const rows = handle.db.select().from(schema.sessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("validates, and rejects unknown/expired tokens", () => {
    const { token } = createSession(cfg, null);
    expect(validateSession(cfg, token)).not.toBeNull();
    expect(validateSession(cfg, "nope")).toBeNull();
    expect(validateSession(cfg, undefined)).toBeNull();
    expect(validateSession({ ttlMs: 60_000, idleMs: -1 }, token)).toBeNull();
    // Expired sessions are deleted.
    expect(handle.db.select().from(schema.sessions).all()).toHaveLength(0);
  });
});

describe("job queue", () => {
  it("dedups by key, claims in order and retries with backoff", () => {
    expect(enqueue("a", {}, { key: "k" })).toBeTypeOf("number");
    expect(enqueue("a", {}, { key: "k" })).toBeNull();
    enqueue("b");

    const first = claimNext()!;
    expect(first.kind).toBe("a");
    expect(first.attempts).toBe(1);
    expect(fail(first, "boom")).toBe(true);

    const second = claimNext()!;
    expect(second.kind).toBe("b");
    complete(second.id);
    // "a" is backing off.
    expect(claimNext()).toBeNull();
    expect(claimNext(new Date(Date.now() + 60_000))?.kind).toBe("a");
  });

  it("requeues interrupted jobs", () => {
    enqueue("x");
    claimNext();
    expect(requeueInterrupted()).toBe(1);
    expect(claimNext()?.kind).toBe("x");
  });
});
