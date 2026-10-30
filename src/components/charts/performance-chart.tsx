"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { usePrivacy } from "@/components/privacy";
import { formatEur } from "@/lib/format";

export interface Point {
  ts: number;
  value: number;
}

const dayFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});
const fullFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

function ChartTooltip({
  active,
  payload,
  hidden,
}: {
  active?: boolean;
  payload?: { payload: Point }[];
  hidden: boolean;
}) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="text-muted-foreground">{fullFmt.format(p.ts * 1000)} UTC</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums">
        {hidden ? "••••••" : formatEur(p.value)}
      </div>
    </div>
  );
}

export function PerformanceChart({ data, label }: { data: Point[]; label: string }) {
  const { hidden } = usePrivacy();
  const first = data[0]?.value ?? 0;
  const last = data.at(-1)?.value ?? 0;
  const summary = hidden
    ? `${label}: portfolio value chart (amounts hidden)`
    : `${label}: portfolio value from ${formatEur(first)} to ${formatEur(last)}`;

  return (
    <figure className="m-0">
      <div className="h-72 w-full" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id="perf-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" strokeWidth={1} />
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(ts: number) => dayFmt.format(ts * 1000)}
              tick={{ fill: "var(--viz-axis)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--viz-grid)" }}
              minTickGap={32}
            />
            <YAxis
              orientation="right"
              width={hidden ? 8 : 64}
              tick={hidden ? false : { fill: "var(--viz-axis)", fontSize: 11 }}
              tickFormatter={(v: number) => formatEur(v, { compact: true })}
              tickLine={false}
              axisLine={false}
              domain={["auto", "auto"]}
            />
            <Tooltip
              content={<ChartTooltip hidden={hidden} />}
              cursor={{ stroke: "var(--viz-axis)", strokeWidth: 1 }}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="var(--series-1)"
              strokeWidth={2}
              fill="url(#perf-fill)"
              dot={false}
              activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2, fill: "var(--series-1)" }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">
          View as table
        </summary>
        <table className="mt-2 w-full max-w-sm text-left">
          <thead>
            <tr>
              <th className="py-1 font-medium">Date (UTC)</th>
              <th className="py-1 text-right font-medium">Value</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {thin(data, 31).map((p) => (
              <tr key={p.ts}>
                <td className="py-0.5">{fullFmt.format(p.ts * 1000)}</td>
                <td className="py-0.5 text-right" data-private>
                  {formatEur(p.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** At most `n` evenly spaced points, always keeping the last. */
function thin<T>(data: T[], n: number): T[] {
  if (data.length <= n) return data;
  const step = (data.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => data[Math.round(i * step)]!);
}
