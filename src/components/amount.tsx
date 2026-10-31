import { formatUnits } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Every sensitive number in the UI renders through <Private>. The
 * `data-private` attribute lets privacy mode mask it with CSS, so it works
 * the same in server and client components.
 */
export function Private({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span data-private className={cn("tabular-nums", className)}>
      {children}
    </span>
  );
}

export function TokenAmount({
  amount,
  decimals,
  symbol,
  signed = false,
  maxFraction = 8,
  className,
}: {
  amount: string | bigint;
  decimals: number;
  symbol?: string;
  signed?: boolean;
  maxFraction?: number;
  className?: string;
}) {
  const text = formatUnits(amount, decimals, maxFraction);
  const sign = signed && !text.startsWith("-") && text !== "0" ? "+" : "";
  return (
    <Private className={className}>
      {sign}
      {text}
      {symbol ? <span className="ml-1 text-muted-foreground">{symbol}</span> : null}
    </Private>
  );
}
