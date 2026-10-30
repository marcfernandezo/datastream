import type { Metadata } from "next";
import Link from "next/link";
import { Archive, Wallet } from "lucide-react";
import { Private, TokenAmount } from "@/components/amount";
import { EmptyState } from "@/components/empty-state";
import { NetworkIcon } from "@/components/network-badge";
import { PageHeader } from "@/components/page-header";
import { SyncStatus } from "@/components/sync-status";
import { Card } from "@/components/ui/card";
import { verifySession } from "@/server/auth/dal";
import { getAdapter } from "@/server/chains/registry";
import { listWallets } from "@/server/wallets/queries";
import { isVisible, walletValues } from "@/server/portfolio/queries";
import { formatEur } from "@/lib/format";
import { AddWalletDialog } from "./add-wallet-dialog";
import { networkOptions } from "./network-options";

export const metadata: Metadata = { title: "Wallets" };

export default async function WalletsPage({ searchParams }: PageProps<"/wallets">) {
  await verifySession();
  const showArchived = (await searchParams).archived === "1";
  const wallets = listWallets({ includeArchived: showArchived });
  const values = walletValues();
  const add = <AddWalletDialog networks={networkOptions()} />;

  return (
    <>
      <PageHeader
        title="Wallets"
        description="Watch-only. Addresses and keys are encrypted at rest."
        actions={
          <>
            <Link
              href={showArchived ? "/wallets" : "/wallets?archived=1"}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <Archive className="size-4" aria-hidden />
              {showArchived ? "Hide archived" : "Show archived"}
            </Link>
            {add}
          </>
        }
      />
      {wallets.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="No wallets yet"
          description="Add a Bitcoin address or xpub, an Ethereum address or a Solana address to start tracking."
          action={add}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {wallets.map((w) => {
            const native = getAdapter(w.network).nativeAsset;
            const nativeBalance = w.balances.find((b) => b.assetId === native.id)?.amount ?? "0";
            const value = values.get(w.id);
            const tokenCount = w.balances.filter((b) => b.contract && isVisible(b)).length;
            return (
              <li key={w.id}>
                <Link href={`/wallets/${w.id}`} className="group block focus-visible:outline-none">
                  <Card className="flex flex-row items-center gap-3 p-4 transition-colors group-hover:bg-muted/40 group-focus-visible:ring-3 group-focus-visible:ring-ring/50">
                    <NetworkIcon network={w.network} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{w.label}</span>
                        {w.archived && (
                          <span className="rounded bg-muted px-1.5 text-[0.65rem] uppercase">
                            archived
                          </span>
                        )}
                      </div>
                      <div
                        className="truncate font-mono text-xs text-muted-foreground"
                        data-private
                      >
                        {w.displayHint}
                      </div>
                      {(w.syncing || w.lastSyncError || !w.lastSyncedAt) && (
                        <SyncStatus
                          syncing={w.syncing}
                          lastSyncedAt={w.lastSyncedAt}
                          error={w.lastSyncError}
                        />
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 text-right">
                      {value !== undefined && value > 0 ? (
                        <Private className="text-sm font-medium">{formatEur(value)}</Private>
                      ) : null}
                      <span className="text-xs text-muted-foreground">
                        <TokenAmount
                          amount={nativeBalance}
                          decimals={native.decimals}
                          symbol={native.symbol}
                          maxFraction={6}
                        />
                        {tokenCount > 0 && ` +${tokenCount} token${tokenCount === 1 ? "" : "s"}`}
                      </span>
                    </div>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
