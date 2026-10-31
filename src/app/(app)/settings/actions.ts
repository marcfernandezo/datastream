"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { env } from "@/env";
import { sessionCookieName } from "@/server/auth/cookie";
import { authorizeAction, requestIp, sessionConfig } from "@/server/auth/dal";
import { PASSWORD_MIN_LENGTH, setPassword, verifyPassword } from "@/server/auth/password";
import { limiters } from "@/server/auth/rate-limit";
import { createSession, deleteAllSessions } from "@/server/auth/session";
import { logger } from "@/server/log/logger";

export type ActionResult = { ok?: boolean; error?: string } | undefined;

const changeSchema = z
  .object({
    current: z.string().min(1).max(1024),
    password: z
      .string()
      .min(PASSWORD_MIN_LENGTH, `At least ${PASSWORD_MIN_LENGTH} characters`)
      .max(1024),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: "Passwords do not match" });

async function rotateCurrentSession() {
  const e = env();
  deleteAllSessions();
  const { token, expiresAt } = createSession(sessionConfig(e), (await headers()).get("user-agent"));
  (await cookies()).set(sessionCookieName(e.COOKIE_SECURE), token, {
    httpOnly: true,
    secure: e.COOKIE_SECURE,
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });
}

export async function changePassword(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  await authorizeAction();
  if (limiters.loginIp.take((await requestIp()) ?? "local") > 0) {
    return { error: "Too many attempts. Try again later." };
  }
  const parsed = changeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  if (!(await verifyPassword(parsed.data.current)))
    return { error: "Current password is incorrect." };

  await setPassword(parsed.data.password);
  await rotateCurrentSession();
  logger.info("password changed; all other sessions revoked");
  return { ok: true };
}

export async function signOutEverywhere() {
  await authorizeAction();
  deleteAllSessions();
  (await cookies()).delete(sessionCookieName(env().COOKIE_SECURE));
  logger.info("all sessions revoked");
  redirect("/login");
}
