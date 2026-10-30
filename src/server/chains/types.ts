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
}

export class SourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceValidationError";
  }
}
