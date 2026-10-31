import { networkMeta } from "@/lib/networks";
import { cn } from "@/lib/utils";

export function NetworkIcon({ network, className }: { network: string; className?: string }) {
  const meta = networkMeta(network);
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-full font-mono text-[0.65rem] font-semibold",
        meta.className,
        className,
      )}
    >
      {meta.symbol}
    </span>
  );
}

export function NetworkBadge({ network }: { network: string }) {
  const meta = networkMeta(network);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );
}
