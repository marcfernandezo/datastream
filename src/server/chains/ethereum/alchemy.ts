import { HttpError } from "@/server/http/client";
import type { SyncContext } from "../types";
import type { EthProvider, EthTransfer, TokenMeta } from "./provider";

/** Alchemy JSON-RPC (standard + alchemy_* enhanced methods). */

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

interface AssetTransfer {
  hash: string;
  blockNum: string;
  from: string;
  to: string | null;
  category: "external" | "internal" | "erc20";
  rawContract: { value: string | null; address: string | null; decimal: string | null };
  asset: string | null;
  metadata?: { blockTimestamp: string };
}

const MAX_COUNT = 100;

export interface AlchemyConfig {
  rpcUrl: string;
}

export function createAlchemyProvider(cfg: AlchemyConfig): EthProvider {
  async function rpc<T>(ctx: SyncContext, method: string, params: unknown[]): Promise<T> {
    const res = await ctx.http.json<RpcResponse<T>>(cfg.rpcUrl, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method, params },
      signal: ctx.signal,
      rps: 10,
    });
    if (res.error) {
      throw new HttpError(
        `Alchemy ${method}: ${res.error.message.slice(0, 120)}`,
        200,
        res.error.code === 429,
      );
    }
    return res.result as T;
  }

  const metaCache = new Map<string, TokenMeta>();
  async function tokenMeta(ctx: SyncContext, contract: string): Promise<TokenMeta> {
    const hit = metaCache.get(contract);
    if (hit) return hit;
    const m = await rpc<{ symbol: string | null; name: string | null; decimals: number | null }>(
      ctx,
      "alchemy_getTokenMetadata",
      [contract],
    );
    const meta = {
      contract,
      symbol: (m.symbol ?? "???").slice(0, 32),
      name: (m.name ?? "Unknown token").slice(0, 64),
      decimals: m.decimals ?? 0,
    };
    metaCache.set(contract, meta);
    return meta;
  }

  async function fetchDirection(
    ctx: SyncContext,
    address: string,
    direction: "fromAddress" | "toAddress",
    opts: { knownTxids: ReadonlySet<string>; maxPages: number },
  ) {
    const out: AssetTransfer[] = [];
    let pageKey: string | undefined;
    for (let page = 0; page < opts.maxPages; page++) {
      const res = await rpc<{ transfers: AssetTransfer[]; pageKey?: string }>(
        ctx,
        "alchemy_getAssetTransfers",
        [
          {
            [direction]: address,
            category: ["external", "internal", "erc20"],
            order: "desc",
            withMetadata: true,
            excludeZeroValue: true,
            maxCount: `0x${MAX_COUNT.toString(16)}`,
            ...(pageKey ? { pageKey } : {}),
          },
        ],
      );
      out.push(...res.transfers);
      pageKey = res.pageKey;
      if (!pageKey || res.transfers.some((t) => opts.knownTxids.has(t.hash))) break;
    }
    return out;
  }

  return {
    async nativeBalance(ctx, address) {
      return BigInt(await rpc<string>(ctx, "eth_getBalance", [address, "latest"]));
    },

    async transfers(ctx, address, opts) {
      const me = address.toLowerCase();
      const [sent, received] = await Promise.all([
        fetchDirection(ctx, address, "fromAddress", opts),
        fetchDirection(ctx, address, "toAddress", opts),
      ]);
      const unique = new Map<string, AssetTransfer>();
      for (const t of [...sent, ...received]) {
        unique.set(
          `${t.hash}:${t.category}:${t.rawContract.address}:${t.from}:${t.to}:${t.rawContract.value}`,
          t,
        );
      }

      const transfers: EthTransfer[] = [];
      const feePaid = new Set<string>();
      for (const t of unique.values()) {
        const token =
          t.category === "erc20" && t.rawContract.address
            ? await tokenMeta(ctx, t.rawContract.address.toLowerCase())
            : null;
        const from = t.from.toLowerCase();
        const transfer: EthTransfer = {
          hash: t.hash,
          blockNumber: parseInt(t.blockNum, 16),
          timeStamp: t.metadata ? Math.floor(Date.parse(t.metadata.blockTimestamp) / 1000) : 0,
          from,
          to: (t.to ?? "").toLowerCase(),
          value: BigInt(t.rawContract.value ?? "0x0"),
          token,
        };
        // Fees: one receipt lookup per tx we originated.
        if (from === me && t.category !== "internal" && !feePaid.has(t.hash)) {
          feePaid.add(t.hash);
          const receipt = await rpc<{
            gasUsed: string;
            effectiveGasPrice: string;
            status: string;
          } | null>(ctx, "eth_getTransactionReceipt", [t.hash]);
          if (receipt) {
            transfer.fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
            transfer.failed = receipt.status === "0x0";
          }
        }
        transfers.push(transfer);
      }
      return transfers;
    },

    async tokenBalances(ctx, address) {
      const out: { token: TokenMeta; amount: bigint }[] = [];
      let pageKey: string | undefined;
      do {
        const res = await rpc<{
          tokenBalances: { contractAddress: string; tokenBalance: string | null }[];
          pageKey?: string;
        }>(ctx, "alchemy_getTokenBalances", [address, "erc20", ...(pageKey ? [{ pageKey }] : [])]);
        for (const b of res.tokenBalances) {
          const amount = BigInt(b.tokenBalance ?? "0x0");
          if (amount === 0n) continue;
          out.push({ token: await tokenMeta(ctx, b.contractAddress.toLowerCase()), amount });
        }
        pageKey = res.pageKey;
      } while (pageKey);
      return out;
    },
  };
}
