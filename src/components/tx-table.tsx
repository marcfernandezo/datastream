import Link from "next/link";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ExternalLink, Repeat } from "lucide-react";
import { TokenAmount } from "@/components/amount";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTimestamp, shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface TxRowView {
  id: number;
  txid: string;
  walletLabel?: string;
  blockTime: number | null;
  status: "pending" | "confirmed" | "failed";
  direction: "in" | "out" | "self" | "swap";
  fee: string | null;
  feeDecimals: number;
  feeSymbol: string;
  explorerUrl: string;
  movements: { assetId: string; symbol: string; decimals: number; amount: string }[];
  /** Filled in once prices exist. */
  eurValue?: React.ReactNode;
}

const DIRECTION = {
  in: {
    icon: ArrowDownLeft,
    label: "Received",
    className: "text-emerald-600 dark:text-emerald-400",
  },
  out: { icon: ArrowUpRight, label: "Sent", className: "text-rose-600 dark:text-rose-400" },
  swap: { icon: ArrowLeftRight, label: "Swap", className: "text-sky-600 dark:text-sky-400" },
  self: { icon: Repeat, label: "Internal", className: "text-muted-foreground" },
} as const;

export function TxTable({ rows, showWallet = false }: { rows: TxRowView[]; showWallet?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            {showWallet && <TableHead>Wallet</TableHead>}
            <TableHead className="hidden sm:table-cell">Date</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="hidden text-right md:table-cell">Fee</TableHead>
            <TableHead className="hidden lg:table-cell">Transaction</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((tx) => {
            const dir = DIRECTION[tx.direction];
            const Icon = dir.icon;
            return (
              <TableRow key={tx.id}>
                <TableCell>
                  <span className={cn("inline-flex items-center gap-2 font-medium", dir.className)}>
                    <Icon className="size-4" aria-hidden />
                    <span className="text-foreground">{dir.label}</span>
                  </span>
                  {tx.status !== "confirmed" && (
                    <Badge
                      variant={tx.status === "failed" ? "destructive" : "secondary"}
                      className="ml-2 align-middle"
                    >
                      {tx.status}
                    </Badge>
                  )}
                  <div className="mt-0.5 text-xs text-muted-foreground sm:hidden">
                    {tx.blockTime ? formatTimestamp(tx.blockTime) : "Pending"}
                  </div>
                </TableCell>
                {showWallet && (
                  <TableCell className="max-w-40 truncate">{tx.walletLabel}</TableCell>
                )}
                <TableCell className="hidden text-sm whitespace-nowrap text-muted-foreground sm:table-cell">
                  {tx.blockTime ? formatTimestamp(tx.blockTime) : "Pending"}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-col items-end gap-0.5">
                    {tx.movements.length === 0 && <span className="text-muted-foreground">—</span>}
                    {tx.movements.map((m) => (
                      <TokenAmount
                        key={m.assetId}
                        amount={m.amount}
                        decimals={m.decimals}
                        symbol={m.symbol}
                        signed
                        className={
                          BigInt(m.amount) > 0n
                            ? "text-emerald-600 dark:text-emerald-400"
                            : undefined
                        }
                      />
                    ))}
                    {tx.eurValue}
                  </div>
                </TableCell>
                <TableCell className="hidden text-right md:table-cell">
                  {tx.fee ? (
                    <TokenAmount
                      amount={tx.fee}
                      decimals={tx.feeDecimals}
                      symbol={tx.feeSymbol}
                      className="text-xs text-muted-foreground"
                    />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <Link
                    href={tx.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                    data-private
                  >
                    {shortHash(tx.txid)}
                    <ExternalLink className="size-3" aria-hidden />
                  </Link>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
