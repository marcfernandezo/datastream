import { Eye, EyeOff } from "lucide-react";
import { Private, TokenAmount } from "@/components/amount";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatEur, unitsToNumber } from "@/lib/format";
import { isVisible } from "@/server/portfolio/queries";
import type { BalanceView } from "@/server/wallets/queries";
import { setAssetVisibilityAction } from "../actions";

function VisibilityButton({ assetId, hide }: { assetId: string; hide: boolean }) {
  return (
    <form action={setAssetVisibilityAction.bind(null, assetId, hide)}>
      <Button
        type="submit"
        variant="ghost"
        size="icon-sm"
        aria-label={hide ? "Hide token" : "Show token"}
        title={hide ? "Hide token everywhere" : "Show token"}
      >
        {hide ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </Button>
    </form>
  );
}

export function BalancesCard({
  balances,
  prices,
  synced,
}: {
  balances: BalanceView[];
  prices: Map<string, number>;
  synced: boolean;
}) {
  const nonZero = balances.filter((b) => BigInt(b.amount) !== 0n || !b.contract);
  const visible = nonZero
    .filter(isVisible)
    .map((b) => {
      const price = b.coingeckoId ? prices.get(b.coingeckoId) : undefined;
      return {
        ...b,
        value: price === undefined ? null : unitsToNumber(b.amount, b.decimals) * price,
      };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const hidden = nonZero.filter((b) => !isVisible(b));
  const total = visible.reduce((s, b) => s + (b.value ?? 0), 0);

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row items-baseline justify-between">
        <CardTitle className="text-sm font-medium">Balances</CardTitle>
        {visible.length > 0 && (
          <Private className="text-lg font-semibold">{formatEur(total)}</Private>
        )}
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {synced ? "No balances." : "Waiting for the first sync…"}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((b) => (
                <TableRow key={b.assetId}>
                  <TableCell>
                    <div className="font-medium">{b.symbol}</div>
                    <div className="max-w-40 truncate text-xs text-muted-foreground">{b.name}</div>
                  </TableCell>
                  <TableCell className="text-right">
                    <TokenAmount amount={b.amount} decimals={b.decimals} symbol={b.symbol} />
                  </TableCell>
                  <TableCell className="text-right">
                    {b.value === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Private>{formatEur(b.value)}</Private>
                    )}
                  </TableCell>
                  <TableCell>
                    {b.contract && <VisibilityButton assetId={b.assetId} hide />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {hidden.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
              {hidden.length} hidden token{hidden.length === 1 ? "" : "s"} (unpriced or hidden by
              you; often airdropped spam)
            </summary>
            <ul className="mt-2 flex flex-col gap-1">
              {hidden.map((b) => (
                <li key={b.assetId} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{b.symbol}</span>
                    <span className="ml-1.5 text-xs text-muted-foreground">{b.name}</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <TokenAmount
                      amount={b.amount}
                      decimals={b.decimals}
                      maxFraction={4}
                      className="text-xs"
                    />
                    <VisibilityButton assetId={b.assetId} hide={false} />
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
