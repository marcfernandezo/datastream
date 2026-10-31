import Link from "next/link";
import { CircleAlert, LayoutDashboard } from "lucide-react";
import { Private, TokenAmount } from "@/components/amount";
import { AutoRefresh } from "@/components/auto-refresh";
import { AllocationBar, RankedBars, type Slice } from "@/components/charts/allocation";
import { PerformanceChart } from "@/components/charts/performance-chart";
import { EmptyState } from "@/components/empty-state";
import { NetworkBadge } from "@/components/network-badge";
import { PageHeader } from "@/components/page-header";
import { DeltaTile } from "@/components/stat-tile";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatEur, formatPct, timeAgo } from "@/lib/format";
import { networkMeta } from "@/lib/networks";
import { cn } from "@/lib/utils";
import { verifySession } from "@/server/auth/dal";
import {
  getHoldings,
  holdingsChange,
  performanceSeries,
  pricesUpdatedAt,
  RANGES,
  type Holding,
  type RangeKey,
} from "@/server/portfolio/queries";
import { listWallets } from "@/server/wallets/queries";

const SERIES_SLOTS = 6;
const RANGE_LABEL: Record<RangeKey, string> = {
  "7d": "7D",
  "30d": "30D",
  "90d": "90D",
  "1y": "1Y",
  all: "All",
};

function assetSlices(holdings: Holding[]): Slice[] {
  const priced = holdings.filter((h) => (h.value ?? 0) > 0);
  // Top 5 by value get their own segment; the rest fold into "Other".
  const top = priced.slice(0, priced.length > SERIES_SLOTS ? SERIES_SLOTS - 1 : SERIES_SLOTS);
  const rest = priced.slice(top.length);
  const slices: Slice[] = top.map((h) => ({
    key: h.assetId,
    label: h.symbol,
    sublabel: networkMeta(h.network).label,
    value: h.value!,
    // Color follows the asset (stable creation order), never its rank.
    color: `var(--series-${(h.colorSlot % SERIES_SLOTS) + 1})`,
  }));
  if (rest.length) {
    slices.push({
      key: "other",
      label: "Other",
      sublabel: `${rest.length} assets`,
      value: rest.reduce((s, h) => s + h.value!, 0),
      color: "var(--series-other)",
    });
  }
  return slices;
}

export default async function OverviewPage({ searchParams }: PageProps<"/">) {
  await verifySession();
  const rangeParam = (await searchParams).range;
  const range: RangeKey =
    typeof rangeParam === "string" && rangeParam in RANGES ? (rangeParam as RangeKey) : "30d";

  const wallets = listWallets();
  if (wallets.length === 0) {
    return (
      <>
        <PageHeader title="Overview" />
        <EmptyState
          icon={LayoutDashboard}
          title="Nothing to show yet"
          description="Add a wallet to start tracking your portfolio."
          action={
            <Link href="/wallets" className={buttonVariants()}>
              Add a wallet
            </Link>
          }
        />
      </>
    );
  }

  const holdings = getHoldings();
  const total = holdings.reduce((s, h) => s + (h.value ?? 0), 0);
  const unpriced = holdings.filter((h) => h.value === null);
  const updated = pricesUpdatedAt();
  const series = performanceSeries(range);
  const syncing = wallets.some((w) => w.syncing);

  const byNetwork = new Map<string, number>();
  for (const h of holdings)
    byNetwork.set(h.network, (byNetwork.get(h.network) ?? 0) + (h.value ?? 0));

  return (
    <>
      <AutoRefresh active={syncing} intervalMs={5000} />
      <PageHeader
        title="Overview"
        description={
          updated
            ? `Prices updated ${timeAgo(updated)} · values in EUR`
            : "Waiting for the first price update…"
        }
      />

      <div className="grid grid-cols-3 gap-3 sm:gap-4 lg:grid-cols-4">
        <Card className="col-span-3 gap-1 p-4 lg:col-span-1">
          <span className="text-xs text-muted-foreground">Total value</span>
          <Private className="text-3xl font-semibold tracking-tight [font-variant-numeric:normal]">
            {formatEur(total)}
          </Private>
          <span className="text-xs text-muted-foreground">
            {wallets.length} wallet{wallets.length === 1 ? "" : "s"} · {holdings.length} asset
            {holdings.length === 1 ? "" : "s"}
          </span>
        </Card>
        <DeltaTile label="24h" change={holdingsChange(holdings, 1)} />
        <DeltaTile label="7 days" change={holdingsChange(holdings, 7)} />
        <DeltaTile label="30 days" change={holdingsChange(holdings, 30)} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Changes show the price performance of your current holdings.
      </p>

      <Card className="mt-6">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">Portfolio value</CardTitle>
          <nav className="flex rounded-lg bg-muted p-0.5" aria-label="Time range">
            {(Object.keys(RANGES) as RangeKey[]).map((r) => (
              <Link
                key={r}
                href={r === "30d" ? "/" : `/?range=${r}`}
                scroll={false}
                aria-current={r === range ? "page" : undefined}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground",
                  r === range && "bg-background text-foreground shadow-sm",
                )}
              >
                {RANGE_LABEL[r]}
              </Link>
            ))}
          </nav>
        </CardHeader>
        <CardContent>
          {series.length < 2 ? (
            <div className="flex h-72 items-center justify-center text-center text-sm text-muted-foreground">
              Collecting data. The chart fills in as prices and history are fetched.
            </div>
          ) : (
            <PerformanceChart data={series} label={`Last ${RANGE_LABEL[range]}`} />
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Allocation by asset</CardTitle>
          </CardHeader>
          <CardContent>
            <AllocationBar slices={assetSlices(holdings)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Allocation by network</CardTitle>
          </CardHeader>
          <CardContent>
            <RankedBars
              items={[...byNetwork]
                .filter(([, v]) => v > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([network, value]) => ({
                  key: network,
                  label: networkMeta(network).label,
                  value,
                }))}
            />
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Holdings</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead className="hidden md:table-cell">Network</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Price</TableHead>
                <TableHead className="hidden text-right sm:table-cell">24h</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {holdings.map((h) => (
                <TableRow key={h.assetId}>
                  <TableCell>
                    <div className="font-medium">{h.symbol}</div>
                    <div className="max-w-40 truncate text-xs text-muted-foreground">{h.name}</div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <NetworkBadge network={h.network} />
                  </TableCell>
                  <TableCell className="text-right">
                    <TokenAmount amount={h.amount} decimals={h.decimals} maxFraction={6} />
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">
                    {h.price === null ? "—" : formatEur(h.price)}
                  </TableCell>
                  <TableCell
                    className="hidden text-right tabular-nums sm:table-cell"
                    style={{
                      color:
                        h.change24h === null
                          ? undefined
                          : h.change24h >= 0
                            ? "var(--delta-up)"
                            : "var(--delta-down)",
                    }}
                  >
                    {h.change24h === null ? "—" : formatPct(h.change24h)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {h.value === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Private>{formatEur(h.value)}</Private>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {unpriced.length > 0 && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <CircleAlert className="size-3.5" aria-hidden />
              {unpriced.length} asset{unpriced.length === 1 ? " has" : "s have"} no price yet and{" "}
              {unpriced.length === 1 ? "is" : "are"} excluded from totals.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
