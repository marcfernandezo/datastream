//! lightwalletd gRPC connection and small helpers.
//!
//! Trial decryption runs locally: the server never receives a viewing key. It
//! does see this host's IP, which blocks are fetched, the wallet birthday (on
//! import), and the transparent addresses and txids we look up.

use std::time::Duration;

use anyhow::{Context, anyhow};
use tonic::{
    Code,
    transport::{Channel, ClientTlsConfig, Endpoint},
};
use zcash_client_backend::proto::service::{
    self, ChainSpec, RawTransaction, TreeState, compact_tx_streamer_client::CompactTxStreamerClient,
};
use zcash_primitives::transaction::{Transaction, TxId};
use zcash_protocol::consensus::{BlockHeight, BranchId, Parameters};

pub type Client = CompactTxStreamerClient<Channel>;

/// Lazily connected channel: startup never blocks on the network, and tonic
/// reconnects on its own after failures.
pub fn channel(url: &str) -> anyhow::Result<Channel> {
    let mut endpoint = Endpoint::from_shared(url.to_owned())
        .context("invalid LIGHTWALLETD_URL")?
        .user_agent("datastream-zcash-viewer")?
        .connect_timeout(Duration::from_secs(15))
        .tcp_keepalive(Some(Duration::from_secs(60)))
        .http2_keep_alive_interval(Duration::from_secs(30))
        .keep_alive_timeout(Duration::from_secs(20));
    if url.starts_with("https://") {
        endpoint = endpoint.tls_config(ClientTlsConfig::new().with_webpki_roots())?;
    }
    Ok(endpoint.connect_lazy())
}

pub fn client(channel: &Channel) -> Client {
    // Compact block batches during the 2022–23 spam era can be large.
    CompactTxStreamerClient::new(channel.clone()).max_decoding_message_size(64 * 1024 * 1024)
}

pub async fn tip_height(client: &mut Client) -> anyhow::Result<BlockHeight> {
    let h = client
        .get_latest_block(ChainSpec::default())
        .await
        .context("lightwalletd GetLatestBlock")?
        .into_inner()
        .height;
    u32::try_from(h)
        .map(BlockHeight::from_u32)
        .map_err(|_| anyhow!("lightwalletd returned an invalid tip height"))
}

pub async fn tree_state(client: &mut Client, height: BlockHeight) -> anyhow::Result<TreeState> {
    Ok(client
        .get_tree_state(service::BlockId {
            height: u64::from(height),
            hash: vec![],
        })
        .await
        .context("lightwalletd GetTreeState")?
        .into_inner())
}

pub fn parse_raw_transaction<P: Parameters>(
    params: &P,
    chain_tip: BlockHeight,
    tx: RawTransaction,
) -> anyhow::Result<(Transaction, Option<BlockHeight>)> {
    // lightwalletd uses 0 for mempool and u64::MAX-ish sentinels for unmined txs.
    let mined_height = u32::try_from(tx.height)
        .ok()
        .filter(|h| *h > 0)
        .map(BlockHeight::from_u32);
    let parsed = Transaction::read(
        &tx.data[..],
        // Unmined transactions are assumed to use the current consensus branch.
        BranchId::for_height(params, mined_height.unwrap_or(chain_tip)),
    )
    .context("parsing raw transaction")?;
    Ok((parsed, mined_height))
}

pub async fn fetch_transaction<P: Parameters>(
    client: &mut Client,
    params: &P,
    chain_tip: BlockHeight,
    txid: TxId,
) -> anyhow::Result<Option<(Transaction, Option<BlockHeight>)>> {
    let request = service::TxFilter {
        hash: txid.as_ref().to_vec(),
        ..Default::default()
    };
    match client.get_transaction(request).await {
        Ok(resp) => parse_raw_transaction(params, chain_tip, resp.into_inner()).map(Some),
        Err(status) if status.code() == Code::NotFound => Ok(None),
        Err(status) => Err(anyhow!("lightwalletd GetTransaction: {}", status.message())),
    }
}
