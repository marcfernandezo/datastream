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
          Esplora · Etherscan/Alchemy · Solana RPC/Helius · CoinGecko · ntfy/Telegram
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
| ZEC | (phase 7)         | Explorer API for t-addrs; UFVK via a sidecar and lightwalletd                    |

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
