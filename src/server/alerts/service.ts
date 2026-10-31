import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/env";
import { sharedHttp } from "@/server/chains/registry";
import { AAD, open, seal } from "@/server/crypto/keyring";
import { db, schema } from "@/server/db/client";
import { logger } from "@/server/log/logger";
import { maskSensitive } from "@/server/log/mask";
import { txEurValues } from "@/server/portfolio/queries";
import { formatEur, formatUnits } from "@/lib/format";
import {
  channelConfigSchema,
  describeChannel,
  sendAlert,
  type AlertMessage,
  type ChannelConfig,
} from "./channels";

export const channelInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  config: channelConfigSchema,
  scope: z
    .object({ walletIds: z.array(z.uuid()).max(500), groupIds: z.array(z.uuid()).max(100) })
    .nullable(),
  minEur: z.coerce.number().min(0).max(1e9).default(0),
});

export type ChannelInput = z.input<typeof channelInputSchema>;

export function createChannel(raw: ChannelInput) {
  const data = channelInputSchema.parse(raw);
  const id = randomUUID();
  db()
    .insert(schema.alertChannels)
    .values({
      id,
      name: data.name,
      kind: data.config.kind,
      configEnc: seal(JSON.stringify(data.config), AAD.alertChannel),
      scope: data.scope,
      minEur: data.minEur,
    })
    .run();
  logger.info({ channelId: id, kind: data.config.kind }, "alert channel created");
  return { id };
}

export function deleteChannel(id: string) {
  db().delete(schema.alertChannels).where(eq(schema.alertChannels.id, id)).run();
}

export function setChannelEnabled(id: string, enabled: boolean) {
  db().update(schema.alertChannels).set({ enabled }).where(eq(schema.alertChannels.id, id)).run();
}

function channelConfig(row: typeof schema.alertChannels.$inferSelect): ChannelConfig {
  return channelConfigSchema.parse(JSON.parse(open(row.configEnc, AAD.alertChannel)));
}

/** Channels for the settings UI: no secrets, only a masked description. */
export function listChannels() {
  return db()
    .select()
    .from(schema.alertChannels)
    .all()
    .map((c) => {
      let target = "unreadable (check DATASTREAM_ENC_KEY)";
      let hideAmounts = false;
      try {
        const cfg = channelConfig(c);
        target = describeChannel(cfg);
        hideAmounts = cfg.hideAmounts;
      } catch {
        // Shown in the UI; a key mismatch shouldn't break the page.
      }
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        enabled: c.enabled,
        scope: c.scope,
        minEur: c.minEur,
        target,
        hideAmounts,
      };
    });
}

function link(path: string) {
  const base = env().PUBLIC_URL;
  return base ? `${base.replace(/\/$/, "")}${path}` : undefined;
}

export async function sendTestAlert(id: string) {
  const row = db().select().from(schema.alertChannels).where(eq(schema.alertChannels.id, id)).get();
  if (!row) throw new Error("Channel not found");
  await sendAlert(sharedHttp(), channelConfig(row), {
    title: "Datastream test",
    body: "Alerts are working. You'll be notified about new transactions.",
    link: link("/alerts"),
    tags: ["white_check_mark"],
  });
}

interface TxForAlert {
  id: number;
  walletId: string;
  walletLabel: string;
  direction: "in" | "out" | "self" | "swap";
  status: "pending" | "confirmed" | "failed";
  blockTime: number | null;
  movements: { amount: string; decimals: number; symbol: string; coingeckoId: string | null }[];
}

const VERB = { in: "Received", out: "Sent", swap: "Swap", self: "Internal transfer" } as const;
const TAG = {
  in: "inbox_tray",
  out: "outbox_tray",
  swap: "left_right_arrow",
  self: "repeat",
} as const;

/** Builds the notification text. Contains no addresses or txids, by design. */
export function formatAlert(
  tx: TxForAlert,
  eur: number | null,
  hideAmounts: boolean,
): AlertMessage {
  const verb = VERB[tx.direction];
  const pending = tx.status === "pending" ? " (unconfirmed)" : "";
  let body: string;
  if (hideAmounts || tx.movements.length === 0) {
    body = `${verb}${pending} on ${tx.walletLabel}`;
  } else {
    const parts = tx.movements.map((m) => {
      const v = formatUnits(m.amount, m.decimals, 8);
      return `${v.startsWith("-") ? v : `+${v}`} ${m.symbol}`;
    });
    const value = eur === null ? "" : ` (≈ ${formatEur(Math.abs(eur))})`;
    body = `${verb}${pending} on ${tx.walletLabel}: ${parts.join(", ")}${value}`;
  }
  return {
    title: `Datastream · ${tx.walletLabel}`,
    body: maskSensitive(body),
    link: link(`/wallets/${tx.walletId}`),
    tags: [TAG[tx.direction]],
  };
}

