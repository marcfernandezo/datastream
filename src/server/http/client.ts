import { maskSensitive } from "@/server/log/mask";
import { logger } from "@/server/log/logger";

/**
 * Outbound HTTP for adapters and price feeds:
 * - per-host token bucket so free tiers aren't hammered,
 * - timeout, retries with exponential backoff + jitter, Retry-After support,
 * - errors and logs never include query strings (API keys) or full addresses.
 */

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** undici wraps network errors as "fetch failed"; the useful part is the cause code. */
function errorCause(err: unknown): string {
  if (!(err instanceof Error)) return "network error";
  if (err.name === "TimeoutError") return "timed out";
  const cause = err.cause as { code?: string; message?: string } | undefined;
  return cause?.code ?? cause?.message ?? err.message;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  retries?: number;
  /** Host-level budget override, requests per second. */
  rps?: number;
}

export interface HttpClient {
  json<T = unknown>(url: string, opts?: RequestOptions): Promise<T>;
}

/** Safe description of a URL for logs and errors: host + masked path, no query. */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${maskSensitive(u.pathname)}`;
  } catch {
    return "[invalid url]";
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

class HostThrottle {
  private next = 0;
  constructor(private intervalMs: number) {}
  async wait(signal?: AbortSignal) {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) await sleep(at - now, signal);
  }
  /** Push everyone back after a 429. */
  penalize(ms: number) {
    this.next = Math.max(this.next, Date.now() + ms);
  }
}

export interface ClientConfig {
  timeoutMs: number;
  /** Default requests per second per host. */
  defaultRps?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export function createHttpClient(cfg: ClientConfig): HttpClient {
  const throttles = new Map<string, HostThrottle>();
  const doFetch = cfg.fetchImpl ?? fetch;

  function throttleFor(host: string, rps: number) {
    let t = throttles.get(host);
    if (!t) {
      t = new HostThrottle(1000 / rps);
      throttles.set(host, t);
    }
    return t;
  }

  async function json<T>(url: string, opts: RequestOptions = {}): Promise<T> {
    const where = describeUrl(url);
    const host = new URL(url).host;
    const throttle = throttleFor(host, opts.rps ?? cfg.defaultRps ?? 4);
    const retries = opts.retries ?? 4;
    let lastError: unknown;
    let rateLimited = false;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(30_000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random());
        await sleep(backoff, opts.signal);
      }
      await throttle.wait(opts.signal);

      const timeout = AbortSignal.timeout(cfg.timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      try {
        const res = await doFetch(url, {
          method: opts.method ?? "GET",
          headers: {
            accept: "application/json",
            "user-agent": cfg.userAgent ?? "datastream",
            ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
            ...opts.headers,
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
          signal,
          redirect: "error",
        });

        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get("retry-after"));
          if (res.status === 429) {
            rateLimited = true;
            throttle.penalize(
              Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 15_000,
            );
          }
          lastError = new HttpError(`${where} responded ${res.status}`, res.status, true);
          logger.debug({ where, status: res.status, attempt }, "retryable http response");
          await res.body?.cancel();
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw new HttpError(`${where} responded ${res.status}`, res.status, false);
        }
        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof HttpError && !err.retryable) throw err;
        if (opts.signal?.aborted) throw opts.signal.reason;
        lastError = err;
        // Some public APIs answer rate-limit abuse by refusing connections.
        if (rateLimited) throttle.penalize(30_000);
        logger.debug({ where, attempt, cause: errorCause(err) }, "http error");
      }
    }
    if (lastError instanceof HttpError) throw lastError;
    throw new HttpError(`${where} failed: ${maskSensitive(errorCause(lastError))}`, 0, true);
  }

  return { json };
}
