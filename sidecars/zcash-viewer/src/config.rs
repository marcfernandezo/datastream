use std::{env, net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{Context, anyhow, bail};
use base64::Engine as _;
use zcash_protocol::consensus::Network;

/// Runtime configuration, read from the environment only.
pub struct Config {
    pub listen: SocketAddr,
    /// Shared bearer token; the only caller is the Datastream worker.
    pub token: String,
    pub db_path: PathBuf,
    /// Raw 256-bit SQLCipher key for the wallet database.
    pub db_key: [u8; 32],
    pub network: Network,
    pub lightwalletd_url: String,
    pub sync_interval: Duration,
    /// Blocks downloaded and scanned per batch. Bounds peak memory.
    pub batch_size: u32,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("listen", &self.listen)
            .field("db_path", &self.db_path)
            .field("network", &network_name(self.network))
            .field("lightwalletd_url", &self.lightwalletd_url)
            .field("sync_interval", &self.sync_interval)
            .field("batch_size", &self.batch_size)
            .finish_non_exhaustive()
    }
}

pub fn network_name(n: Network) -> &'static str {
    match n {
        Network::MainNetwork => "main",
        Network::TestNetwork => "test",
    }
}

fn var(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn parse_num<T>(name: &str, default: T, min: T, max: T) -> anyhow::Result<T>
where
    T: std::str::FromStr + PartialOrd + std::fmt::Display + Copy,
{
    let Some(raw) = var(name) else {
        return Ok(default);
    };
    let v: T = raw
        .parse()
        .map_err(|_| anyhow!("{name} must be a number"))?;
    if v < min || v > max {
        bail!("{name} must be between {min} and {max}");
    }
    Ok(v)
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let token = var("ZCASH_VIEWER_TOKEN").context("ZCASH_VIEWER_TOKEN is required")?;
        if token.len() < 32 {
            bail!("ZCASH_VIEWER_TOKEN must be at least 32 characters (openssl rand -hex 32)");
        }

        let key_b64 = var("ZCASH_VIEWER_DB_KEY").context(
            "ZCASH_VIEWER_DB_KEY is required (32 random bytes, base64: openssl rand -base64 32)",
        )?;
        let key = base64::engine::general_purpose::STANDARD
            .decode(key_b64.as_bytes())
            .map_err(|_| anyhow!("ZCASH_VIEWER_DB_KEY is not valid base64"))?;
        let db_key: [u8; 32] = key
            .try_into()
            .map_err(|_| anyhow!("ZCASH_VIEWER_DB_KEY must decode to exactly 32 bytes"))?;

        let network = match var("ZCASH_NETWORK").as_deref().unwrap_or("main") {
            "main" | "mainnet" => Network::MainNetwork,
            "test" | "testnet" => Network::TestNetwork,
            other => bail!("ZCASH_NETWORK must be main or test, got {other:?}"),
        };

        let lightwalletd_url =
            var("LIGHTWALLETD_URL").unwrap_or_else(|| "https://zec.rocks:443".to_owned());
        if !(lightwalletd_url.starts_with("https://") || lightwalletd_url.starts_with("http://")) {
            bail!("LIGHTWALLETD_URL must start with https:// or http://");
        }

        let listen = var("ZCASH_VIEWER_LISTEN")
            .unwrap_or_else(|| "0.0.0.0:8232".to_owned())
            .parse()
            .context("ZCASH_VIEWER_LISTEN must be host:port")?;

        Ok(Self {
            listen,
            token,
            db_path: var("ZCASH_VIEWER_DB")
                .unwrap_or_else(|| "/data/wallet.db".to_owned())
                .into(),
            db_key,
            network,
            lightwalletd_url,
            sync_interval: Duration::from_secs(parse_num(
                "ZCASH_SYNC_INTERVAL_SECS",
                120,
                15,
                86_400,
            )?),
            batch_size: parse_num("ZCASH_SYNC_BATCH_SIZE", 200, 10, 10_000)?,
        })
    }
}
