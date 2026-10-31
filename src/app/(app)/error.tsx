"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-4 rounded-xl border px-6 py-16 text-center"
    >
      <TriangleAlert className="size-8 text-destructive" aria-hidden />
      <div>
        <h2 className="font-medium">Something went wrong</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The error was logged on the server{error.digest ? ` (ref ${error.digest})` : ""}.
        </p>
      </div>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
