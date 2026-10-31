import type { Metadata } from "next";
import { Bell } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { env } from "@/env";
import { listChannels } from "@/server/alerts/service";
import { verifySession } from "@/server/auth/dal";
import { listGroups } from "@/server/wallets/groups";
import { listWallets } from "@/server/wallets/queries";
import { AddChannelDialog } from "./add-channel-dialog";
import { ChannelRow } from "./channel-row";

export const metadata: Metadata = { title: "Alerts" };

export default async function AlertsPage() {
  await verifySession();
  const channels = listChannels();
  const wallets = listWallets({ includeArchived: true }).map((w) => ({ id: w.id, label: w.label }));
  const groups = listGroups().map((g) => ({ id: g.id, label: g.name }));
  const names = new Map([...wallets, ...groups].map((o) => [o.id, o.label]));
  const add = <AddChannelDialog wallets={wallets} groups={groups} />;

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Get notified about new transactions on your wallets via ntfy or Telegram."
        actions={channels.length > 0 ? add : undefined}
      />
      {!env().PUBLIC_URL && channels.length > 0 && (
        <p className="mb-4 text-xs text-muted-foreground">
          Tip: set <code>PUBLIC_URL</code> so notifications link back to the wallet.
        </p>
      )}
      {channels.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No alert channels yet"
          description="Alerts fire for new incoming and outgoing transactions after a wallet's first sync."
          action={add}
        />
      ) : (
        <Card>
          <CardContent>
            <ul className="divide-y">
              {channels.map((c) => {
                const scopeLabel = c.scope
                  ? [...c.scope.groupIds, ...c.scope.walletIds]
                      .map((id) => names.get(id) ?? "deleted")
                      .join(", ")
                  : "All wallets";
                return (
                  <ChannelRow
                    key={c.id}
                    channel={{
                      id: c.id,
                      name: c.name,
                      kind: c.kind,
                      enabled: c.enabled,
                      target: c.target,
                      scopeLabel,
                      minEur: c.minEur,
                      hideAmounts: c.hideAmounts,
                    }}
                  />
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
