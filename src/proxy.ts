import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { sessionCookieName } from "@/server/auth/cookie";
import { clientIp, ipAllowed } from "@/server/auth/ip";

/**
 * Network boundary: CIDR allowlist, per-request CSP nonce and an optimistic
 * auth redirect. Authorization is re-checked in the DAL for every page,
 * action and route; this file is not the security boundary for auth.
 */

const PUBLIC_PATHS = [
  "/login",
  "/setup",
  "/api/health",
  "/manifest.webmanifest",
  "/sw.js",
  "/offline",
];
const PUBLIC_PREFIXES = ["/icons/"];

function isPublic(pathname: string) {
  return PUBLIC_PATHS.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

function buildCsp(nonce: string, secure: boolean) {
  const dev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes (charts, popovers) can't carry a nonce.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(secure ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const e = env();
  const { pathname } = request.nextUrl;

  if (!ipAllowed(clientIp(request.headers, e.TRUST_PROXY), e.ALLOWED_CIDRS)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  if (e.AUTH_MODE === "password" && !isPublic(pathname)) {
    const hasCookie = request.cookies.has(sessionCookieName(e.COOKIE_SECURE));
    if (!hasCookie) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce, e.COOKIE_SECURE);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("Cache-Control", "private, no-store");
  if (e.COOKIE_SECURE) {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
