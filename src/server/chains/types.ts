import type { Logger } from "pino";
import type { HttpClient } from "@/server/http/client";

export type NetworkId = "btc" | "eth" | "sol" | "zec";
export type SourceKind = "address" | "xpub" | "ufvk";

/** Canonical, validated wallet source. `value` is never logged. */
export interface WalletSource {
  kind: SourceKind;
  value: string;
  options: Record<string, unknown>;
}

export interface AssetInfo {
  /** `btc`, `eth`, `sol`, `zec` or `<network>:<contract|mint>` */
  id: string;
  network: NetworkId;
  contract: string | null;
  symbol: string;
  name: string;
  decimals: number;
  coingeckoId: string | null;
}

export interface AssetAmount {
  asset: AssetInfo;
  /** Base units. */
  amount: bigint;
}

export interface NormalizedTx {
  txid: string;
  /** Unix seconds; null while pending. */
  blockTime: number | null;
  blockHeight: number | null;
  status: "pending" | "confirmed" | "failed";
  /** Fee paid by this wallet in native base units, or null if someone else paid. */
  fee: bigint | null;
  /** Net change per asset for this wallet, excluding the fee. */
  movements: AssetAmount[];
}

export interface TxFetchOptions {
  /** Confirmed txids already stored; paging stops once a page reaches them. */
  knownTxids: ReadonlySet<string>;
  /** Upper bound on provider pages per sync, to protect free API tiers. */
  maxPages: number;
}

export interface SyncContext {
  http: HttpClient;
  signal: AbortSignal;
  log: Logger;
  /** Adapter-owned persistent state (e.g. BTC gap-limit marks). Mutate in place. */
  state: Record<string, unknown>;
  /** Per-sync scratch space so balance and history can share expensive scans. */
  memo: Map<string, unknown>;
}

/** What `ChainAdapter.forget` gets: no adapter state scratch space, no memo. */
export interface ForgetContext {
  http: HttpClient;
  signal: AbortSignal;
  log: Logger;
}

export interface ParsedSource {
  source: WalletSource;
  /** Masked display form, e.g. `bc1q…x7f2`. */
  displayHint: string;
}

export interface SourceOption {
  key: string;
  label: string;
  choices: { value: string; label: string }[];
  /** Only shown when the input matches this predicate (evaluated client-side by name). */
  appliesTo?: "xpub-ambiguous";
}

export interface ChainAdapter {
  network: NetworkId;
  label: string;
  nativeAsset: AssetInfo;
  supportedSources: SourceKind[];
  /**
   * Page budget for a wallet's first sync. Defaults to 40; lower it for
   * providers where each page is expensive (e.g. one RPC call per tx).
   */
  initialMaxPages?: number;
  /** Optional per-source options rendered in the add-wallet form. */
  sourceOptions?: Partial<Record<SourceKind, SourceOption[]>>;
  /** Validates and canonicalizes user input. Throws SourceValidationError. */
  parseSource(kind: SourceKind, input: string, options: Record<string, unknown>): ParsedSource;
  /** Native asset balance. */
  getBalance(ctx: SyncContext, src: WalletSource): Promise<AssetAmount[]>;
  /** Token balances (ERC-20, SPL…). Empty for networks without tokens. */
  getTokens(ctx: SyncContext, src: WalletSource): Promise<AssetAmount[]>;
  /** Newest first. */
  getTransactions(
    ctx: SyncContext,
    src: WalletSource,
    opts: TxFetchOptions,
  ): Promise<NormalizedTx[]>;
  explorerUrl(kind: "tx" | "address", id: string): string;
  /** How to show the source to its owner (e.g. zpub instead of the normalized xpub). */
  displaySource?(src: WalletSource): string;
  /**
   * Called by the worker after a wallet is deleted, with the adapter's last
   * persisted sync state. Releases provider-side data, e.g. a viewing key
   * imported into the shielded Zcash sidecar. Must be idempotent.
   */
  forget?(ctx: ForgetContext, state: Record<string, unknown>): Promise<void>;
}

/**
 * The provider can't answer completely yet (e.g. a first shielded scan is
 * still running). The sync is retried later without counting as a failure,
 * no partial data is stored (so old transactions never trigger alerts), and
 * `message` is shown as progress. Adapter state is persisted.
 */
export class SyncPendingError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs = 60_000,
  ) {
    super(message);
    this.name = "SyncPendingError";
  }
}

export class SourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceValidationError";
  }
}
