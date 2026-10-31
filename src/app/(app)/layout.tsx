import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PrivacyToggle } from "@/components/privacy";
import { Logo } from "@/components/shell/logo";
import { MobileNav } from "@/components/shell/mobile-nav";
import { Nav } from "@/components/shell/nav";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { verifySession } from "@/server/auth/dal";
import { logout } from "../(auth)/actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const viewer = await verifySession();

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r bg-sidebar p-4 md:flex">
        <div className="px-2 pb-6">
          <Logo />
        </div>
        <Nav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur md:px-6">
          <MobileNav />
          <div className="md:hidden">
            <Logo />
          </div>
          <div id="header-actions" className="ml-auto flex items-center gap-1">
            <PrivacyToggle />
            <ThemeToggle />
            {viewer.kind === "session" && (
              <form action={logout}>
                <Button variant="ghost" size="icon" type="submit" aria-label="Sign out">
                  <LogOut className="size-4" />
                </Button>
              </form>
            )}
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-6 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
