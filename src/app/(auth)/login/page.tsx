import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { env } from "@/env";
import { getViewer } from "@/server/auth/dal";
import { hasPassword } from "@/server/auth/password";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (env().AUTH_MODE === "network-only" || (await getViewer())) redirect("/");
  if (!hasPassword()) redirect("/setup");
  return <LoginForm />;
}
