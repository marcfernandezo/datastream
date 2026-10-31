/** Shared by proxy.ts and the DAL; no server-only deps. */
export function sessionCookieName(secure: boolean) {
  // __Host- forces Secure, Path=/ and no Domain. Only usable over HTTPS.
  return secure ? "__Host-ds_session" : "ds_session";
}

export const PRIVACY_COOKIE = "ds_privacy";
