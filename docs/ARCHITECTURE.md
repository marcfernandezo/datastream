# Watchtower — Architecture

Watch-only, self-hosted crypto portfolio dashboard. Public addresses, extended
public keys (xpub/ypub/zpub) and viewing keys (UFVK) only. **There is no field,
type, column or storage for private keys or seed phrases**, and inputs that look
like one (BIP39 mnemonic, `xprv`/`yprv`/`zprv`, raw 32-byte hex, Solana keypair
arrays) are rejected outright.

## Processes

```
┌────────── browser (PWA) ──────────┐
│  UI only. No third-party calls.   │
└──────────────┬────────────────────┘
               │ HTTPS (Tailscale / LAN reverse proxy)
┌──────────────▼────────────────────┐      ┌───────────────────────────┐
│  web  (next start, standalone)    │      │  worker  (same codebase)  │
│  proxy.ts: CIDR allowlist, CSP,   │      │  scheduler loop:          │
│            optimistic auth check  │      │   • sync wallets          │
│  RSC + Server Actions + routes    │      │   • refresh prices        │
│  DAL: authoritative session check │      │   • portfolio snapshots   │
└──────────────┬────────────────────┘      │   • new tx → alerts       │
               │                           │   • SQLite backups        │
               └──────────┬────────────────┴───────────┬───────────────┘
                   SQLite (WAL) on /data volume        │
                                                       ▼
                 Esplora · Etherscan/Alchemy · Helius/RPC · CoinGecko
                 ntfy/Telegram · (P7) lightwalletd via zcash sidecar
```

- The **web** process never calls third-party APIs while rendering; it reads
  SQLite. "Sync now" only enqueues a job row the worker picks up.
- The **worker** is a separate Node process built from the same sources
  (`src/worker.ts`). It is the only process with outbound network access to
  chain/price providers (enforceable at the Docker network level).

## Network adapters

```ts
interface ChainAdapter {
  network: NetworkId;
  nativeAsset: AssetRef;
  supportedSources: SourceKind[];
  validate(src: WalletSource): ValidationResult;
  getBalance(ctx, src): Promise<AssetAmount[]>;
  getTokens(ctx, src): Promise<TokenBalance[]>;
  getTransactions(ctx, src, cursor?): Promise<TxPage>;
  explorerUrl(kind: "tx" | "address", id: string): string;
}
```

Amounts are `bigint` base units in code and `TEXT` in SQLite. They are only
converted to decimals at the presentation edge.

Adding a network = new folder under `src/server/chains/<net>/`, an entry in
`registry.ts`, env vars in `src/env.ts`. See README → "Adding a network".

| Net | Sources           | Provider                                      |
| --- | ----------------- | --------------------------------------------- |
| BTC | address, x/y/zpub | Esplora (mempool.space default), gap limit 20 |
| ETH | address           | Etherscan v2 (default) or Alchemy             |
| SOL | address           | Helius or plain JSON-RPC                      |
| ZEC | t-addr, UFVK (P7) | explorer API; Rust sidecar ↔ lightwalletd     |

## Data model

`wallets`, `groups`, `wallet_groups`, `derived_addresses`, `assets`,
`balances`, `transactions`, `tx_movements`, `prices`, `portfolio_snapshots`,
`sessions`, `settings`, `alert_channels`, `alert_log`, `jobs`, `sync_runs`.

Sensitive values (xpub, UFVK, alert channel secrets) are stored as AES-256-GCM
envelopes `v1.<kid>.<iv>.<ct+tag>` keyed by `WATCHTOWER_ENC_KEY`. Wallet
dedup uses an HMAC fingerprint, so the plaintext is never needed to check
uniqueness.

## Security

- Argon2id password and opaque session tokens (only the SHA-256 hash is stored),
  `HttpOnly; SameSite=Strict; Secure` cookie, idle and absolute expiry.
- `proxy.ts`: CIDR allowlist (`ALLOWED_CIDRS`), nonce-based CSP and security
  headers, optimistic cookie check. Every page, action and route still
  calls `verifySession()` in the DAL.
- In-memory token-bucket rate limiting (login is strict).
- pino logger with address/xpub masking; tested.
- No telemetry: `NEXT_TELEMETRY_DISABLED=1`, no analytics, fonts bundled at build.

## Delivery phases

1. Plan & architecture (this doc)
2. Base + auth + DB
3. BTC, ETH, SOL adapters + wallet CRUD + sync
4. Prices + dashboard + privacy mode + PWA
5. Alerts + groups + CSV export
6. Tests, Docker, CI, docs
7. Zcash (transparent, then shielded sidecar)
