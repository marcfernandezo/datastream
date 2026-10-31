//! Internal HTTP API, called only by the Datastream worker over the compose
//! network. Every route except `/healthz` requires the bearer token.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, Notify};
use tonic::transport::Channel;
use tracing::{error, info};
use zcash_client_backend::data_api::{
    Account as _, AccountBirthday, AccountPurpose, WalletRead, WalletWrite,
};
use zcash_client_sqlite::AccountUuid;
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_protocol::consensus::{BlockHeight, NetworkUpgrade, Parameters};

use crate::{
    config::{Config, network_name},
    db, lwd,
    sync::SharedStatus,
};

pub struct AppState {
    pub cfg: Arc<Config>,
    pub channel: Channel,
    pub status: SharedStatus,
    pub wake: Arc<Notify>,
    /// Serializes imports so two concurrent requests can't race on one UFVK.
    pub import_lock: Mutex<()>,
}

type Shared = Arc<AppState>;

pub fn router(state: Shared) -> Router {
    let v1 = Router::new()
        .route("/status", get(status))
        .route("/accounts", post(import_account))
        .route("/accounts/{id}", get(account).delete(delete_account))
        .route("/accounts/{id}/transactions", get(transactions))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth));
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest("/v1", v1)
        .layer(DefaultBodyLimit::max(16 * 1024))
        .with_state(state)
}

pub struct ApiError(StatusCode, String);

impl ApiError {
    fn bad_request(msg: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, msg.into())
    }
    fn not_found() -> Self {
        Self(StatusCode::NOT_FOUND, "account not found".into())
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        let msg = crate::redact::redact(&format!("{e:#}"), 300);
        error!(error = %msg, "request failed");
        Self(StatusCode::INTERNAL_SERVER_ERROR, msg)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

type ApiResult<T> = Result<Json<T>, ApiError>;

async fn auth(State(state): State<Shared>, req: Request, next: Next) -> Response {
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if bool::from(presented.as_bytes().ct_eq(state.cfg.token.as_bytes())) {
        next.run(req).await
    } else {
        ApiError(StatusCode::UNAUTHORIZED, "unauthorized".into()).into_response()
    }
}

/// Runs blocking SQLite work off the async executor.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError::from(anyhow::anyhow!("worker thread failed: {e}")))?
        .map_err(ApiError::from)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    network: &'static str,
    #[serde(flatten)]
    sync: crate::sync::SyncStatus,
}

