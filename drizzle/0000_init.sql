CREATE TABLE `alert_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config_enc` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`scope` text,
	`min_eur` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alert_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`tx_id` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `alert_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tx_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_log_channel_tx_uq` ON `alert_log` (`channel_id`,`tx_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`network` text NOT NULL,
	`contract` text,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`decimals` integer NOT NULL,
	`coingecko_id` text,
	`hidden` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assets_coingecko_idx` ON `assets` (`coingecko_id`);--> statement-breakpoint
CREATE TABLE `balances` (
	`wallet_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`amount` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`wallet_id`, `asset_id`),
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'slate' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_name_unique` ON `groups` (`name`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`key` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_after` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`error` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status_run_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `jobs_key_idx` ON `jobs` (`key`);--> statement-breakpoint
CREATE TABLE `portfolio_snapshots` (
	`ts` integer PRIMARY KEY NOT NULL,
	`total_eur` real NOT NULL,
	`by_asset` text NOT NULL,
	`source` text DEFAULT 'live' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `price_daily` (
	`coingecko_id` text NOT NULL,
	`day` integer NOT NULL,
	`eur` real NOT NULL,
	PRIMARY KEY(`coingecko_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `price_spot` (
	`coingecko_id` text PRIMARY KEY NOT NULL,
	`eur` real NOT NULL,
	`change_24h` real,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text
);
--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wallet_id` text NOT NULL,
	`network` text NOT NULL,
	`txid` text NOT NULL,
	`block_time` integer,
	`block_height` integer,
	`status` text NOT NULL,
	`direction` text NOT NULL,
	`fee` text,
	`first_seen_at` integer NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tx_wallet_txid_uq` ON `transactions` (`wallet_id`,`txid`);--> statement-breakpoint
CREATE INDEX `tx_wallet_time_idx` ON `transactions` (`wallet_id`,`block_time`);--> statement-breakpoint
CREATE TABLE `tx_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tx_id` integer NOT NULL,
	`asset_id` text NOT NULL,
	`amount` text NOT NULL,
	FOREIGN KEY (`tx_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `txm_tx_idx` ON `tx_movements` (`tx_id`);--> statement-breakpoint
CREATE INDEX `txm_asset_idx` ON `tx_movements` (`asset_id`);--> statement-breakpoint
CREATE TABLE `wallet_groups` (
	`wallet_id` text NOT NULL,
	`group_id` text NOT NULL,
	PRIMARY KEY(`wallet_id`, `group_id`),
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`network` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_enc` text NOT NULL,
	`fingerprint` text NOT NULL,
	`display_hint` text NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`sync_state` text DEFAULT '{}' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`initial_sync_done` integer DEFAULT false NOT NULL,
	`last_synced_at` integer,
	`last_sync_error` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallets_fingerprint_uq` ON `wallets` (`fingerprint`);