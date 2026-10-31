import { HttpError } from "@/server/http/client";
import type { SyncContext, TxFetchOptions } from "../types";
import type { EthProvider, EthTransfer, TokenMeta } from "./provider";

/** Etherscan API v2 (multichain, `chainid` param). Free tier: 5 req/s. */

interface EtherscanResponse<T> {
  status: "0" | "1";
  message: string;
  result: T;
}

interface NormalTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  gasUsed: string;
  gasPrice: string;
  isError: string;
}

interface InternalTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  isError: string;
}

interface TokenTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  contractAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

const PAGE_SIZE = 100;
/** Full token balance refresh interval (catches rebasing tokens). */
const FULL_REFRESH_MS = 24 * 3_600_000;

export interface EtherscanConfig {
  apiUrl: string;
  apiKey: string | undefined;
  chainId: number;
}

export function createEtherscanProvider(cfg: EtherscanConfig): EthProvider {
  async function call<T>(ctx: SyncContext, params: Record<string, string>): Promise<T> {
    const url = new URL(cfg.apiUrl);
    url.searchParams.set("chainid", String(cfg.chainId));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (cfg.apiKey) url.searchParams.set("apikey", cfg.apiKey);

    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await ctx.http.json<EtherscanResponse<T>>(url.toString(), {
        signal: ctx.signal,
        rps: 4,
      });
      if (res.status === "1") return res.result;
      // "No transactions found" / "No records found" are empty results, not errors.
      if (
        /^No (transactions|records) found/i.test(res.message) ||
        (Array.isArray(res.result) && res.result.length === 0)
      ) {
        return res.result;
      }
      const detail = typeof res.result === "string" ? res.result : res.message;
      if (/rate limit/i.test(detail)) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw new HttpError(`Etherscan error: ${detail.slice(0, 120)}`, 200, false);
    }
    throw new HttpError("Etherscan rate limit persisted", 429, true);
  }

  async function paged<T extends { hash: string }>(
    ctx: SyncContext,
    action: string,
    address: string,
    opts: TxFetchOptions,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= opts.maxPages && page * PAGE_SIZE <= 10_000; page++) {
      const rows = await call<T[]>(ctx, {
        module: "account",
        action,
        address,
        page: String(page),
        offset: String(PAGE_SIZE),
        sort: "desc",
      });
      out.push(...rows);
      if (rows.length < PAGE_SIZE || rows.some((r) => opts.knownTxids.has(r.hash))) break;
    }
    return out;
  }

  return {
    async nativeBalance(ctx, address) {
      return BigInt(
        await call<string>(ctx, { module: "account", action: "balance", address, tag: "latest" }),
      );
    },

    async transfers(ctx, address, opts) {
      const me = address.toLowerCase();
      const [normal, internal, tokens] = await Promise.all([
        paged<NormalTx>(ctx, "txlist", address, opts),
        paged<InternalTx>(ctx, "txlistinternal", address, opts),
        paged<TokenTx>(ctx, "tokentx", address, opts),
      ]);
      const transfers: EthTransfer[] = [];
      for (const t of normal) {
        const failed = t.isError === "1";
        transfers.push({
          hash: t.hash,
          blockNumber: Number(t.blockNumber),
          timeStamp: Number(t.timeStamp),
          from: t.from.toLowerCase(),
          to: (t.to || "").toLowerCase(),
          value: failed ? 0n : BigInt(t.value),
          token: null,
          fee: t.from.toLowerCase() === me ? BigInt(t.gasUsed) * BigInt(t.gasPrice) : undefined,
          failed,
        });
      }
      for (const t of internal) {
        if (t.isError === "1") continue;
        transfers.push({
          hash: t.hash,
          blockNumber: Number(t.blockNumber),
          timeStamp: Number(t.timeStamp),
          from: t.from.toLowerCase(),
          to: t.to.toLowerCase(),
          value: BigInt(t.value),
          token: null,
        });
      }
      for (const t of tokens) {
        transfers.push({
          hash: t.hash,
          blockNumber: Number(t.blockNumber),
          timeStamp: Number(t.timeStamp),
          from: t.from.toLowerCase(),
          to: t.to.toLowerCase(),
          value: BigInt(t.value),
          token: {
            contract: t.contractAddress.toLowerCase(),
            symbol: t.tokenSymbol.slice(0, 32),
            name: t.tokenName.slice(0, 64),
            decimals: Number(t.tokenDecimal) || 0,
          },
        });
      }
      return transfers;
    },

    async tokenBalances(ctx, address, known, touched) {
      const now = Date.now();
      const state = ctx.state as {
        tokenBalances?: Record<string, string>;
        tokenRefreshedAt?: number;
      };
      const cache = state.tokenBalances ?? {};
      const full = !state.tokenRefreshedAt || now - state.tokenRefreshedAt > FULL_REFRESH_MS;

      const out: { token: TokenMeta; amount: bigint }[] = [];
      for (const token of known) {
        let amount: bigint;
        if (full || touched.has(token.contract) || cache[token.contract] === undefined) {
          amount = BigInt(
            await call<string>(ctx, {
              module: "account",
              action: "tokenbalance",
              contractaddress: token.contract,
              address,
              tag: "latest",
            }),
          );
          cache[token.contract] = amount.toString();
        } else {
          amount = BigInt(cache[token.contract]!);
        }
        out.push({ token, amount });
      }
      state.tokenBalances = cache;
      if (full) state.tokenRefreshedAt = now;
      return out;
    },
  };
}
