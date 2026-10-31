import { Private } from "@/components/amount";
import { formatEur } from "@/lib/format";

export interface Slice {
  key: string;
  label: string;
  sublabel?: string;
  value: number;
  /** CSS color (a --series-N token or --series-other). */
  color: string;
}

const pct = (v: number, total: number) => (total > 0 ? (v / total) * 100 : 0);

/**
 * Part-to-whole as one segmented bar (≤ 7 segments incl. "Other") plus a
 * labelled legend that doubles as the table view, so identity never relies
 * on color alone.
 */
export function AllocationBar({ slices }: { slices: Slice[] }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return <p className="text-sm text-muted-foreground">No priced holdings yet.</p>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full" aria-hidden>
        {slices.map((s) => (
          <div
            key={s.key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${pct(s.value, total)}%`, background: s.color, minWidth: 2 }}
            title={`${s.label}: ${pct(s.value, total).toFixed(1)}%`}
          />
        ))}
      </div>
      <ul className="flex flex-col gap-2 text-sm">
        {slices.map((s) => (
          <li key={s.key} className="flex items-center gap-3">
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: s.color }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{s.label}</span>
              {s.sublabel && (
                <span className="ml-1.5 text-xs text-muted-foreground">{s.sublabel}</span>
              )}
            </span>
            <span className="w-14 text-right text-muted-foreground tabular-nums">
              {pct(s.value, total).toFixed(1)}%
            </span>
            <Private className="w-24 text-right">{formatEur(s.value)}</Private>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Ranked horizontal bars, single color (one series). */
export function RankedBars({ items }: { items: { key: string; label: string; value: number }[] }) {
  const maxValue = Math.max(...items.map((i) => i.value), 0);
  const total = items.reduce((s, i) => s + i.value, 0);
  if (maxValue <= 0)
    return <p className="text-sm text-muted-foreground">No priced holdings yet.</p>;
  return (
    <ul className="flex flex-col gap-3 text-sm">
      {items.map((i) => (
        <li key={i.key} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium">{i.label}</span>
            <span className="flex items-baseline gap-3">
              <span className="text-xs text-muted-foreground tabular-nums">
                {pct(i.value, total).toFixed(1)}%
              </span>
              <Private>{formatEur(i.value)}</Private>
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${pct(i.value, maxValue)}%`,
                background: "var(--series-1)",
                minWidth: 4,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
