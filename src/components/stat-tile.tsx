import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Private } from "@/components/amount";
import { Card } from "@/components/ui/card";
import { formatEur, formatPct } from "@/lib/format";

export function DeltaTile({
  label,
  change,
}: {
  label: string;
  change: { eur: number; pct: number } | null;
}) {
  const dir = !change || Math.abs(change.pct) < 0.005 ? "flat" : change.pct > 0 ? "up" : "down";
  const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
  const color = dir === "up" ? "var(--delta-up)" : dir === "down" ? "var(--delta-down)" : undefined;
  return (
    <Card className="gap-1 p-3 sm:p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      {change ? (
        <>
          <span
            className="flex items-center gap-1 text-base font-semibold sm:text-xl"
            style={{ color }}
          >
            <Icon className="size-4" aria-hidden />
            <span className="sr-only">
              {dir === "up" ? "Up" : dir === "down" ? "Down" : "Flat"}
            </span>
            {formatPct(change.pct)}
          </span>
          <Private className="text-xs text-muted-foreground">
            {change.eur >= 0 ? "+" : "−"}
            {formatEur(Math.abs(change.eur))}
          </Private>
        </>
      ) : (
        <span className="text-xl font-semibold text-muted-foreground">—</span>
      )}
    </Card>
  );
}
