CREATE TABLE `token_map` (
	`network` text NOT NULL,
	`contract` text NOT NULL,
	`coingecko_id` text NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`network`, `contract`)
);
