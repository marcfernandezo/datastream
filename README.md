# Datastream

A self-hosted, **watch-only** crypto portfolio for a Raspberry Pi or home mini PC.
See balances, history and the EUR value of your Bitcoin, Ethereum, Solana and
Zcash wallets without opening Ledger Live or exposing any keys.

- **Watch-only by construction.** Only public addresses, extended public keys
  (xpub/ypub/zpub) and viewing keys. There is no field, column or code path for
  private keys or seed phrases, and inputs that look like one are rejected.
- **Private by default.** Every third-party request originates from your server,
  never the browser. No analytics or telemetry. Logs mask addresses and keys.
  xpubs, viewing keys and alert secrets are encrypted at rest.
- **Networks:** Bitcoin (addresses + xpub/ypub/zpub, gap-limit scanning),
  Ethereum (ETH + ERC-20 via Etherscan or Alchemy), Solana (SOL + SPL via any
  RPC or Helius), Zcash transparent addresses (t1/t3/TEX via a Blockchair-compatible
  API) and, optionally, shielded Zcash from a Unified Full Viewing Key via a Rust
  light-client sidecar (see [Shielded Zcash](#shielded-zcash)).
- **Dashboard:** total value in EUR, 24h/7d/30d change, performance chart,
  allocation by asset and network, per-wallet history with filters, explorer
  links, CSV export, groups, privacy mode (`H`), alerts via ntfy or Telegram,
  dark mode, installable PWA.

---

## Contents

- [Quick start (development)](#quick-start-development)
- [Deploying on a Pi / mini PC](#deploying-on-a-pi--mini-pc)
- [Configuration](#configuration)
- [Shielded Zcash](#shielded-zcash)
- [Operations](#operations): CLI, backups, restore, key rotation, upgrades
- [Threat model](#threat-model)
- [Architecture](#architecture)
- [Adding a network](#adding-a-network)
- [Testing](#testing)
- [Limitations](#limitations)

---

## Quick start (development)

Requirements: Node 24+, pnpm (via `corepack enable`).

```bash
pnpm install
cp .env.example .env
pnpm ds gen-key            # paste the output into DATASTREAM_ENC_KEY in .env
# Set SETUP_TOKEN in .env to any long random string, and COOKIE_SECURE=false for http://localhost.

pnpm dev                   # web UI on http://localhost:3000
pnpm dev:worker            # background sync, prices, alerts, backups (second terminal)
```

Open http://localhost:3000, paste the `SETUP_TOKEN` and choose a password (12+ characters).
Alternatively, `pnpm ds set-password` sets it from the terminal.

---

## Deploying on a Pi / mini PC

Datastream runs as three containers: **web** (Next.js), **worker** (sync and jobs) and
**caddy** (TLS + reverse proxy), plus an optional fourth, **zcash-viewer**, for
shielded Zcash. The images are multi-arch (arm64 and amd64), and a
Raspberry Pi 4/5 with 2 GB+ RAM is plenty.

```bash
git clone https://github.com/marcfernandezo/datastream && cd datastream
cp .env.example .env
docker run --rm node:24-slim node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
#   → DATASTREAM_ENC_KEY=<that value>
#   → SETUP_TOKEN=<any long random string>
#   → ETHERSCAN_API_KEY=… (free key from etherscan.io), optional COINGECKO_API_KEY

mkdir -p data && sudo chown 1000:1000 data     # the container runs as uid 1000
DATASTREAM_DOMAIN=datastream.local docker compose up -d --build
```

Then open `https://datastream.local` (or whatever name resolves to the box) and complete
setup with your `SETUP_TOKEN`. Remove `SETUP_TOKEN` from `.env` afterwards.

> **Back up `DATASTREAM_ENC_KEY` separately** (e.g. in your password manager).
> Without it, encrypted xpubs, alert secrets and backups can't be recovered.

### Access options

Pick one. In every case the app's own password stays on unless you deliberately
choose `AUTH_MODE=network-only`.

**A. LAN only, Caddy's internal CA (default).** `DATASTREAM_TLS=internal` makes Caddy
issue a certificate from its local CA. Trust it on your devices once:

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./datastream-root.crt
```

Then install it as a trusted root on your phone and laptop. Restrict access to your
LAN (and Tailscale) in `.env`:

```env
ALLOWED_CIDRS=192.168.0.0/16,10.0.0.0/8,100.64.0.0/10,fd7a:115c:a1e0::/48
```

**B. Tailscale.** Install Tailscale on the host, keep Caddy's ports closed on the LAN
firewall, and either use option A over the tailnet, or let Tailscale terminate TLS
(`tailscale serve --https=443 http://127.0.0.1:8080`) after publishing the `web`
service on `127.0.0.1:8080` in a `compose.override.yml`. Keep `TRUST_PROXY=true` in
both cases.

**C. Plain HTTP on a trusted LAN (not recommended).** Publish `web:3000` directly,
set `COOKIE_SECURE=false`, `TRUST_PROXY=false` and leave `ALLOWED_CIDRS` empty.
Datastream refuses to start with an IP allowlist that it can't enforce safely.

Never expose Datastream to the public internet. It is a single-user, home-network app.

---

## Configuration

Every setting is documented in [`.env.example`](.env.example) and validated with Zod at
startup. A bad value stops the process with a readable error. The main ones:

| Variable                                                  | Purpose                                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `DATASTREAM_ENC_KEY`                                      | **Required.** 32 random bytes (base64). Encrypts xpubs, viewing keys, alert secrets, backups. |
| `SETUP_TOKEN`                                             | One-time token for the `/setup` page.                                                         |
| `AUTH_MODE`                                               | `password` (default) or `network-only` (requires `ALLOWED_CIDRS`).                            |
| `ALLOWED_CIDRS` / `TRUST_PROXY`                           | IP allowlist, enforced via the proxy's `X-Forwarded-For`.                                     |
| `BTC_ESPLORA_URL` / `BTC_ESPLORA_RPS`                     | Any Esplora API. Point at your own mempool/electrs for privacy, and raise the RPS.            |
| `ETH_PROVIDER` + `ETHERSCAN_API_KEY` or `ALCHEMY_API_KEY` | Ethereum data source.                                                                         |
| `SOL_PROVIDER` + `SOL_RPC_URL` or `HELIUS_API_KEY`        | Solana data source.                                                                           |
| `ZEC_EXPLORER_API_URL` / `ZEC_EXPLORER_API_KEY`           | Zcash transparent addresses (Blockchair-compatible API).                                      |
| `ZCASH_VIEWER_*` / `LIGHTWALLETD_URL`                     | Shielded Zcash sidecar (optional). See [Shielded Zcash](#shielded-zcash).                     |
| `COINGECKO_API_KEY` / `COINGECKO_API_TIER`                | Optional CoinGecko demo/pro key.                                                              |
| `PUBLIC_URL`                                              | Your Datastream URL, used for links in alerts.                                                |
| `SYNC_INTERVAL_MINUTES` / `PRICE_INTERVAL_MINUTES`        | Background schedule.                                                                          |
| `BACKUP_*`                                                | Backup location, retention, encryption, hour.                                                 |

---

## Shielded Zcash

Shielded balances need trial decryption of every block, which no JavaScript library
does reliably, so it runs in a small, separate Rust service: **zcash-viewer**
([`sidecars/zcash-viewer`](sidecars/zcash-viewer)). It's built on ECC's
`zcash_client_backend` / `zcash_client_sqlite`, the same crates as Zashi.

- You paste a **Unified Full Viewing Key** (`uview1…`). Datastream stores it encrypted
  like an xpub, and the worker hands it to the sidecar, which imports it as a
  **view-only** account. There are no spending keys, proving parameters or transaction
  building anywhere in the sidecar.
- The sidecar syncs from a `lightwalletd` server and decrypts locally. The server never
  sees the viewing key. Balances include the key's Sapling, Orchard and transparent
  funds, so don't also add its transparent addresses separately.
- Its wallet database (viewing keys + decrypted history) is **SQLCipher-encrypted**
  with `ZCASH_VIEWER_DB_KEY`. It only listens on the compose network, behind a bearer
  token, and never receives `DATASTREAM_ENC_KEY`.
- Nothing is stored in Datastream until the account's first scan is complete. Until
  then the wallet shows "Scanning shielded history…", so old transactions never fire
  alerts. Deleting the wallet removes the key from the sidecar too.

**Enable it:**

```bash
# in .env
ZCASH_VIEWER_URL=http://zcash-viewer:8232
ZCASH_VIEWER_TOKEN=$(openssl rand -hex 32)
ZCASH_VIEWER_DB_KEY=$(openssl rand -base64 32)
# optional: your own server, e.g. https://lightwalletd.lan:9067 (or http:// on a LAN)
LIGHTWALLETD_URL=https://zec.rocks:443

docker compose --profile zcash up -d --build
```

The first image build compiles Rust and takes a while (on a Pi, pull a prebuilt image
or build on a faster machine with `docker buildx --platform linux/arm64`).

**Wallet birthday.** When adding the key, give the date the wallet was created (or a
block height). Scanning starts there. Left blank, it starts at Orchard activation (May
2022), which crosses the 2022–23 spam period and can take hours on a Pi. Too late a
birthday misses older funds: delete the wallet and add it again with an earlier date.

**Operations.** The sidecar's volume (`zcash_data`) is a cache that can be rebuilt from
the chain, since the keys live in Datastream's database. It isn't part of the backups.
To rescan from scratch: `docker compose --profile zcash down`, `docker volume rm
datastream_zcash_data`, start again. Keep `ZCASH_VIEWER_DB_KEY` stable: a new key
can't open the old volume (remove the volume, as above, to start over).

---

## Operations

All commands run inside the container (or with `pnpm ds …` in development):

```bash
docker compose exec web node dist/cli.mjs <command>
```

| Command                           | What it does                                                              |
| --------------------------------- | ------------------------------------------------------------------------- |
| `gen-key`                         | Prints a new random encryption key.                                       |
| `set-password`                    | Sets/resets the login password and signs out every session.               |
| `revoke-sessions`                 | Signs out every session.                                                  |
| `backup`                          | Writes a backup now.                                                      |
| `restore-backup <file> <dest.db>` | Decrypts and unpacks a backup into a SQLite file.                         |
| `rotate-key`                      | Re-encrypts all secrets with a new key (see below).                       |
| `migrate`                         | Applies database migrations. The web container also does this at startup. |

### Backups

The worker writes one backup per day (after `BACKUP_HOUR_UTC`) to `data/backups/`:
a consistent `VACUUM INTO` snapshot, gzipped and **encrypted with a key derived from
`DATASTREAM_ENC_KEY`** (`.db.gz.enc`). Retention keeps the newest
`BACKUP_KEEP_DAILY` days plus one backup per ISO week for `BACKUP_KEEP_WEEKLY` weeks.

Copy backups off the device; they're safe to store elsewhere because they're encrypted:

```bash
rsync -a pi@datastream.local:~/datastream/data/backups/ ~/Backups/datastream/
```

### Restore

```bash
docker compose stop web worker
docker compose run --rm --entrypoint node web dist/cli.mjs restore-backup \
  /data/backups/datastream-2026-10-31T030000Z.db.gz.enc /data/restored.db
mv data/datastream.db data/datastream.db.old && rm -f data/datastream.db-wal data/datastream.db-shm
mv data/restored.db data/datastream.db
docker compose up -d
```

### Key rotation

1. Generate a new key (`gen-key`).
2. In `.env`, move the current key to `DATASTREAM_ENC_KEY_PREVIOUS` and put the new one in
   `DATASTREAM_ENC_KEY`.
3. `docker compose up -d`, then `docker compose exec web node dist/cli.mjs rotate-key`.
4. Remove `DATASTREAM_ENC_KEY_PREVIOUS` once older backups made with it have aged out
   (`restore-backup` falls back to it automatically).

### Upgrades

```bash
git pull && docker compose up -d --build
```

Migrations run automatically on start. Take a `backup` first if you're cautious.

---

## Threat model

Datastream never holds anything that can move funds. The worst case is a
**privacy** breach, not a loss of coins. These are the assets it protects, in order:
which addresses are yours, your balances and history, alert/API credentials, and
access to the dashboard.

| Scenario                                                                                        | What is exposed                                                                                                                                                                                 | Mitigations                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Database file stolen** (no `.env`)                                                            | Single addresses you added, transaction history (txids can be looked up on-chain), balances, labels. **Not** xpubs/viewing keys (so future addresses can't be derived), not alert/API secrets.  | AES-256-GCM envelopes with per-purpose AAD; HMAC fingerprints for dedup; derived addresses are never persisted. Use full-disk encryption on the host.                                                            |
| **Shielded sidecar volume stolen**                                                              | Nothing without `ZCASH_VIEWER_DB_KEY`.                                                                                                                                                          | SQLCipher (AES-256) over the whole wallet DB; the key is passed only to the sidecar container.                                                                                                                   |
| **Backup copied off-device**                                                                    | Nothing, if `BACKUP_ENCRYPT=true` (default).                                                                                                                                                    | Encrypted backups with an HKDF-derived key; authenticated (tampering is detected).                                                                                                                               |
| **Whole device compromised** (DB + `.env`)                                                      | Everything Datastream knows about your wallets. No funds.                                                                                                                                       | Out of scope: protect the host (updates, SSH keys, firewall).                                                                                                                                                    |
| **Someone on your LAN / tailnet**                                                               | Nothing without the password.                                                                                                                                                                   | Argon2id, rate-limited login (per IP and global), opaque sessions (only SHA-256 hashes stored) with idle + absolute expiry, `__Host-` cookies with `HttpOnly; Secure; SameSite=Strict`, optional CIDR allowlist. |
| **Network eavesdropper on the LAN**                                                             | Nothing.                                                                                                                                                                                        | TLS via Caddy, HSTS.                                                                                                                                                                                             |
| **Malicious token metadata / XSS**                                                              | —                                                                                                                                                                                               | Strict nonce-based CSP (`script-src 'nonce-…' 'strict-dynamic'`), no third-party scripts/fonts/images, React escaping, CSV formula-injection escaping, spam tokens hidden by default.                            |
| **Chain / price API providers** (Esplora, Etherscan/Alchemy, RPC/Helius, Blockchair, CoinGecko) | Your server's IP plus every address/xpub-derived address it queries. A provider can link them as belonging to one owner.                                                                        | Point Esplora/RPC at your own node for real privacy; requests come only from the server, never your browser; provider rates are throttled. Providers can't move funds; at worst they report wrong balances.      |
| **lightwalletd** (shielded Zcash)                                                               | Your IP, the wallet birthday (at import), the blocks you download, and the transparent addresses and txids the sidecar looks up. **Never** the viewing key or which shielded outputs are yours. | Trial decryption is local. Use your own lightwalletd (`LIGHTWALLETD_URL`) to keep even this metadata home.                                                                                                       |
| **Notification providers** (ntfy, Telegram)                                                     | Wallet labels, direction and amounts (or nothing but the label with "hide amounts"). Never addresses or txids.                                                                                  | Per-channel "hide amounts"; long random ntfy topics or a self-hosted ntfy.                                                                                                                                       |
| **Shoulder surfing**                                                                            | —                                                                                                                                                                                               | Privacy mode masks every amount (server-rendered, no flash). It is visual masking: values are still in the page.                                                                                                 |
| **Logs shipped elsewhere**                                                                      | Wallet ids and counts, never full addresses, xpubs, keys or txids.                                                                                                                              | Every log line passes a masker; credentials in URLs (Telegram, Alchemy, Helius) are redacted; tests enforce it.                                                                                                  |
| **Supply chain**                                                                                | —                                                                                                                                                                                               | Frozen lockfile, pnpm build-script allowlist, small dependency set, CI on every change.                                                                                                                          |

Non-goals: anonymity against API providers (use your own node), protection against a
compromised host OS, multi-user access.

---

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). In short:

```
browser ──HTTPS──▶ caddy ──▶ web (Next.js App Router, reads SQLite only)
                                │
                     SQLite (WAL, /data)
                                │
                             worker ──▶ Esplora · Etherscan/Alchemy · Solana RPC · Blockchair · CoinGecko · ntfy/Telegram
                                │
                                └──▶ zcash-viewer (optional, Rust) ──gRPC──▶ lightwalletd
```

- `src/server/chains/*`: one adapter per network behind `ChainAdapter`
  (`getBalance`, `getTokens`, `getTransactions`).
- `src/server/jobs/*`: durable SQLite job queue. Jobs: `wallet.sync`, `wallet.forget`,
  `prices.*`, `alerts.dispatch`, `maintenance.*`.
- `src/server/auth/*`: proxy-level checks plus an authoritative Data Access Layer.
- Amounts are `bigint` base units end to end; EUR is display-only.

---

## Adding a network

1. **Adapter.** Create `src/server/chains/<net>/adapter.ts` implementing `ChainAdapter`
   from `src/server/chains/types.ts`:

   ```ts
   export function createLitecoinAdapter(cfg: {
     apiUrl: string;
     explorerUrl: string;
   }): ChainAdapter {
     return {
       network: "ltc",
       label: "Litecoin",
       nativeAsset: {
         id: "ltc",
         network: "ltc",
         contract: null,
         symbol: "LTC",
         name: "Litecoin",
         decimals: 8,
         coingeckoId: "litecoin",
       },
       supportedSources: ["address"],
       parseSource(kind, input) {
         /* validate + canonicalize, throw SourceValidationError */
       },
       async getBalance(ctx, src) {
         /* native balance in base units */
       },
       async getTokens() {
         return [];
       },
       async getTransactions(ctx, src, { knownTxids, maxPages }) {
         /* newest first; stop at knownTxids */
       },
       explorerUrl: (kind, id) => `${cfg.explorerUrl}/${kind}/${id}`,
     };
   }
   ```

   Rules: amounts as `bigint`; `movements` are **net per asset for this wallet,
   excluding the fee**; `fee` only when this wallet paid it. Use `ctx.http` (throttled,
   retrying, secret-safe) and keep cursors in `ctx.state`.

2. **Types.** Add the id to `NetworkId` in `types.ts` and display metadata to
   `src/lib/networks.ts`.
3. **Config.** Add its env vars to `src/env.ts` and `.env.example`.
4. **Register** it in `build()` in `src/server/chains/registry.ts`.
5. **Prices.** Native coins need `coingeckoId`; tokens map automatically if you add
   the CoinGecko platform id to `PLATFORM_FOR_NETWORK` in `src/server/prices/coingecko.ts`.
6. **Secret guard.** If the network has its own private-key formats, add patterns to
   `src/server/crypto/secret-guard.ts`, and masking for its address formats to
   `src/server/log/mask.ts`.
7. **Tests.** Add MSW-backed adapter tests next to `tests/unit/adapters.test.ts`
   (balance, a received tx, a sent tx with fee, paging stops at known txids).

---

## Testing

```bash
pnpm test          # Vitest: BTC BIP44/49/84/86 vectors, adapters (MSW), sync, crypto, auth, prices, alerts, export, backups
pnpm build && pnpm test:e2e   # Playwright against the production build (desktop + mobile)
pnpm lint && pnpm typecheck && pnpm format:check
(cd sidecars/zcash-viewer && cargo fmt --check && cargo clippy --all-targets && cargo test)
```

CI (GitHub Actions) runs all of the above and builds both Docker images (app and
sidecar) for `linux/amd64` and `linux/arm64` on every push and pull request.

---

## Limitations

- Ethereum mainnet only (L2s can be added via the Etherscan v2 `chainid`).
- First syncs fetch a bounded number of pages (BTC/ETH: 40, Solana public RPC: 4) to stay
  within free API limits, so very long histories are partially imported. Balances are
  always exact; the historical chart backfill is approximate in that case.
- ERC-20 balances via Etherscan are refreshed when a token moves and fully every 24h,
  so rebasing tokens can lag by up to a day.
- 24h/7d/30d changes reflect the price performance of current holdings, not
  deposits and withdrawals.
- Privacy mode is visual masking for shoulder surfing, not access control.
- Shielded Zcash transactions appear once mined (no mempool scanning), and the
  first scan of a viewing key can take a long time with an early birthday.
