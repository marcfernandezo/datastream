export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  process.env.NEXT_TELEMETRY_DISABLED = "1";

  const { env } = await import("@/env");
  const { getHandle, runMigrations } = await import("@/server/db/client");
  const { logger } = await import("@/server/log/logger");

  // Fail fast on bad configuration instead of on the first request.
  const e = env();
  runMigrations(getHandle().db);
  logger.info(
    { authMode: e.AUTH_MODE, cidrs: e.ALLOWED_CIDRS.length, trustProxy: e.TRUST_PROXY },
    "watchtower web ready",
  );
  if (!e.COOKIE_SECURE) logger.warn("COOKIE_SECURE=false: session cookie is sent over plain HTTP");
}