function loadTxs(txIds: number[]): TxForAlert[] {
  if (txIds.length === 0) return [];
  const rows = db()
    .select({
      id: schema.transactions.id,
      walletId: schema.transactions.walletId,
      walletLabel: schema.wallets.label,
      direction: schema.transactions.direction,
      status: schema.transactions.status,
      blockTime: schema.transactions.blockTime,
    })
    .from(schema.transactions)
    .innerJoin(schema.wallets, eq(schema.wallets.id, schema.transactions.walletId))
    .where(inArray(schema.transactions.id, txIds))
    .all();
  const movements = db()
    .select({
      txId: schema.txMovements.txId,
      amount: schema.txMovements.amount,
      decimals: schema.assets.decimals,
      symbol: schema.assets.symbol,
      coingeckoId: schema.assets.coingeckoId,
      contract: schema.assets.contract,
      hidden: schema.assets.hidden,
    })
    .from(schema.txMovements)
    .innerJoin(schema.assets, eq(schema.assets.id, schema.txMovements.assetId))
    .where(inArray(schema.txMovements.txId, txIds))
    .all();
  return rows.map((r) => ({
    ...r,
    // Spam tokens (unpriced/hidden) never trigger or appear in alerts.
    movements: movements.filter(
      (m) =>
        m.txId === r.id &&
        m.hidden !== true &&
        (m.contract === null || m.coingeckoId !== null || m.hidden === false),
    ),
  }));
}

function walletsInScope(
  scope: { walletIds: string[]; groupIds: string[] } | null,
): Set<string> | null {
  if (!scope) return null;
  const ids = new Set(scope.walletIds);
  if (scope.groupIds.length) {
    for (const r of db()
      .select({ walletId: schema.walletGroups.walletId })
      .from(schema.walletGroups)
      .where(inArray(schema.walletGroups.groupId, scope.groupIds))
      .all()) {
      ids.add(r.walletId);
    }
  }
  return ids;
}

/**
 * Sends alerts for new transactions to every matching channel. Idempotent:
 * alert_log has one row per (channel, tx), so retries never double-notify.
 * Throws if any delivery failed, so the job retries just the failures.
 */
export async function dispatchAlerts(txIds: number[], signal?: AbortSignal) {
  const channels = db()
    .select()
    .from(schema.alertChannels)
    .where(eq(schema.alertChannels.enabled, true))
    .all();
  if (channels.length === 0 || txIds.length === 0) return { sent: 0, failed: 0 };

  const txs = loadTxs(txIds).filter((t) => t.status !== "failed");
  const values = txEurValues(txs);
  let sent = 0;
  let failed = 0;

  for (const ch of channels) {
    let cfg: ChannelConfig;
    try {
      cfg = channelConfig(ch);
    } catch {
      logger.error({ channelId: ch.id }, "cannot decrypt alert channel");
      continue;
    }
    const scope = walletsInScope(ch.scope);
    const done = new Set(
      db()
        .select({ txId: schema.alertLog.txId })
        .from(schema.alertLog)
        .where(
          and(
            eq(schema.alertLog.channelId, ch.id),
            inArray(schema.alertLog.status, ["sent", "skipped"]),
          ),
        )
        .all()
        .map((r) => r.txId),
    );

    for (const tx of txs) {
      if (done.has(tx.id) || (scope && !scope.has(tx.walletId))) continue;
      const eur = values.get(tx.id) ?? null;
      const record = (status: "sent" | "failed" | "skipped", error: string | null = null) =>
        db()
          .insert(schema.alertLog)
          .values({ channelId: ch.id, txId: tx.id, status, error })
          .onConflictDoUpdate({
            target: [schema.alertLog.channelId, schema.alertLog.txId],
            set: { status, error },
          })
          .run();

      // Below the threshold (unpriced txs always notify), or spam-only/no-op txs.
      if (
        tx.movements.length === 0 ||
        (ch.minEur > 0 && eur !== null && Math.abs(eur) < ch.minEur)
      ) {
        record("skipped");
        continue;
      }
      try {
        await sendAlert(sharedHttp(), cfg, formatAlert(tx, eur, cfg.hideAmounts), signal);
        record("sent");
        sent++;
      } catch (err) {
        const message = err instanceof Error ? err.message : "delivery failed";
        record("failed", message.slice(0, 200));
        failed++;
        logger.warn({ channelId: ch.id, txId: tx.id, err: message }, "alert delivery failed");
      }
    }
  }
  if (failed > 0) throw new Error(`${failed} alert(s) failed to deliver`);
  return { sent, failed };
}
