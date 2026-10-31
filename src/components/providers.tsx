"use client";

import { ThemeProvider } from "next-themes";
import { PrivacyProvider } from "@/components/privacy";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({
  children,
  nonce,
  privacy,
}: {
  children: React.ReactNode;
  nonce?: string | undefined;
  privacy: boolean;
}) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
      <PrivacyProvider initial={privacy}>
        <TooltipProvider>
          {children}
          <Toaster richColors position="bottom-right" />
        </TooltipProvider>
      </PrivacyProvider>
    </ThemeProvider>
  );
}
