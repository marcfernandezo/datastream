import type { Metadata } from "next";
import { WifiOff } from "lucide-react";
import { Logo } from "@/components/shell/logo";

export const metadata: Metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 text-center">
      <Logo className="text-xl" />
      <div className="grid size-12 place-items-center rounded-full bg-muted">
        <WifiOff className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <div>
        <h1 className="font-medium">Can’t reach your Datastream server</h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Check that you’re on your home network or connected to Tailscale, then try again. No
          portfolio data is stored on this device.
        </p>
      </div>
      {/* A full reload on purpose: client navigation can't work while the server is unreachable. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/" className="text-sm underline underline-offset-4">
        Retry
      </a>
    </main>
  );
}
