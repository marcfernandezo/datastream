import { CircleAlert, Loader2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/format";

export function SyncStatus({
  syncing,
  lastSyncedAt,
  error,
}: {
  syncing: boolean;
  lastSyncedAt: Date | null;
  error: string | null;
}) {
  if (syncing) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden /> Syncing…
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
