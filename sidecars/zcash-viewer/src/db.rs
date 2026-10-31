//! Encrypted wallet database: `zcash_client_sqlite` tables plus one small
//! table of our own (`ext_viewer_account_state`) in the same SQLCipher file.

use std::{path::Path, time::Duration};

use anyhow::{Context, anyhow};
use rand::{rand_core::UnwrapErr, rngs::SysRng};
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;
use zcash_client_sqlite::{AccountUuid, WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_primitives::transaction::TxId;
use zcash_protocol::consensus::Network;

pub type Wallet = WalletDb<Connection, Network, SystemClock, UnwrapErr<SysRng>>;

/// Opens a raw connection with the SQLCipher key applied and verified.
pub fn connect(path: &Path, key: &[u8; 32]) -> anyhow::Result<Connection> {
    let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
    // A raw key skips SQLCipher's PBKDF2 step (the key is already 256 random bits),
    // which keeps per-request connections cheap on a Raspberry Pi.
    let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
    conn.execute_batch(&format!("PRAGMA key = \"x'{hex}'\";"))?;
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .map_err(|_| {
            anyhow!("cannot read the wallet database: wrong ZCASH_VIEWER_DB_KEY or corrupt file")
        })?;
    conn.busy_timeout(Duration::from_secs(30))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // The container's root filesystem is read-only; keep temp tables in memory.
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    rusqlite::vtab::array::load_module(&conn)?;
    Ok(conn)
}

pub fn open_wallet(path: &Path, key: &[u8; 32], network: Network) -> anyhow::Result<Wallet> {
    Ok(WalletDb::from_connection(
        connect(path, key)?,
        network,
        SystemClock,
        UnwrapErr(SysRng),
    ))
}

/// Creates or migrates the wallet schema. Run once at startup.
pub fn init(path: &Path, key: &[u8; 32], network: Network) -> anyhow::Result<()> {
    let mut wallet = open_wallet(path, key, network)?;
    init_wallet_db(&mut wallet, None).map_err(|e| anyhow!("wallet DB migration failed: {e}"))?;
    let conn = connect(path, key)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ext_viewer_account_state (
            account_uuid BLOB PRIMARY KEY,
            imported_at INTEGER NOT NULL,
            ready_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS ext_viewer_block_times (
            height INTEGER PRIMARY KEY,
            time INTEGER NOT NULL
        );",
    )?;
    Ok(())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// Registers accounts we haven't seen yet as not ready.
pub fn ensure_state_rows(conn: &Connection, accounts: &[AccountUuid]) -> anyhow::Result<()> {
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO ext_viewer_account_state (account_uuid, imported_at) VALUES (?1, ?2)",
    )?;
    for a in accounts {
        stmt.execute(params![a.expose_uuid(), now_secs()])?;
    }
    Ok(())
}

/// Marks accounts whose history has been fully scanned and enhanced.
/// Readiness is sticky: later rescans for other accounts don't reset it.
pub fn mark_ready(conn: &Connection, accounts: &[AccountUuid]) -> anyhow::Result<usize> {
    let mut stmt = conn.prepare(
        "UPDATE ext_viewer_account_state SET ready_at = ?2 WHERE account_uuid = ?1 AND ready_at IS NULL",
    )?;
    let mut n = 0;
    for a in accounts {
        n += stmt.execute(params![a.expose_uuid(), now_secs()])?;
    }
    Ok(n)
}

pub fn is_ready(conn: &Connection, account: AccountUuid) -> anyhow::Result<bool> {
    Ok(conn
        .query_row(
            "SELECT ready_at IS NOT NULL FROM ext_viewer_account_state WHERE account_uuid = ?1",
            params![account.expose_uuid()],
            |r| r.get::<_, bool>(0),
        )
        .optional()?
        .unwrap_or(false))
}

pub fn forget_state(conn: &Connection, account: AccountUuid) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM ext_viewer_account_state WHERE account_uuid = ?1",
        params![account.expose_uuid()],
    )?;
    Ok(())
}

/// Heights of wallet transactions in blocks the scanner never stored (e.g.
/// transparent history found by address lookups below the birthday).
pub fn missing_block_times(conn: &Connection, limit: u32) -> anyhow::Result<Vec<u32>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT v.mined_height FROM v_transactions v
         LEFT JOIN ext_viewer_block_times bt ON bt.height = v.mined_height
         WHERE v.mined_height IS NOT NULL AND v.block_time IS NULL AND bt.time IS NULL
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| r.get::<_, u32>(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn put_block_time(conn: &Connection, height: u32, time: i64) -> anyhow::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO ext_viewer_block_times (height, time) VALUES (?1, ?2)",
        params![height, time],
    )?;
    Ok(())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxRow {
    /// Display (big-endian) hex, as shown by block explorers.
    pub txid: String,
    pub mined_height: Option<u32>,
    pub block_time: Option<i64>,
    /// Net change in the account's balance, in zatoshis, fee included.
    pub delta: i64,
    /// Fee in zatoshis, only when this account funded the transaction and the
    /// full transaction is known.
    pub fee: Option<i64>,
    pub expired_unmined: bool,
}

/// Newest first; unmined transactions on top.
pub fn transactions(
    conn: &Connection,
    account: AccountUuid,
    limit: u32,
    offset: u32,
) -> anyhow::Result<Vec<TxRow>> {
    let mut stmt = conn.prepare(
        "SELECT v.txid, v.mined_height, COALESCE(v.block_time, bt.time), v.account_balance_delta,
                v.fee_paid, v.spent_note_count, v.expired_unmined
         FROM v_transactions v
         LEFT JOIN ext_viewer_block_times bt ON bt.height = v.mined_height
         WHERE v.account_uuid = ?1
         ORDER BY v.mined_height IS NOT NULL, v.mined_height DESC, v.tx_index DESC, v.txid
         LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![account.expose_uuid(), limit, offset], |r| {
        let txid: Vec<u8> = r.get(0)?;
        let spent_notes: Option<i64> = r.get(5)?;
        let fee: Option<i64> = r.get(4)?;
        Ok((
            txid,
            r.get::<_, Option<u32>>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, Option<i64>>(3)?.unwrap_or(0),
            fee.filter(|_| spent_notes.unwrap_or(0) > 0),
            r.get::<_, Option<bool>>(6)?.unwrap_or(false),
        ))
    })?;
    rows.map(|row| {
        let (txid, mined_height, block_time, delta, fee, expired_unmined) = row?;
        let bytes: [u8; 32] = txid
            .try_into()
            .map_err(|_| anyhow!("unexpected txid length in wallet DB"))?;
        Ok(TxRow {
            txid: TxId::from_bytes(bytes).to_string(),
            mined_height,
            block_time,
            delta,
            fee,
            expired_unmined,
        })
    })
    .collect()
}

pub fn parse_account_id(s: &str) -> Option<AccountUuid> {
    Uuid::parse_str(s).ok().map(AccountUuid::from_uuid)
}
