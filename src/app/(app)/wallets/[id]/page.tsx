import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, ExternalLink, History } from "lucide-react";
import { z } from "zod";
import { AutoRefresh } from "@/components/auto-refresh";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { NetworkBadge, NetworkIcon } from "@/components/network-badge";
import { SyncStatus } from "@/components/sync-status";
import { Pagination, TxFilters } from "@/components/tx-filters";
import { TxEur, TxTable } from "@/components/tx-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { parseTxSearchParams, txQuery } from "@/lib/tx-search-params";
import { verifySession } from "@/server/auth/dal";
import { spotPrices, txEurValues } from "@/server/portfolio/queries";
import { getAdapter } from "@/server/chains/registry";
import {
  getWallet,
  listTransactions,
  walletAssets,
  walletBalances,
} from "@/server/wallets/queries";
import { buttonVariants } from "@/components/ui/button";
import { listGroups, walletGroupIds } from "@/server/wallets/groups";
import { BalancesCard } from "./balances-card";
import { GroupsCard } from "./groups-card";
import { WalletActions } from "./wallet-actions";

export const metadata: Metadata = { title: "Wallet" };

const SOURCE_LABEL = {
  address: "Address",
  xpub: "Extended public key",
  ufvk: "Viewing key",
} as const;

export default async function WalletPage({ params, searchParams }: PageProps<"/wallets/[id]">) {
  await verifySession();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const data = getWallet(id.data);
  if (!data) notFound();

  const { wallet, syncing, source, explorerAddressUrl, nativeAsset } = data;
  const adapter = getAdapter(wallet.network);
  const filters = parseTxSearchParams(await searchParams);
  const coinIds = walletBalances(wallet.id)
    .map((b) => b.coingeckoId)
    .filter((id): id is string => !!id);
  const txs = listTransactions([wallet.id], {
    page: filters.page,
    direction: filters.direction,
    assetId: filters.asset,
    q: filters.q,
    from: filters.fromTs,
    to: filters.toTs,
  });
  const eurValues = txEurValues(txs.rows);
  const hasFilters = !!(
    filters.direction ||
    filters.asset ||
    filters.q ||
    filters.from ||
    filters.to
  );

  return (
    <>
      <AutoRefresh active={syncing} />
      <Link
        href="/wallets"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Wallets
      </Link>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <NetworkIcon network={wallet.network} className="size-11 text-xs" />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{wallet.label}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <NetworkBadge network={wallet.network} />
              <span className="text-xs text-muted-foreground">
                {SOURCE_LABEL[wallet.sourceKind]}
              </span>
              {wallet.archived && <span className="rounded bg-muted px-1.5 text-xs">Archived</span>}
              <SyncStatus
                syncing={syncing}
                lastSyncedAt={wallet.lastSyncedAt}
                error={wallet.lastSyncError}
                note={wallet.syncNote}
              />
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <WalletActions
            id={wallet.id}
            label={wallet.label}
            archived={wallet.archived}
            syncing={syncing}
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-1">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                {SOURCE_LABEL[wallet.sourceKind]}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-start gap-1">
                <code
                  className="min-w-0 flex-1 rounded-md bg-muted p-2 text-xs break-all"
                  data-private
                >
                  {source}
                </code>
                <CopyButton
                  value={source}
                  label={`Copy ${SOURCE_LABEL[wallet.sourceKind].toLowerCase()}`}
                />
              </div>
              {wallet.sourceKind === "ufvk" && (
                <p className="text-xs text-muted-foreground">
                  Shielded and transparent funds of this key, synced by the zcash-viewer sidecar.
                  {typeof wallet.options.birthdayHeight === "number" &&
                    ` Scanned from block ${wallet.options.birthdayHeight.toLocaleString("en")}.`}
                </p>
              )}
              {typeof wallet.options.scriptType === "string" && (
                <p className="text-xs text-muted-foreground">
                  Address type: <span className="font-mono">{wallet.options.scriptType}</span>
                </p>
              )}
              {explorerAddressUrl && (
                <Link
                  href={explorerAddressUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  View on block explorer <ExternalLink className="size-3" />
                </Link>
              )}
            </CardContent>
          </Card>

          <GroupsCard
            walletId={wallet.id}
            groups={listGroups()}
            memberOf={walletGroupIds(wallet.id)}
          />
        </div>
        <BalancesCard
          balances={walletBalances(wallet.id)}
          prices={spotPrices(coinIds)}
          synced={!!wallet.lastSyncedAt}
        />
      </div>

      <Card className="mt-6">
        <CardHeader className="gap-4">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium">History</CardTitle>
            <a
              href={`/api/export?wallet=${wallet.id}${filters.from ? `&from=${filters.from}` : ""}${filters.to ? `&to=${filters.to}` : ""}`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
              download
            >
              <Download className="size-3.5" /> Export CSV
            </a>
          </div>
          <TxFilters
            assets={walletAssets([wallet.id])}
            values={filters}
            extra={
              hasFilters && (
                <Link
                  href={`/wallets/${wallet.id}`}
                  className="text-sm text-muted-foreground underline-offset-4 hover:underline"
                >
                  Clear
                </Link>
              )
            }
          />
        </CardHeader>
        <CardContent>
          {txs.rows.length === 0 ? (
            <EmptyState
              icon={History}
              title={hasFilters ? "No matching transactions" : "No transactions yet"}
              description={hasFilters ? "Try different filters." : undefined}
            />
          ) : (
            <TxTable
              rows={txs.rows.map((t) => ({
                ...t,
                eurValue: <TxEur value={eurValues.get(t.id) ?? null} />,
                feeDecimals: nativeAsset.decimals,
                feeSymbol: nativeAsset.symbol,
                explorerUrl: adapter.explorerUrl("tx", t.txid),
              }))}
            />
          )}
          <Pagination
            page={Math.min(filters.page, txs.pages)}
            pages={txs.pages}
            total={txs.total}
            hrefFor={(p) => `/wallets/${wallet.id}${txQuery(filters, p)}`}
          />
        </CardContent>
      </Card>
    </>
  );
}
