import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { env } from "@/env";
import { verifySession } from "@/server/auth/dal";
import { signOutEverywhere } from "./actions";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const viewer = await verifySession();
  const e = env();

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        {viewer.kind === "session" ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Password</CardTitle>
                <CardDescription>Changing it signs out every other session.</CardDescription>
              </CardHeader>
              <CardContent>
                <ChangePasswordForm />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Sessions</CardTitle>
                <CardDescription>
                  Sessions expire after {e.SESSION_IDLE_HOURS}h of inactivity and at most{" "}
                  {Math.round(e.SESSION_TTL_HOURS / 24)} days after sign-in.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form action={signOutEverywhere}>
                  <Button variant="destructive" type="submit">
                    Sign out everywhere
                  </Button>
                </form>
              </CardContent>
            </Card>
          </>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Access</CardTitle>
              <CardDescription>
                Network-only mode: access is restricted to {e.ALLOWED_CIDRS.join(", ")}.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>
    </>
  );
}
