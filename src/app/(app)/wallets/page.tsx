import type { Metadata } from "next";
import Link from "next/link";
import { Archive, Download, Wallet } from "lucide-react";
import { Private, TokenAmount } from "@/components/amount";
import { EmptyState } from "@/components/empty-state";
import { NetworkIcon } from "@/components/network-badge";
import { PageHeader } from "@/components/page-header";
import { SyncStatus } from "@/components/sync-status";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { listGroups, walletIdsInGroup } from "@/server/wallets/groups";
import { GroupsDialog } from "./groups-dialog";
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
  const sp = await searchParams;
  const showArchived = sp.archived === "1";
  const groups = listGroups();
  const groupId =
    typeof sp.group === "string" && groups.some((g) => g.id === sp.group) ? sp.group : null;
  const inGroup = groupId ? new Set(walletIdsInGroup(groupId)) : null;
  const wallets = listWallets({ includeArchived: showArchived }).filter(
    (w) => !inGroup || inGroup.has(w.id),
  );
  const values = walletValues();
  const total = wallets.filter((w) => !w.archived).reduce((s, w) => s + (values.get(w.id) ?? 0), 0);
  const href = (group: string | null, archived: boolean) => {
    const q = new URLSearchParams();
    if (group) q.set("group", group);
    if (archived) q.set("archived", "1");
    const qs = q.toString();
    return qs ? `/wallets?${qs}` : "/wallets";
  };

  const add = <AddWalletDialog networks={networkOptions()} />;

  return (
    <>
      <PageHeader
        title="Wallets"
        description="Watch-only. Addresses and keys are encrypted at rest."
        actions={
          <>
            <GroupsDialog groups={groups} />
            <a
              href={`/api/export${groupId ? `?group=${groupId}` : ""}`}
              className={buttonVariants({ variant: "outline" })}
              download
            >
              <Download className="size-4" /> CSV
            </a>
            <Link
              href={href(groupId, !showArchived)}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <Archive className="size-4" aria-hidden />
              {showArchived ? "Hide archived" : "Show archived"}
            </Link>
            {add}
          </>
        }
      />
      {groups.length > 0 && (
        <nav className="mb-4 flex flex-wrap items-center gap-2" aria-label="Filter by group">
          {[{ id: null, name: "All" }, ...groups].map((g) => (
            <Link
              key={g.id ?? "all"}
              href={href(g.id, showArchived)}
              aria-current={g.id === groupId ? "page" : undefined}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium",
                g.id === groupId
                  ? "border-transparent bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {g.name}
            </Link>
          ))}
          {groupId && (
            <span className="ml-auto text-sm text-muted-foreground">
              Group total{" "}
              <Private className="font-medium text-foreground">{formatEur(total)}</Private>
            </span>
          )}
        </nav>
      )}
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
