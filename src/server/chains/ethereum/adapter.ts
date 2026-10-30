import { maskValue } from "@/server/log/mask";
import {
  SourceValidationError,
  type AssetInfo,
  type ChainAdapter,
  type NormalizedTx,
  type SyncContext,
} from "../types";
import { addTo, newestFirst } from "../util";
import { parseEvmAddress } from "./address";
import type { EthProvider, EthTransfer, TokenMeta } from "./provider";

export const ETH: AssetInfo = {
  id: "eth",
  network: "eth",
  contract: null,
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
  coingeckoId: "ethereum",
};

export const tokenAsset = (t: TokenMeta): AssetInfo => ({
  id: `eth:${t.contract}`,
  network: "eth",
  contract: t.contract,
  symbol: t.symbol || "???",
  name: t.name || "Unknown token",
  decimals: t.decimals,
  coingeckoId: null,
});

interface EthState {
  tokens?: TokenMeta[];
}

export interface EthereumConfig {
  provider: EthProvider;
  explorerUrl: string;
}

/** Groups transfers by tx hash into per-asset net movements for `me`. */
export function normalizeTransfers(transfers: EthTransfer[], me: string): NormalizedTx[] {
  const byHash = new Map<string, EthTransfer[]>();
  for (const t of transfers) byHash.set(t.hash, [...(byHash.get(t.hash) ?? []), t]);

  const txs: NormalizedTx[] = [];
  for (const [hash, group] of byHash) {
    const deltas = new Map<string, bigint>();
    const assets = new Map<string, AssetInfo>();
    let fee: bigint | null = null;
    let failed = false;
    for (const t of group) {
      if (t.fee !== undefined) fee = t.fee;
      if (t.failed) failed = true;
      if (t.value === 0n) continue;
      const asset = t.token ? tokenAsset(t.token) : ETH;
      assets.set(asset.id, asset);
      if (t.to === me) addTo(deltas, asset.id, t.value);
      if (t.from === me) addTo(deltas, asset.id, -t.value);
    }
    const first = group[0]!;
    txs.push({
      txid: hash,
      blockTime: first.timeStamp || null,
      blockHeight: first.blockNumber || null,
      status: failed ? "failed" : "confirmed",
      fee,
      movements: [...deltas]
        .filter(([, amount]) => amount !== 0n)
        .map(([id, amount]) => ({ asset: assets.get(id)!, amount })),
    });
  }
  return txs.sort(newestFirst);
}

export function createEthereumAdapter(cfg: EthereumConfig): ChainAdapter {
  const txMemo = (ctx: SyncContext) => ctx.memo.get("eth:touched") as Set<string> | undefined;

  return {
    network: "eth",
    label: "Ethereum",
    nativeAsset: ETH,
    supportedSources: ["address"],

    parseSource(kind, input) {
      if (kind !== "address") throw new SourceValidationError("Ethereum supports addresses only.");
      const value = parseEvmAddress(input);
      return { source: { kind, value, options: {} }, displayHint: maskValue(value) };
    },

    async getBalance(ctx, src) {
      return [{ asset: ETH, amount: await cfg.provider.nativeBalance(ctx, src.value) }];
    },

    async getTokens(ctx, src) {
      const state = ctx.state as EthState;
      const balances = await cfg.provider.tokenBalances(
        ctx,
        src.value,
        state.tokens ?? [],
        txMemo(ctx) ?? new Set(),
      );
      return balances.map(({ token, amount }) => ({ asset: tokenAsset(token), amount }));
    },

    async getTransactions(ctx, src, opts) {
      const me = src.value.toLowerCase();
      const transfers = await cfg.provider.transfers(ctx, src.value, opts);

      // Remember every token contract we've seen so balances can be refreshed.
      const state = ctx.state as EthState;
      const tokens = new Map((state.tokens ?? []).map((t) => [t.contract, t]));
      const touched = new Set<string>();
      for (const t of transfers) {
        if (!t.token) continue;
        tokens.set(t.token.contract, t.token);
        if (!opts.knownTxids.has(t.hash)) touched.add(t.token.contract);
      }
      state.tokens = [...tokens.values()];
      ctx.memo.set("eth:touched", touched);

      return normalizeTransfers(transfers, me);
    },

    explorerUrl(kind, id) {
      return `${cfg.explorerUrl.replace(/\/$/, "")}/${kind === "tx" ? "tx" : "address"}/${id}`;
    },
  };
}
