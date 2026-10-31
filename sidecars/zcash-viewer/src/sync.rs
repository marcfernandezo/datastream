//! Background sync: scan compact blocks for every imported account, then fetch
//! full transactions the wallet asks for (fees, sent outputs, transparent
//! history), then mark fully synced accounts as ready.

use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, anyhow};
use futures_util::StreamExt;
use tokio::sync::{Notify, RwLock, watch};
use tonic::transport::Channel;
use tracing::{info, warn};
use zcash_client_backend::{
    data_api::{
        TransactionDataRequest, TransactionStatus, WalletRead, WalletWrite,
        wallet::decrypt_and_store_transaction,
    },
    proto::service::{self, BlockRange},
};
use zcash_keys::encoding::AddressCodec as _;

use crate::{cache::MemoryBlockCache, config::Config, db, lwd};

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub syncing: bool,
    /// Unix seconds of the last pass that completed without error.
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub chain_tip_height: Option<u32>,
    pub fully_scanned_height: Option<u32>,
}

pub type SharedStatus = Arc<RwLock<SyncStatus>>;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// Upper bound on enhancement rounds per pass (each round re-reads the queue).
const MAX_ENHANCE_ROUNDS: usize = 20;

pub async fn run_loop(
    cfg: Arc<Config>,
    channel: Channel,
    status: SharedStatus,
    wake: Arc<Notify>,
    mut shutdown: watch::Receiver<bool>,
) {
    let cache = MemoryBlockCache::default();
    let mut failures: u32 = 0;
    let mut delay = Duration::ZERO;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = wake.notified() => {}
            _ = shutdown.changed() => return,
        }
        if *shutdown.borrow() {
            return;
        }

        status.write().await.syncing = true;
        let result = tokio::select! {
            r = pass(&cfg, &channel, &cache, &status) => r,
            _ = shutdown.changed() => return,
        };
        let mut s = status.write().await;
        s.syncing = false;
        match result {
            Ok(()) => {
                failures = 0;
                s.last_sync_at = Some(now_secs());
                s.last_error = None;
                delay = cfg.sync_interval;
            }
            Err(e) => {
                failures = failures.saturating_add(1);
                // Error chains can carry lightwalletd messages; never addresses or keys.
                let msg = crate::redact::redact(&format!("{e:#}"), 300);
                warn!(error = %msg, failures, "sync pass failed");
                s.last_error = Some(msg);
                delay = Duration::from_secs(30 * 2u64.pow(failures.min(5) - 1))
                    .min(cfg.sync_interval.max(Duration::from_secs(600)));
            }
        }
    }
}

async fn pass(
    cfg: &Config,
    channel: &Channel,
    cache: &MemoryBlockCache,
    status: &SharedStatus,
) -> anyhow::Result<()> {
    let mut wallet = db::open_wallet(&cfg.db_path, &cfg.db_key, cfg.network)?;
    let accounts = wallet.get_account_ids()?;
    if accounts.is_empty() {
        // Nothing to watch: don't contact lightwalletd at all.
        return Ok(());
    }
    let mut conn = db::connect(&cfg.db_path, &cfg.db_key)?;
    db::ensure_state_rows(&conn, &accounts)?;

    let mut client = lwd::client(channel);
    let started = std::time::Instant::now();
    zcash_client_backend::sync::run(
        &mut client,
        &cfg.network,
        cache,
        &mut wallet,
        cfg.batch_size,
    )
    .await
    .map_err(|e| anyhow!("{e}"))
    .context("scanning blocks")?;

    enhance(&mut client, cfg, &mut wallet)
        .await
        .context("fetching transactions")?;
    fill_block_times(&mut client, &mut conn)
        .await
        .context("fetching block times")?;

    // Fully synced means no block range is left to scan (for any account).
    let pending_ranges = wallet.suggest_scan_ranges()?;
    let snapshot = wallet.get_wallet_snapshot(Default::default())?;
    {
        let mut s = status.write().await;
        s.chain_tip_height = snapshot.as_ref().map(|s| u32::from(s.chain_tip_height()));
        s.fully_scanned_height = snapshot
            .as_ref()
            .map(|s| u32::from(s.fully_scanned_height()));
    }
    if pending_ranges.is_empty() {
        let n = db::mark_ready(&conn, &accounts)?;
        if n > 0 {
            info!(accounts = n, "initial shielded sync complete");
        }
    }
    info!(
        ms = started.elapsed().as_millis() as u64,
        accounts = accounts.len(),
        pending_ranges = pending_ranges.len(),
        "sync pass done"
    );
    Ok(())
}

