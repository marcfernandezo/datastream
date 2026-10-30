import { env } from "@/env";
import { createHttpClient, type HttpClient } from "@/server/http/client";
import { createBitcoinAdapter } from "./bitcoin/adapter";
import { createEthereumAdapter } from "./ethereum/adapter";
import { createAlchemyProvider } from "./ethereum/alchemy";
import { createEtherscanProvider } from "./ethereum/etherscan";
import { createSolanaAdapter } from "./solana/adapter";
import type { ChainAdapter, NetworkId } from "./types";

/**
 * Network registry. To add a network: implement ChainAdapter in
 * src/server/chains/<network>/, add its config to src/env.ts and register it
 * in `build()` below. See README → "Adding a network".
 */

let adapters: Map<NetworkId, ChainAdapter> | undefined;
let http: HttpClient | undefined;

function build(): Map<NetworkId, ChainAdapter> {
  const e = env();
  const list: ChainAdapter[] = [
    createBitcoinAdapter({
      esploraUrl: e.BTC_ESPLORA_URL,
      explorerUrl: e.BTC_EXPLORER_URL,
      gapLimit: e.BTC_GAP_LIMIT,
      rps: e.BTC_ESPLORA_RPS,
    }),
    createEthereumAdapter({
      explorerUrl: e.ETH_EXPLORER_URL,
      provider:
        e.ETH_PROVIDER === "alchemy"
          ? createAlchemyProvider({
              rpcUrl:
                e.ALCHEMY_API_URL ?? `https://eth-mainnet.g.alchemy.com/v2/${e.ALCHEMY_API_KEY}`,
            })
          : createEtherscanProvider({
              apiUrl: e.ETHERSCAN_API_URL,
              apiKey: e.ETHERSCAN_API_KEY,
              chainId: 1,
            }),
    }),
    createSolanaAdapter(
      e.SOL_PROVIDER === "helius"
        ? {
            rpcUrl: `${e.HELIUS_RPC_URL.replace(/\/$/, "")}/?api-key=${e.HELIUS_API_KEY}`,
            dasEnabled: true,
            explorerUrl: e.SOL_EXPLORER_URL,
            rps: 10,
            initialPages: 10,
          }
        : {
            rpcUrl: e.SOL_RPC_URL,
            dasEnabled: false,
            explorerUrl: e.SOL_EXPLORER_URL,
            rps: e.SOL_RPC_RPS,
            initialPages: 4,
          },
    ),
  ];
  return new Map(list.map((a) => [a.network, a]));
}

export function getAdapters(): Map<NetworkId, ChainAdapter> {
  adapters ??= build();
  return adapters;
}

export function getAdapter(network: string): ChainAdapter {
  const adapter = getAdapters().get(network as NetworkId);
  if (!adapter) throw new Error(`Unsupported network: ${network}`);
  return adapter;
}

export function isNetwork(network: string): network is NetworkId {
  return getAdapters().has(network as NetworkId);
}

export function sharedHttp(): HttpClient {
  http ??= createHttpClient({ timeoutMs: env().HTTP_TIMEOUT_MS, userAgent: "datastream/1.0" });
  return http;
}

/** Test helper. */
export function setAdaptersForTests(list: ChainAdapter[] | undefined) {
  adapters = list ? new Map(list.map((a) => [a.network, a])) : undefined;
}
