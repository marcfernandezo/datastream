import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { env, type Env } from "@/env";
import { sessionCookieName } from "./cookie";
import { clientIp, ipAllowed } from "./ip";
import { limiters } from "./rate-limit";
import { validateSession, type SessionConfig } from "./session";

export type Viewer = { kind: "session"; id: string; expiresAt: Date } | { kind: "network" };

export function sessionConfig(e: Env = env()): SessionConfig {
  return { ttlMs: e.SESSION_TTL_HOURS * 3_600_000, idleMs: e.SESSION_IDLE_HOURS * 3_600_000 };
}

export async function requestIp(): Promise<string | null> {
  return clientIp(await headers(), env().TRUST_PROXY);
}

/**
 * The authoritative auth check (proxy.ts only does an optimistic one).
 * Memoized per request.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const e = env();
  if (!ipAllowed(await requestIp(), e.ALLOWED_CIDRS)) return null;
  if (e.AUTH_MODE === "network-only") return { kind: "network" };
  const token = (await cookies()).get(sessionCookieName(e.COOKIE_SECURE))?.value;
  const s = validateSession(sessionConfig(e), token);
  return s ? { kind: "session", ...s } : null;
});

/** For pages and layouts: redirects to /login when unauthenticated. */
export async function verifySession(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  return viewer;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 429,
  ) {
    super(message);
  }
}

/** For Server Actions: re-checks auth and applies the mutation rate limit. */
export async function authorizeAction(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new AuthError("Not authenticated", 401);
  const wait = limiters.mutation.take((await requestIp()) ?? "local");
  if (wait > 0) throw new AuthError("Too many requests, slow down.", 429);
  return viewer;
}

/** For Route Handlers: returns an error Response, or null when allowed. */
export async function authorizeRoute(limiter?: keyof typeof limiters): Promise<Response | null> {
  if (!(await getViewer())) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (limiter) {
    const wait = limiters[limiter].take((await requestIp()) ?? "local");
    if (wait > 0) {
      return Response.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(Math.ceil(wait / 1000)) } },
      );
    }
  }
  return null;
}
