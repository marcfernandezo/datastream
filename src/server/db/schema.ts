import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/*
 * Amounts are stored as TEXT holding a base-unit integer (satoshis, wei,
 * lamports…). Never floats. EUR values are display data and use REAL.
 *
 * There is deliberately no column anywhere for private keys or seeds.
 */

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`),
});

export const sessions = sqliteTable(
  "sessions",
  {
    /** SHA-256 of the session token. The token itself is never stored. */
    id: text("id").primaryKey(),
    createdAt: createdAt(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_expires_idx").on(t.expiresAt)],
);

export const wallets = sqliteTable(
  "wallets",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    network: text("network").notNull(),
    sourceKind: text("source_kind", { enum: ["address", "xpub", "ufvk"] }).notNull(),
    /** AES-GCM envelope of the canonical source (address / xpub / viewing key). */
    sourceEnc: text("source_enc").notNull(),
    /** HMAC of network+source for dedup without decrypting. */
    fingerprint: text("fingerprint").notNull(),
    /** Pre-masked form for display, e.g. `bc1q…x7f2`. */
    displayHint: text("display_hint").notNull(),
    /** BTC xpub script type or other network-specific options (JSON). */
    options: text("options", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Adapter-owned sync cursor (JSON), e.g. BTC gap-limit high-water marks. */
    syncState: text("sync_state", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    initialSyncDone: integer("initial_sync_done", { mode: "boolean" }).notNull().default(false),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
    lastSyncError: text("last_sync_error"),
    /** Progress while a sync is deferred (e.g. "Scanning shielded history 43%"). */
    syncNote: text("sync_note"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("wallets_fingerprint_uq").on(t.fingerprint)],
);

export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("slate"),
  createdAt: createdAt(),
});

export const walletGroups = sqliteTable(
  "wallet_groups",
  {
    walletId: text("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.walletId, t.groupId] })],
);

export const assets = sqliteTable(
  "assets",
  {
    /** `btc`, `eth`, `sol`, `zec`, or `<network>:<contract|mint>`. */
    id: text("id").primaryKey(),
    network: text("network").notNull(),
    contract: text("contract"),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    decimals: integer("decimals").notNull(),
    coingeckoId: text("coingecko_id"),
    /** null = auto (hidden if unpriced), true/false = user override. */
    hidden: integer("hidden", { mode: "boolean" }),
    createdAt: createdAt(),
  },
  (t) => [index("assets_coingecko_idx").on(t.coingeckoId)],
);

export const balances = sqliteTable(
  "balances",
  {
    walletId: text("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id),
    amount: text("amount").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.walletId, t.assetId] })],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    walletId: text("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "cascade" }),
    network: text("network").notNull(),
    txid: text("txid").notNull(),
    /** Unix seconds; null while pending. */
    blockTime: integer("block_time"),
    blockHeight: integer("block_height"),
    status: text("status", { enum: ["pending", "confirmed", "failed"] }).notNull(),
    direction: text("direction", { enum: ["in", "out", "self", "swap"] }).notNull(),
    /** Fee paid by this wallet in the native asset's base units, if any. */
    fee: text("fee"),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("tx_wallet_txid_uq").on(t.walletId, t.txid),
    index("tx_wallet_time_idx").on(t.walletId, t.blockTime),
  ],
);

export const txMovements = sqliteTable(
  "tx_movements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    txId: integer("tx_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id),
    /** Signed net delta for this wallet, base units (excludes fee). */
    amount: text("amount").notNull(),
  },
  (t) => [index("txm_tx_idx").on(t.txId), index("txm_asset_idx").on(t.assetId)],
);

export const priceSpot = sqliteTable("price_spot", {
  coingeckoId: text("coingecko_id").primaryKey(),
  eur: real("eur").notNull(),
  change24h: real("change_24h"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const priceDaily = sqliteTable(
  "price_daily",
  {
    coingeckoId: text("coingecko_id").notNull(),
    /** UTC day number (unix seconds / 86400). */
    day: integer("day").notNull(),
    eur: real("eur").notNull(),
  },
  (t) => [primaryKey({ columns: [t.coingeckoId, t.day] })],
);

export const portfolioSnapshots = sqliteTable("portfolio_snapshots", {
  /** Unix seconds, truncated to the hour. */
  ts: integer("ts").primaryKey(),
  totalEur: real("total_eur").notNull(),
  /** { [assetId]: eur } */
  byAsset: text("by_asset", { mode: "json" }).$type<Record<string, number>>().notNull(),
  source: text("source", { enum: ["live", "backfill"] })
    .notNull()
    .default("live"),
});

export const alertChannels = sqliteTable("alert_channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["ntfy", "telegram"] }).notNull(),
  /** AES-GCM envelope of the channel config (topic URL, bot token, chat id…). */
  configEnc: text("config_enc").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** null = all wallets; otherwise explicit wallet/group ids. */
  scope: text("scope", { mode: "json" }).$type<{
    walletIds: string[];
    groupIds: string[];
  } | null>(),
  minEur: real("min_eur").notNull().default(0),
  createdAt: createdAt(),
});

export const alertLog = sqliteTable(
  "alert_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: text("channel_id")
      .notNull()
      .references(() => alertChannels.id, { onDelete: "cascade" }),
    txId: integer("tx_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["sent", "failed", "skipped"] }).notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("alert_log_channel_tx_uq").on(t.channelId, t.txId)],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),
    /** Optional dedup key: only one queued/running job per key. */
    key: text("key"),
    payload: text("payload", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text("status", { enum: ["queued", "running", "done", "failed"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: integer("run_after", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("jobs_status_run_idx").on(t.status, t.runAfter), index("jobs_key_idx").on(t.key)],
);

/** CoinGecko's platform listing: token contract/mint → coin id. Refreshed daily. */
export const tokenMap = sqliteTable(
  "token_map",
  {
    network: text("network").notNull(),
    /** Lowercase for EVM, case-sensitive base58 for Solana. */
    contract: text("contract").notNull(),
    coingeckoId: text("coingecko_id").notNull(),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.network, t.contract] })],
);
