import type { SyncContext, TxFetchOptions } from "../types";

export interface TokenMeta {
  contract: string; // lowercase
  symbol: string;
  name: string;
  decimals: number;
}

/** One value transfer touching our address. Several can share a hash. */
export interface EthTransfer {
  hash: string;
  blockNumber: number;
  timeStamp: number;
  from: string; // lowercase
  to: string; // lowercase
  value: bigint;
  token: TokenMeta | null; // null = ETH
  /** Set on the top-level tx record when we sent it. */
  fee?: bigint;
  failed?: boolean;
}

export interface EthProvider {
  nativeBalance(ctx: SyncContext, address: string): Promise<bigint>;
  /** All transfers involving the address, newest first, stopping at known txids. */
  transfers(ctx: SyncContext, address: string, opts: TxFetchOptions): Promise<EthTransfer[]>;
  /**
   * Current ERC-20 balances. `touched` holds contracts with new transfers in
   * this sync so providers can skip unchanged ones.
   */
  tokenBalances(
    ctx: SyncContext,
    address: string,
    known: TokenMeta[],
    touched: ReadonlySet<string>,
  ): Promise<{ token: TokenMeta; amount: bigint }[]>;
}
