import { bech32m } from "@scure/base";
import { HttpError } from "@/server/http/client";
import {
  SourceValidationError,
  SyncPendingError,
  type ForgetContext,
  type NormalizedTx,
  type SyncContext,
  type TxFetchOptions,
  type WalletSource,
} from "../types";
import { newestFirst } from "../util";

/**
 * Shielded Zcash through the zcash-viewer sidecar (sidecars/zcash-viewer).
 *
 * The sidecar imports the Unified Full Viewing Key as a view-only account,
 * syncs it from lightwalletd and keeps the (SQLCipher-encrypted) wallet DB.
 * Datastream only talks to it over the internal network with a bearer token;
 * it never contacts lightwalletd itself.
 */

export interface ZcashViewerConfig {
  url: string;
  token: string;
}

const SAPLING_ACTIVATION = 419_200;
const MAX_HEIGHT = 50_000_000;
const PAGE = 200;
/** A ready account whose sidecar hasn't synced for this long reports an error. */
const STALE_AFTER_S = 30 * 60;

/**
 * Real (height, unix time) checkpoints from mainnet. Block time is 150 s before
 * Blossom (653 600) and 75 s after; interpolation between checkpoints stays
 * within a few hundred blocks.
 */
const CHECKPOINTS: readonly [height: number, time: number][] = [
  [419_200, 1_540_779_337], // Sapling activation
  [653_600, 1_576_101_005], // Blossom
  [1_687_104, 1_654_019_405], // NU5 (Orchard)
  [2_000_000, 1_677_602_242],
  [2_500_000, 1_715_296_781],
  [3_000_000, 1_752_983_473],
  [3_500_000, 1_790_662_825],
];
/** Start scanning a little before the date given, in case the estimate runs late. */
const DATE_MARGIN_BLOCKS = 2 * 1152;

/** Estimated mainnet height at a unix time. Clamped to Sapling activation. */
export function estimateHeight(unixSeconds: number): number {
  const first = CHECKPOINTS[0]!;
  if (unixSeconds <= first[1]) return first[0];
  for (let i = 1; i < CHECKPOINTS.length; i++) {
    const [h1, t1] = CHECKPOINTS[i]!;
    if (unixSeconds <= t1) {
      const [h0, t0] = CHECKPOINTS[i - 1]!;
      return Math.floor(h0 + ((unixSeconds - t0) * (h1 - h0)) / (t1 - t0));
    }
  }
  const [hl, tl] = CHECKPOINTS.at(-1)!;
  return Math.floor(hl + (unixSeconds - tl) / 75);
}

/**
 * Wallet birthday from the add-wallet form: a block height, a YYYY-MM-DD date
 * (converted to an estimated height, minus a margin) or empty for the
 * sidecar's default (NU5 activation, May 2022).
 */
export function parseBirthday(raw: unknown, now = Date.now()): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (s === "") return undefined;
  if (/^\d{1,9}$/.test(s)) {
    const h = Number(s);
    if (h < SAPLING_ACTIVATION || h > MAX_HEIGHT) {
      throw new SourceValidationError(
        `Birthday height must be at least ${SAPLING_ACTIVATION} (Sapling activation).`,
      );
    }
    return h;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  if (!m || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) {
    throw new SourceValidationError("Birthday must be a block height or a date (YYYY-MM-DD).");
  }
  if (t > now) throw new SourceValidationError("Birthday can't be in the future.");
  return Math.max(SAPLING_ACTIVATION, estimateHeight(t / 1000) - DATE_MARGIN_BLOCKS);
}

/**
 * Checks the Bech32m envelope and network prefix of a mainnet UFVK. The
 * sidecar does the full ZIP 316 parse when it imports the key.
 */
export function parseUfvk(input: string): string {
  const s = input.trim().toLowerCase();
  if (/^uivk1/.test(s)) {
    throw new SourceValidationError(
      "That's an incoming viewing key (uivk). Use the full viewing key (uview1…) so spends are tracked too.",
    );
  }
  if (/^uviewtest1/.test(s))
    throw new SourceValidationError("Testnet viewing keys aren't supported.");
  try {
    const { prefix, words } = bech32m.decode(s as `${string}1${string}`, false);
    // Smallest valid UFVK (one Orchard or Sapling item + padding) is well over 100 bytes.
    if (prefix !== "uview" || bech32m.fromWords(words).length < 100) throw new Error();
  } catch {
    throw new SourceValidationError("Invalid unified full viewing key (uview1…).");
  }
  return s;
}

export function displayUfvk(value: string): string {
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
}

interface ImportResponse {
  accountId: string;
  created: boolean;
  birthdayHeight: number;
}

interface AccountResponse {
  accountId: string;
  birthdayHeight: number;
  ready: boolean;
  progress: { scanned: number; total: number } | null;
  balance: { total: string };
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  chainTipHeight: number | null;
  fullyScannedHeight: number | null;
}

