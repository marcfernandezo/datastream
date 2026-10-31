"use server";

import { createHash, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { env } from "@/env";
import { sessionCookieName } from "@/server/auth/cookie";
import { requestIp, sessionConfig } from "@/server/auth/dal";
import {
  hasPassword,
  PASSWORD_MIN_LENGTH,
  setPassword,
  verifyPassword,
} from "@/server/auth/password";
import { limiters } from "@/server/auth/rate-limit";
import { createSession, deleteSessionByToken } from "@/server/auth/session";
import { logger } from "@/server/log/logger";

export type FormState = { error?: string } | undefined;

async function startSession() {
  const e = env();
  const { token, expiresAt } = createSession(sessionConfig(e), (await headers()).get("user-agent"));
  (await cookies()).set(sessionCookieName(e.COOKIE_SECURE), token, {
    httpOnly: true,
    secure: e.COOKIE_SECURE,
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });
}

function rateLimited(ip: string): string | null {
  const wait = Math.max(limiters.loginIp.take(ip), limiters.loginGlobal.take("global"));
  return wait > 0 ? `Too many attempts. Try again in ${Math.ceil(wait / 60_000)} min.` : null;
}

const loginSchema = z.object({ password: z.string().min(1).max(1024) });

export async function login(_prev: FormState, formData: FormData): Promise<FormState> {
  const ip = (await requestIp()) ?? "local";
  const limited = rateLimited(ip);
  if (limited) return { error: limited };

  const parsed = loginSchema.safeParse({ password: formData.get("password") });
  if (!parsed.success || !(await verifyPassword(parsed.data.password))) {
    logger.warn({ ip }, "failed login attempt");
    return { error: "Incorrect password." };
  }
  limiters.loginIp.reset(ip);
  await startSession();
  logger.info({ ip }, "login");
  redirect("/");
}

const setupSchema = z
  .object({
    token: z.string().min(1, "Setup token is required").max(512),
    password: z
      .string()
      .min(PASSWORD_MIN_LENGTH, `At least ${PASSWORD_MIN_LENGTH} characters`)
      .max(1024),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: "Passwords do not match",
    path: ["confirm"],
  });

const digest = (s: string) => createHash("sha256").update(s).digest();

export async function setup(_prev: FormState, formData: FormData): Promise<FormState> {
  const expected = env().SETUP_TOKEN;
  if (hasPassword() || !expected) redirect("/login");

  const ip = (await requestIp()) ?? "local";
  const limited = rateLimited(ip);
  if (limited) return { error: limited };

  const parsed = setupSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  if (!timingSafeEqual(digest(parsed.data.token), digest(expected))) {
    logger.warn({ ip }, "invalid setup token");
    return { error: "Invalid setup token." };
  }
  await setPassword(parsed.data.password);
  await startSession();
  logger.info("initial password set");
  redirect("/");
}

export async function logout() {
  const e = env();
  const jar = await cookies();
  const name = sessionCookieName(e.COOKIE_SECURE);
  const token = jar.get(name)?.value;
  if (token) deleteSessionByToken(token);
  jar.delete(name);
  redirect("/login");
}
