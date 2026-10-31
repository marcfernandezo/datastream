"use client";

import { createContext, use, useCallback, useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const COOKIE = "ds_privacy";

const PrivacyContext = createContext<{ hidden: boolean; toggle: () => void }>({
  hidden: false,
  toggle: () => {},
});

export function usePrivacy() {
  return use(PrivacyContext);
}

/**
 * The server renders `data-privacy` on <html> from the cookie, so there is no
 * flash of real amounts on load. Toggling updates the attribute, the cookie
 * and this context (charts read it to hide axes and tooltips).
 */
export function PrivacyProvider({
  initial,
  children,
}: {
  initial: boolean;
  children: React.ReactNode;
}) {
  const [hidden, setHidden] = useState(initial);

  const toggle = useCallback(() => {
    setHidden((h) => {
      const next = !h;
      document.documentElement.dataset.privacy = next ? "on" : "off";
      document.cookie = `${COOKIE}=${next ? "1" : "0"}; Path=/; Max-Age=31536000; SameSite=Strict${location.protocol === "https:" ? "; Secure" : ""}`;
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "h" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return <PrivacyContext value={{ hidden, toggle }}>{children}</PrivacyContext>;
}

export function PrivacyToggle() {
  const { hidden, toggle } = usePrivacy();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-pressed={hidden}
            aria-label={hidden ? "Show amounts" : "Hide amounts"}
          />
        }
      >
        {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </TooltipTrigger>
      <TooltipContent>
        {hidden ? "Show amounts" : "Hide amounts"} <kbd className="ml-1 font-mono text-xs">H</kbd>
      </TooltipContent>
    </Tooltip>
  );
}
