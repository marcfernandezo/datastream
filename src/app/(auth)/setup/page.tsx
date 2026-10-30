import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { env } from "@/env";
import { hasPassword } from "@/server/auth/password";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up" };

export default function SetupPage() {
  const e = env();
  if (e.AUTH_MODE === "network-only") redirect("/");
  if (hasPassword()) redirect("/login");

  if (!e.SETUP_TOKEN) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Set a password</CardTitle>
          <CardDescription>
            No password is configured yet. Either set <code>SETUP_TOKEN</code> in your environment
            and reload this page, or run this on the server:
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
            pnpm wt set-password
          </pre>
        </CardContent>
      </Card>
    );
  }
  return <SetupForm />;
}
