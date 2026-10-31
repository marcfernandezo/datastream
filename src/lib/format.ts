/** Client-safe formatting. Amounts stay bigint until the very last step. */

const groupInt = (n: bigint) => n.toLocaleString("en-US");

/** Base units → decimal string, trimmed, truncated to `maxFraction` digits. */
export function formatUnits(amount: string | bigint, decimals: number, maxFraction = 8): string {
  let v = typeof amount === "bigint" ? amount : BigInt(amount);
  const negative = v < 0n;
  if (negative) v = -v;
  const base = 10n ** BigInt(decimals);
  const int = v / base;
  let frac = decimals > 0 ? (v % base).toString().padStart(decimals, "0") : "";
  frac = frac.slice(0, Math.min(maxFraction, decimals)).replace(/0+$/, "");
  const out = frac ? `${groupInt(int)}.${frac}` : groupInt(int);
  // Avoid "-0" after truncation.
  return negative && out !== "0" ? `-${out}` : out;
}

/** Base units → JS number (only for EUR math/display, never for storage). */
export function unitsToNumber(amount: string | bigint, decimals: number): number {
  const v = typeof amount === "bigint" ? amount : BigInt(amount);
  const base = 10n ** BigInt(decimals);
  return Number(v / base) + Number(v % base) / Number(base);
}

const eurFmt = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const eurCompact = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatEur(value: number, opts: { compact?: boolean } = {}) {
  return (opts.compact ? eurCompact : eurFmt).format(value);
}

export function formatPct(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function timeAgo(date: Date | number, now = Date.now()) {
  const ms = (typeof date === "number" ? date : date.getTime()) - now;
  const abs = Math.abs(ms);
  if (abs < 60_000) return "just now";
  if (abs < 3_600_000) return rtf.format(Math.round(ms / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(ms / 3_600_000), "hour");
  return rtf.format(Math.round(ms / 86_400_000), "day");
}

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});

export function formatTimestamp(unixSeconds: number) {
  return `${dateFmt.format(new Date(unixSeconds * 1000))} UTC`;
}

export function shortHash(hash: string) {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}
