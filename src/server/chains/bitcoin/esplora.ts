import type { HttpClient } from "@/server/http/client";

/** Subset of the Esplora REST API (Blockstream/mempool.space/electrs). */

export interface EsploraStats {
  funded_txo_sum: number;
  spent_txo_sum: number;
  tx_count: number;
}

export interface EsploraAddress {
  chain_stats: EsploraStats;
  mempool_stats: EsploraStats;
}

export interface EsploraTx {
  txid: string;
  fee: number;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
  vin: {
    is_coinbase?: boolean;
    prevout: { scriptpubkey_address?: string; value: number } | null;
  }[];
  vout: { scriptpubkey_address?: string; value: number }[];
}

/** Esplora returns up to 25 confirmed txs per page. */
export const ESPLORA_PAGE_SIZE = 25;

export class EsploraClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    private readonly signal: AbortSignal,
    private readonly rps?: number,
  ) {}

  private get<T>(path: string) {
    return this.http.json<T>(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      signal: this.signal,
      ...(this.rps ? { rps: this.rps } : {}),
    });
  }

  address(addr: string) {
    return this.get<EsploraAddress>(`/address/${encodeURIComponent(addr)}`);
  }

  /** First page: mempool txs plus the newest confirmed ones. */
  txs(addr: string) {
    return this.get<EsploraTx[]>(`/address/${encodeURIComponent(addr)}/txs`);
  }

  txsAfter(addr: string, lastSeenTxid: string) {
    return this.get<EsploraTx[]>(
      `/address/${encodeURIComponent(addr)}/txs/chain/${encodeURIComponent(lastSeenTxid)}`,
    );
  }
}

export const txCount = (a: EsploraAddress) => a.chain_stats.tx_count + a.mempool_stats.tx_count;

export const balanceOf = (a: EsploraAddress) =>
  BigInt(a.chain_stats.funded_txo_sum - a.chain_stats.spent_txo_sum) +
  BigInt(a.mempool_stats.funded_txo_sum - a.mempool_stats.spent_txo_sum);
