import { CircleAlert, Loader2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/format";

export function SyncStatus({
  syncing,
  lastSyncedAt,
  error,
  note,
}: {
  syncing: boolean;
  lastSyncedAt: Date | null;
  error: string | null;
  /** Progress of a deferred sync, e.g. a first shielded scan. */
  note?: string | null;
}) {
  if (syncing) {
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        role="status"
      >
        <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
        <span className="truncate">{note ? `${note}…` : "Syncing…"}</span>
      </span>
    );
  }
  if (error) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex cursor-help items-center gap-1.5 text-xs text-destructive" />
          }
        >
          <CircleAlert className="size-3" aria-hidden /> Sync failed
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{error}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      {lastSyncedAt ? `Synced ${timeAgo(lastSyncedAt)}` : "Not synced yet"}
    </span>
  );
}
