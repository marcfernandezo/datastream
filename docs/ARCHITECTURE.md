# Datastream: architecture

Watch-only, self-hosted crypto portfolio. Public addresses, extended public keys
(xpub/ypub/zpub) and viewing keys only. **There is no field, type, column or
storage for private keys or seed phrases**, and inputs that look like one
(BIP39 mnemonic, `xprv`/`yprv`/`zprv`, WIF, raw 32-byte hex, Solana keypairs,
Zcash spending keys) are rejected before they touch validation, storage or logs
(`src/server/crypto/secret-guard.ts`).

## Processes

```
┌────────── browser (PWA) ──────────┐
│  UI only. No third-party calls.   │
└──────────────┬────────────────────┘
               │ HTTPS
┌──────────────▼────────────────────┐
│  caddy: TLS, sets X-Forwarded-For │
└──────────────┬────────────────────┘
┌──────────────▼────────────────────┐      ┌───────────────────────────┐
│  web  (Next.js standalone)        │      │  worker  (dist/worker.mjs)│
│  src/proxy.ts: CIDR allowlist,    │      │  job runner:              │
│   nonce CSP, optimistic auth      │      │   wallet.sync / syncAll   │
│  RSC pages + Server Actions       │      │   prices.refresh/daily/   │
│  DAL: authoritative session check │      │     tokenMap              │
│  migrations at startup            │      │   alerts.dispatch         │
└──────────────┬────────────────────┘      │   maintenance.backup/     │
               │                           │     cleanup               │
               └──────────┬────────────────┴───────────┬───────────────┘
                   SQLite (WAL) on /data               │
                                                       ▼
          Esplora · Etherscan/Alchemy · Solana RPC/Helius · Blockchair · CoinGecko · ntfy/Telegram
                                                       │
                                  ┌────────────────────▼──────────────────────┐
                                  │  zcash-viewer (optional, Rust)            │
                                  │  view-only UFVK accounts, SQLCipher DB,   │
                                  │  sync loop ──gRPC/TLS──▶ lightwalletd     │
                                  └───────────────────────────────────────────┘
```

- The **web** process renders from SQLite only. "Sync now" enqueues a job.
  The only outbound calls from web are alert _test_ messages.
- The **worker** shares the codebase, bundled with esbuild. Jobs live in the
  `jobs` table (dedup keys, exponential backoff, recovery after restart).

## Network adapters

`src/server/chains/types.ts`:

```ts
interface ChainAdapter {
  network: NetworkId;
  nativeAsset: AssetInfo;
  supportedSources: SourceKind[];
  initialMaxPages?: number;
  parseSource(kind, input, options): ParsedSource;
  getBalance(ctx, src): Promise<AssetAmount[]>;
  getTokens(ctx, src): Promise<AssetAmount[]>;
  getTransactions(ctx, src, { knownTxids, maxPages }): Promise<NormalizedTx[]>;
  explorerUrl(kind, id): string;
  displaySource?(src): string;
}
```

| Net | Sources           | Provider                                                                         |
| --- | ----------------- | -------------------------------------------------------------------------------- |
| BTC | address, x/y/zpub | Esplora. Receive + change scan with gap limit; script-type auto-detect for xpubs |
| ETH | address           | Etherscan v2 or Alchemy: ETH, internal txs, ERC-20, fees                         |
| SOL | address           | JSON-RPC (Helius DAS optional): SOL, SPL, fees                                   |
| ZEC | t1/t3/tex, UFVK   | Transparent: Blockchair-compatible API. UFVK: zcash-viewer sidecar (below)       |

Adapters may throw `SyncPendingError` when the provider can't answer completely
yet. The sync is then deferred (`RetryLaterError`, no attempt used), only the
progress note and adapter state are saved, and no partial history is stored.
`forget(state)` runs in the worker after a wallet is deleted.

### Shielded Zcash sidecar

`sidecars/zcash-viewer` (Rust, axum, `zcash_client_backend` 0.25 /
`zcash_client_sqlite` 0.23):

- `POST /v1/accounts {ufvk, birthdayHeight?}` imports the key as a view-only
  account (idempotent; the birthday tree state comes from lightwalletd).
  `GET /v1/accounts/:id` returns balance, readiness and progress.
  `GET /v1/accounts/:id/transactions` returns net deltas and fees.
  `DELETE /v1/accounts/:id` removes the account. All routes need the bearer token.
- Sync loop: `zcash_client_backend::sync::run` with an in-memory block cache, then
  the wallet's transaction data requests (full transactions for fees and sent
  outputs, transparent address history), then block times for blocks it never
  scanned. An account becomes ready, and stays ready, after the first pass that
  leaves no scan range pending.
- The wallet DB is SQLCipher with a raw 256-bit key. Library logs are kept at warn
  so heights, ranges and addresses don't reach stdout.
- The worker's adapter (`src/server/chains/zcash/shielded.ts`) re-imports on every
  sync, so a wiped sidecar volume heals itself (with a rescan).

Amounts are `bigint` base units in code and `TEXT` in SQLite. A transaction's
`movements` are the net change per asset for the wallet, excluding the fee.

## Data model

`wallets` (encrypted source, HMAC fingerprint, adapter `sync_state`), `groups`,
`wallet_groups`, `assets` (CoinGecko id, user `hidden` override), `balances`,
`transactions`, `tx_movements`, `price_spot`, `price_daily`, `token_map`,
`portfolio_snapshots` (live hourly + backfilled daily), `alert_channels`
(encrypted config), `alert_log` (one row per channel and tx), `jobs`, `sessions`,
`settings`.

Envelope format: `v1.<kid>.<iv>.<ciphertext+tag>`, AES-256-GCM with
HKDF-derived subkeys and per-purpose AAD. Backups use their own HKDF subkey.

## Security

See the threat model in the README. Summary:

- Argon2id password; opaque session tokens (SHA-256 stored); idle and absolute
  expiry; `__Host-` cookie with `HttpOnly; Secure; SameSite=Strict`.
- `proxy.ts`: CIDR allowlist (fails closed unless a trusted proxy sets the
  client IP), nonce CSP, HSTS, `no-store`; every page, action and route also
  calls the DAL.
- Rate limiting: login per IP and globally, mutations, exports.
- Log masking of addresses, extended keys, viewing keys, txids; URL credential
  redaction.
- Service worker caches only static assets and the offline page.