async fn status(State(state): State<Shared>) -> ApiResult<StatusResponse> {
    Ok(Json(StatusResponse {
        network: network_name(state.cfg.network),
        sync: state.status.read().await.clone(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportRequest {
    ufvk: String,
    birthday_height: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportResponse {
    account_id: String,
    created: bool,
    birthday_height: u32,
}

/// Idempotent: returns the existing account when the UFVK is already imported.
async fn import_account(
    State(state): State<Shared>,
    Json(body): Json<ImportRequest>,
) -> Result<(StatusCode, Json<ImportResponse>), ApiError> {
    let cfg = state.cfg.clone();
    let params = cfg.network;
    let ufvk = UnifiedFullViewingKey::decode(&params, body.ufvk.trim()).map_err(|_| {
        ApiError::bad_request("not a valid unified full viewing key for this network")
    })?;

    let _guard = state.import_lock.lock().await;

    let existing = {
        let (cfg, ufvk) = (cfg.clone(), ufvk.clone());
        blocking(move || {
            let wallet = db::open_wallet(&cfg.db_path, &cfg.db_key, cfg.network)?;
            Ok(match wallet.get_account_for_ufvk(&ufvk)? {
                Some(a) => Some((a.id(), wallet.get_account_birthday(a.id())?)),
                None => None,
            })
        })
        .await?
    };
    if let Some((id, birthday)) = existing {
        return Ok((
            StatusCode::OK,
            Json(ImportResponse {
                account_id: id.expose_uuid().to_string(),
                created: false,
                birthday_height: birthday.into(),
            }),
        ));
    }

    // Birthday: default to NU5 (Orchard) activation, the earliest a unified key
    // could have been issued. Clamp to [Sapling activation + 1, tip].
    let sapling = params
        .activation_height(NetworkUpgrade::Sapling)
        .expect("Sapling is active on every supported network");
    let nu5 = params
        .activation_height(NetworkUpgrade::Nu5)
        .unwrap_or(sapling);
    let mut client = lwd::client(&state.channel);
    let tip = lwd::tip_height(&mut client).await?;
    let requested = body
        .birthday_height
        .map(BlockHeight::from_u32)
        .unwrap_or(nu5);
    let height = requested.max(sapling + 1).min(tip);
    // NOTE: fetching the tree state reveals the birthday to the lightwalletd server.
    let tree = lwd::tree_state(&mut client, height - 1).await?;
    let birthday = AccountBirthday::from_treestate(tree, Some(tip))
        .map_err(|_| anyhow::anyhow!("lightwalletd returned an invalid tree state"))?;

    let id = blocking(move || {
        let mut wallet = db::open_wallet(&cfg.db_path, &cfg.db_key, cfg.network)?;
        let account = wallet.import_account_ufvk(
            "datastream",
            &ufvk,
            &birthday,
            AccountPurpose::ViewOnly,
            None,
        )?;
        let conn = db::connect(&cfg.db_path, &cfg.db_key)?;
        db::ensure_state_rows(&conn, &[account.id()])?;
        Ok(account.id())
    })
    .await?;

    info!(birthday = u32::from(height), "viewing key imported");
    state.wake.notify_one();
    Ok((
        StatusCode::CREATED,
        Json(ImportResponse {
            account_id: id.expose_uuid().to_string(),
            created: true,
            birthday_height: height.into(),
        }),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Balance {
    /// All amounts are zatoshis, as decimal strings.
    total: String,
    sapling: String,
    orchard: String,
    ironwood: String,
    transparent: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    scanned: u64,
    total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountResponse {
    account_id: String,
    birthday_height: u32,
    /// True once the account's history has been fully scanned at least once.
    /// Until then, balances and history are incomplete.
    ready: bool,
    progress: Option<Progress>,
    balance: Balance,
    #[serde(flatten)]
    sync: crate::sync::SyncStatus,
}

fn account_id(id: &str) -> Result<AccountUuid, ApiError> {
    db::parse_account_id(id).ok_or_else(ApiError::not_found)
}

async fn account(
    State(state): State<Shared>,
    Path(id): Path<String>,
) -> ApiResult<AccountResponse> {
    let id = account_id(&id)?;
    let cfg = state.cfg.clone();
    let sync = state.status.read().await.clone();
    let resp = blocking(move || {
        let wallet = db::open_wallet(&cfg.db_path, &cfg.db_key, cfg.network)?;
        if wallet.get_account(id)?.is_none() {
            return Ok(None);
        }
        let birthday = wallet.get_account_birthday(id)?;
        let conn = db::connect(&cfg.db_path, &cfg.db_key)?;
        let ready = db::is_ready(&conn, id)?;
        let summary = wallet.get_wallet_summary(Default::default())?;
        let bal = summary
            .as_ref()
            .and_then(|s| s.account_balances().get(&id).cloned());
        let z = |v: Option<u64>| v.unwrap_or(0).to_string();
        let balance = Balance {
            total: z(bal.as_ref().map(|b| b.total().into_u64())),
            sapling: z(bal.as_ref().map(|b| b.sapling_balance().total().into_u64())),
            orchard: z(bal.as_ref().map(|b| b.orchard_balance().total().into_u64())),
            ironwood: z(bal
                .as_ref()
                .map(|b| b.ironwood_balance().total().into_u64())),
            transparent: z(bal
                .as_ref()
                .map(|b| b.unshielded_balance().total().into_u64())),
        };
        let progress = summary.as_ref().map(|s| {
            let r = s.progress().scan();
            Progress {
                scanned: *r.numerator(),
                total: *r.denominator(),
            }
        });
        Ok(Some(AccountResponse {
            account_id: id.expose_uuid().to_string(),
            birthday_height: birthday.into(),
            ready,
            progress,
            balance,
            sync,
        }))
    })
    .await?;
    resp.map(Json).ok_or_else(ApiError::not_found)
}

#[derive(Deserialize)]
struct Page {
    limit: Option<u32>,
    offset: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TxPage {
    transactions: Vec<db::TxRow>,
    has_more: bool,
}

async fn transactions(
    State(state): State<Shared>,
    Path(id): Path<String>,
    Query(page): Query<Page>,
) -> ApiResult<TxPage> {
    let id = account_id(&id)?;
    let limit = page.limit.unwrap_or(100).clamp(1, 500);
    let offset = page.offset.unwrap_or(0);
    let cfg = state.cfg.clone();
    let page = blocking(move || {
        let wallet = db::open_wallet(&cfg.db_path, &cfg.db_key, cfg.network)?;
        if wallet.get_account(id)?.is_none() {
            return Ok(None);
        }
        let conn = db::connect(&cfg.db_path, &cfg.db_key)?;
        let mut rows = db::transactions(&conn, id, limit + 1, offset)?;
        let has_more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        Ok(Some(TxPage {
            transactions: rows,
            has_more,
        }))
    })
    .await?;
    page.map(Json).ok_or_else(ApiError::not_found)
}

async fn delete_account(
    State(state): State<Shared>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let id = account_id(&id)?;
    let cfg = state.cfg.clone();
    let _guard = state.import_lock.lock().await;
    let deleted = blocking(move || {
        let mut wallet = db::open_wallet(&cfg.db_path, &cfg.db_key, cfg.network)?;
        if wallet.get_account(id)?.is_none() {
            return Ok(false);
        }
        wallet.delete_account(id)?;
        let conn = db::connect(&cfg.db_path, &cfg.db_key)?;
        db::forget_state(&conn, id)?;
        Ok(true)
    })
    .await?;
    if deleted {
        info!("viewing key removed");
    }
    // Idempotent: deleting an unknown account is not an error.
    Ok(StatusCode::NO_CONTENT)
}
