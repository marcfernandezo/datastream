# zcash-viewer

Watch-only Zcash light client used by Datastream for shielded balances. It imports
Unified Full Viewing Keys as **view-only** accounts (`zcash_client_sqlite`), syncs them
from a `lightwalletd` server (`zcash_client_backend::sync`) and answers the Datastream
worker over a small internal HTTP API. It has no spending keys, proving parameters or
transaction building.

See the main README → [Shielded Zcash](../../README.md#shielded-zcash) for setup, and
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for the design.

## Configuration (environment)

| Variable                   | Default                  | Purpose                                               |
| -------------------------- | ------------------------ | ----------------------------------------------------- |
| `ZCASH_VIEWER_TOKEN`       | required (≥ 32 chars)    | Bearer token shared with the Datastream worker.       |
| `ZCASH_VIEWER_DB_KEY`      | required                 | 32 random bytes, base64. SQLCipher key for the DB.    |
| `ZCASH_VIEWER_DB`          | `/data/wallet.db`        | Wallet database path.                                 |
| `ZCASH_VIEWER_LISTEN`      | `0.0.0.0:8232`           | HTTP listen address (compose network only).           |
| `LIGHTWALLETD_URL`         | `https://zec.rocks:443`  | lightwalletd gRPC endpoint (`https://` or `http://`). |
| `ZCASH_NETWORK`            | `main`                   | `main` or `test`.                                     |
| `ZCASH_SYNC_INTERVAL_SECS` | `120`                    | Pause between sync passes.                            |
| `ZCASH_SYNC_BATCH_SIZE`    | `200`                    | Blocks per download/scan batch (bounds memory).       |
| `ZCASH_VIEWER_LOG`         | `warn,zcash_viewer=info` | `tracing` filter. Library crates stay at `warn`.      |
| `ZCASH_VIEWER_LOG_FORMAT`  | JSON                     | `pretty` for human-readable logs.                     |

## API

All `/v1` routes require `Authorization: Bearer $ZCASH_VIEWER_TOKEN`. Amounts are
zatoshis.

| Route                                         | Description                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /healthz`                                | Liveness (no auth). `zcash-viewer healthcheck` probes it.              |
| `GET /v1/status`                              | Network, chain tip, fully scanned height, last sync and error.         |
| `POST /v1/accounts` `{ufvk, birthdayHeight?}` | Import (idempotent). `201` when created, `200` when it already exists. |
| `GET /v1/accounts/:id`                        | Balance by pool, `ready` (first full scan done), scan progress.        |
| `GET /v1/accounts/:id/transactions`           | `?limit=&offset=`, newest first: `delta` (fee included) and `fee`.     |
| `DELETE /v1/accounts/:id`                     | Remove the account and its data (idempotent).                          |

## Development

```bash
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
ZCASH_VIEWER_TOKEN=$(openssl rand -hex 32) ZCASH_VIEWER_DB_KEY=$(openssl rand -base64 32) \
  ZCASH_VIEWER_DB=./dev.db ZCASH_VIEWER_LISTEN=127.0.0.1:8232 ZCASH_VIEWER_LOG_FORMAT=pretty \
  cargo run
```

The Docker image cross-compiles from the builder's native platform, so
`docker buildx build --platform linux/amd64,linux/arm64 .` doesn't need emulation.
