//! zcash-viewer: watch-only Zcash light client for Datastream.
//!
//! Imports Unified Full Viewing Keys as view-only accounts, keeps them synced
//! against lightwalletd, and serves balances and history to the Datastream
//! worker over an internal, token-protected HTTP API. It has no spending
//! capability: there are no spending keys, no proving parameters and no
//! transaction construction anywhere in this binary.

mod api;
mod cache;
mod config;
mod db;
mod lwd;
mod redact;
mod sync;

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    sync::Arc,
    time::Duration,
};

use anyhow::Context;
use tokio::sync::{Mutex, Notify, RwLock, watch};
use tracing::info;
use tracing_subscriber::EnvFilter;

/// `zcash-viewer healthcheck`: for Docker HEALTHCHECK in a shell-less image.
fn healthcheck() -> i32 {
    let port = std::env::var("ZCASH_VIEWER_LISTEN")
        .ok()
        .and_then(|l| l.parse::<SocketAddr>().ok())
        .map_or(8232, |a| a.port());
    let probe = || -> std::io::Result<bool> {
        let mut s = TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_secs(3),
        )?;
        s.set_read_timeout(Some(Duration::from_secs(3)))?;
        s.write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
        let mut buf = [0u8; 16];
        let n = s.read(&mut buf)?;
        Ok(buf[..n].starts_with(b"HTTP/1.1 200") || buf[..n].starts_with(b"HTTP/1.0 200"))
    };
    if probe().unwrap_or(false) { 0 } else { 1 }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}

fn init_tracing() {
    // Library crates log heights, ranges and occasionally addresses at info
    // level; keep them at warn so logs never carry wallet identifiers.
    let filter = EnvFilter::try_from_env("ZCASH_VIEWER_LOG")
        .unwrap_or_else(|_| EnvFilter::new("warn,zcash_viewer=info"));
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false);
    if std::env::var("ZCASH_VIEWER_LOG_FORMAT").as_deref() == Ok("pretty") {
        builder.init();
    } else {
        builder.json().flatten_event(true).init();
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(healthcheck());
    }
    init_tracing();

    let cfg = Arc::new(config::Config::from_env()?);
    if let Some(dir) = cfg.db_path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    {
        let cfg = cfg.clone();
        tokio::task::spawn_blocking(move || db::init(&cfg.db_path, &cfg.db_key, cfg.network))
            .await??;
    }
    info!(config = ?cfg, "zcash-viewer starting");

    let channel = lwd::channel(&cfg.lightwalletd_url)?;
    let status = Arc::new(RwLock::new(sync::SyncStatus::default()));
    let wake = Arc::new(Notify::new());
    let (stop_tx, stop_rx) = watch::channel(false);

    let syncer = tokio::spawn(sync::run_loop(
        cfg.clone(),
        channel.clone(),
        status.clone(),
        wake.clone(),
        stop_rx,
    ));

    let state = Arc::new(api::AppState {
        cfg: cfg.clone(),
        channel,
        status,
        wake,
        import_lock: Mutex::new(()),
    });
    let listener = tokio::net::TcpListener::bind(cfg.listen)
        .await
        .with_context(|| format!("binding {}", cfg.listen))?;
    info!(listen = %cfg.listen, "listening");
    axum::serve(listener, api::router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("shutting down");
    let _ = stop_tx.send(true);
    // A scan batch commits atomically; give an in-flight one a moment to land.
    let _ = tokio::time::timeout(Duration::from_secs(20), syncer).await;
    Ok(())
}
