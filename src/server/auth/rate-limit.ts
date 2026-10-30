/**
 * In-memory token buckets. Datastream runs as a single web instance, so a
 * process-local store is enough. It lives on globalThis so every route bundle
 * in the process shares the same buckets.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface LimiterOptions {
  /** Max burst. */
  capacity: number;
  /** Full refill window in ms. */
  windowMs: number;
}

const g = globalThis as unknown as { __dsBuckets?: Map<string, Bucket> };
const store = (g.__dsBuckets ??= new Map());

export function createLimiter(name: string, { capacity, windowMs }: LimiterOptions) {
  const refillPerMs = capacity / windowMs;

  return {
    /** Consumes a token; returns ms to wait if limited, or 0 if allowed. */
    take(key: string, now = Date.now()): number {
      const id = `${name}:${key}`;
      const b = store.get(id) ?? { tokens: capacity, updatedAt: now };
      b.tokens = Math.min(capacity, b.tokens + (now - b.updatedAt) * refillPerMs);
      b.updatedAt = now;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        store.set(id, b);
        return 0;
      }
      store.set(id, b);
      return Math.ceil((1 - b.tokens) / refillPerMs);
    },
    reset(key: string) {
      store.delete(`${name}:${key}`);
    },
  };
}

// Periodically drop full buckets so the map can't grow unbounded.
const sweep = setInterval(
  () => {
    const now = Date.now();
    for (const [k, b] of store) if (now - b.updatedAt > 60 * 60 * 1000) store.delete(k);
  },
  10 * 60 * 1000,
);
sweep.unref?.();

export const limiters = {
  /** Per-IP: LOGIN_MAX_ATTEMPTS (default 5) per 15 minutes. */
  loginIp: createLimiter("login-ip", {
    capacity: Number(process.env.LOGIN_MAX_ATTEMPTS) || 5,
    windowMs: 15 * 60 * 1000,
  }),
  /** Global: caps distributed guessing at 30 per 15 minutes. */
  loginGlobal: createLimiter("login-global", {
    capacity: Math.max(30, Number(process.env.LOGIN_MAX_ATTEMPTS) || 0),
    windowMs: 15 * 60 * 1000,
  }),
  /** Mutations (server actions): 60/minute. */
  mutation: createLimiter("mutation", { capacity: 60, windowMs: 60 * 1000 }),
  /** Exports: 10/minute. */
  export: createLimiter("export", { capacity: 10, windowMs: 60 * 1000 }),
};