/// Looks up timestamps for wallet transactions in blocks we never scanned.
async fn fill_block_times(
    client: &mut lwd::Client,
    // `&mut`: a shared `&Connection` held across an await isn't Send.
    conn: &mut rusqlite::Connection,
) -> anyhow::Result<()> {
    for height in db::missing_block_times(conn, 500)? {
        let block = client
            .get_block(service::BlockId {
                height: u64::from(height),
                hash: vec![],
            })
            .await
            .context("lightwalletd GetBlock")?
            .into_inner();
        db::put_block_time(conn, height, i64::from(block.time))?;
    }
    Ok(())
}

/// Answers the wallet's transaction data requests, as in ECC's zcash-devtool.
async fn enhance(
    client: &mut lwd::Client,
    cfg: &Config,
    wallet: &mut db::Wallet,
) -> anyhow::Result<()> {
    let params = cfg.network;
    let Some(chain_tip) = wallet.chain_height()? else {
        return Ok(());
    };

    let mut satisfied = BTreeSet::new();
    for _ in 0..MAX_ENHANCE_ROUNDS {
        let mut progressed = false;
        for request in wallet.transaction_data_requests()? {
            if satisfied.contains(&request) {
                continue;
            }
            match &request {
                TransactionDataRequest::GetStatus(txid) => {
                    let status = lwd::fetch_transaction(client, &params, chain_tip, *txid)
                        .await?
                        .map_or(TransactionStatus::TxidNotRecognized, |(_, h)| {
                            h.map_or(TransactionStatus::NotInMainChain, TransactionStatus::Mined)
                        });
                    wallet.set_transaction_status(*txid, status)?;
                }
                TransactionDataRequest::Enhancement(txid) => {
                    match lwd::fetch_transaction(client, &params, chain_tip, *txid).await? {
                        None => wallet
                            .set_transaction_status(*txid, TransactionStatus::TxidNotRecognized)?,
                        Some((tx, mined_height)) => {
                            decrypt_and_store_transaction(&params, wallet, &tx, mined_height)?
                        }
                    }
                }
                TransactionDataRequest::TransactionsInvolvingAddress(tia) => {
                    // The wallet schedules repeat checks with jitter; honor it.
                    if tia.request_at().is_some_and(|at| at > SystemTime::now()) {
                        satisfied.insert(request);
                        continue;
                    }
                    let address = tia.address().encode(&params);
                    let request_range = service::TransparentAddressBlockFilter {
                        address,
                        range: Some(BlockRange {
                            start: Some(service::BlockId {
                                height: u64::from(tia.block_range_start()),
                                ..Default::default()
                            }),
                            // BlockRange's end is inclusive.
                            end: tia.block_range_end().map(|h| service::BlockId {
                                height: u64::from(h - 1),
                                ..Default::default()
                            }),
                            pool_types: Default::default(),
                        }),
                    };
                    let mut stream = client
                        .get_taddress_txids(request_range)
                        .await
                        .context("lightwalletd GetTaddressTxids")?
                        .into_inner();
                    let mut found = false;
                    while let Some(raw) = stream.next().await {
                        let (tx, mined_height) = lwd::parse_raw_transaction(
                            &params,
                            chain_tip,
                            raw.context("lightwalletd stream")?,
                        )?;
                        decrypt_and_store_transaction(&params, wallet, &tx, mined_height)?;
                        found = true;
                    }
                    if !found {
                        let as_of = tia.block_range_end().map_or(chain_tip, |h| h - 1);
                        wallet.notify_address_checked(tia.clone(), as_of)?;
                    }
                }
                #[allow(unreachable_patterns)]
                _ => {}
            }
            satisfied.insert(request);
            progressed = true;
        }
        if !progressed {
            return Ok(());
        }
    }
    warn!("transaction enhancement did not settle; continuing next pass");
    Ok(())
}