interface TxRow {
  txid: string;
  minedHeight: number | null;
  blockTime: number | null;
  delta: number;
  fee: number | null;
  expiredUnmined: boolean;
}

interface TxPage {
  transactions: TxRow[];
  hasMore: boolean;
}

type Ctx = Pick<SyncContext, "http" | "signal">;

export function createShieldedClient(
  cfg: ZcashViewerConfig,
  nativeAsset: NormalizedTx["movements"][number]["asset"],
) {
  const base = cfg.url.replace(/\/$/, "");

  async function call<T>(
    ctx: Ctx,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ) {
    try {
      return await ctx.http.json<T>(`${base}${path}`, {
        method,
        body,
        signal: ctx.signal,
        headers: { authorization: `Bearer ${cfg.token}` },
        rps: 50,
        retries: 2,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 401) throw new Error("zcash-viewer rejected ZCASH_VIEWER_TOKEN");
        if (err.status === 400)
          throw new Error("zcash-viewer rejected the viewing key (malformed or wrong network)");
        if (err.status === 0) throw new Error(`zcash-viewer unreachable: ${err.message}`);
      }
      throw err;
    }
  }

  /** Imports the key if needed (idempotent) and returns the account, once per sync. */
  async function account(ctx: SyncContext, src: WalletSource): Promise<AccountResponse> {
    const cached = ctx.memo.get("zec:viewer:account") as AccountResponse | undefined;
    if (cached) return cached;

    const birthdayHeight =
      typeof src.options.birthdayHeight === "number" ? src.options.birthdayHeight : undefined;
    const imported = await call<ImportResponse>(ctx, "POST", "/v1/accounts", {
      ufvk: src.value,
      ...(birthdayHeight ? { birthdayHeight } : {}),
    });
    // Persisted even while pending, so deleting the wallet can release the key.
    ctx.state.viewerAccountId = imported.accountId;

    const acc = await call<AccountResponse>(ctx, "GET", `/v1/accounts/${imported.accountId}`);
    if (!acc.ready) {
      const p = acc.progress;
      const pct =
        p && p.total > 0 ? ` ${Math.min(99, Math.floor((100 * p.scanned) / p.total))}%` : "";
      const detail = acc.lastError ? ` (retrying: ${acc.lastError.slice(0, 120)})` : "";
      throw new SyncPendingError(`Scanning shielded history${pct}${detail}`);
    }
    const now = Math.floor(Date.now() / 1000);
    if (acc.lastError && (acc.lastSyncAt === null || now - acc.lastSyncAt > STALE_AFTER_S)) {
      throw new Error(`zcash-viewer can't sync: ${acc.lastError.slice(0, 200)}`);
    }
    ctx.memo.set("zec:viewer:account", acc);
    return acc;
  }

  return {
    async getBalance(ctx: SyncContext, src: WalletSource) {
      const acc = await account(ctx, src);
      return [{ asset: nativeAsset, amount: BigInt(acc.balance.total) }];
    },

    async getTransactions(
      ctx: SyncContext,
      src: WalletSource,
      opts: TxFetchOptions,
    ): Promise<NormalizedTx[]> {
      const acc = await account(ctx, src);
      const rows: TxRow[] = [];
      for (let page = 0; page < opts.maxPages; page++) {
        const res = await call<TxPage>(
          ctx,
          "GET",
          `/v1/accounts/${acc.accountId}/transactions?limit=${PAGE}&offset=${page * PAGE}`,
        );
        rows.push(...res.transactions);
        const reachedKnown = res.transactions.some(
          (t) => t.minedHeight !== null && opts.knownTxids.has(t.txid),
        );
        if (reachedKnown || !res.hasMore) break;
      }

      return rows
        .filter((t) => !opts.knownTxids.has(t.txid) || t.minedHeight === null)
        .map((t): NormalizedTx => {
          const fee = t.fee !== null ? BigInt(t.fee) : null;
          // `delta` includes the fee when this account paid it.
          const amount = BigInt(t.delta) + (fee ?? 0n);
          return {
            txid: t.txid,
            blockTime: t.minedHeight === null ? null : t.blockTime,
            blockHeight: t.minedHeight,
            status: t.expiredUnmined ? "failed" : t.minedHeight === null ? "pending" : "confirmed",
            fee,
            movements: amount === 0n ? [] : [{ asset: nativeAsset, amount }],
          };
        })
        .sort(newestFirst);
    },

    async forget(ctx: ForgetContext, state: Record<string, unknown>) {
      const id = state.viewerAccountId;
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return;
      await call<void>(ctx, "DELETE", `/v1/accounts/${id}`);
      ctx.log.info("shielded viewing key released from zcash-viewer");
    },
  };
}
