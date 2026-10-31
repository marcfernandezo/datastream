import { sha256 } from "@noble/hashes/sha2.js";
import { bech32m, createBase58check } from "@scure/base";
import { maskValue } from "@/server/log/mask";
import {
  SourceValidationError,
  type AssetInfo,
  type ChainAdapter,
  type NormalizedTx,
  type SyncContext,
} from "../types";
import { newestFirst } from "../util";

/**
 * Zcash transparent addresses via a Blockchair-compatible explorer API.
 * Isolated module: shielded support (UFVK + lightwalletd) will live in a
 * separate sidecar and must not change this adapter's contract.
 */

export const ZEC: AssetInfo = {
  id: "zec",
  network: "zec",
  contract: null,
  symbol: "ZEC",
  name: "Zcash",
  decimals: 8,
  coingeckoId: "zcash",
};

const b58c = createBase58check(sha256);
const T1 = [0x1c, 0xb8]; // P2PKH
const T3 = [0x1c, 0xbd]; // P2SH
const PAGE = 100;
const TX_BATCH = 10;

/**
 * Validates a mainnet transparent address. ZIP-320 TEX addresses (tex1…)
 * carry a P2PKH hash, so they're converted to the equivalent t1 address.
 */
export function parseZcashTransparent(input: string): string {
  const s = input.trim();
  if (/^tex1/i.test(s)) {
    try {
      const { prefix, words } = bech32m.decode(s.toLowerCase() as `${string}1${string}`);
      const hash = bech32m.fromWords(words);
      if (prefix !== "tex" || hash.length !== 20) throw new Error();
      return b58c.encode(Uint8Array.from([...T1, ...hash]));
    } catch {
      throw new SourceValidationError("Invalid TEX address.");
    }
  }
  let payload: Uint8Array;
  try {
    payload = b58c.decode(s);
  } catch {
    throw new SourceValidationError("Invalid Zcash transparent address.");
  }
  const v = [payload[0], payload[1]];
  const ok = (v[0] === T1[0] && v[1] === T1[1]) || (v[0] === T3[0] && v[1] === T3[1]);
  if (payload.length !== 22 || !ok)
    throw new SourceValidationError("Invalid Zcash transparent address (t1…/t3…).");
  return s;
}

interface BlockchairResponse<T> {
  data: T | null;
  context: { code: number; error?: string };
}

interface AddressDashboard {
  address: { balance: number; transaction_count: number };
  transactions: { block_id: number; hash: string; time: string; balance_change: number }[];
}

interface TxDashboard {
  transaction: { hash: string; fee: number; block_id: number };
}

export interface ZcashConfig {
  apiUrl: string;
  apiKey: string | undefined;
  explorerUrl: string;
  rps: number;
}

const parseTime = (t: string) => Math.floor(Date.parse(`${t.replace(" ", "T")}Z`) / 1000);

export function createZcashAdapter(cfg: ZcashConfig): ChainAdapter {
  async function get<T>(
    ctx: SyncContext,
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(`${cfg.apiUrl.replace(/\/$/, "")}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (cfg.apiKey) url.searchParams.set("key", cfg.apiKey);
    const res = await ctx.http.json<BlockchairResponse<T>>(url.toString(), {
      signal: ctx.signal,
      rps: cfg.rps,
    });
    if (res.context.code !== 200 || !res.data) {
      throw new Error(
        `Zcash explorer error ${res.context.code}${res.context.error ? `: ${res.context.error.slice(0, 80)}` : ""}`,
      );
    }
    return res.data;
  }

  async function dashboard(ctx: SyncContext, address: string, offset: number) {
    const data = await get<Record<string, AddressDashboard>>(
      ctx,
      `/dashboards/address/${encodeURIComponent(address)}`,
      {
        transaction_details: "true",
        limit: String(PAGE),
        offset: String(offset),
      },
    );
    const d = data[address] ?? Object.values(data)[0];
    if (!d) throw new Error("Zcash explorer returned no data for the address");
    return d;
  }

  return {
    network: "zec",
    label: "Zcash",
    nativeAsset: ZEC,
    supportedSources: ["address"],
    initialMaxPages: 10,

    parseSource(kind, input) {
      if (kind === "ufvk") {
        throw new SourceValidationError(
          "Shielded viewing keys aren't supported yet. Add a transparent address (t1…/t3…/tex1…) for now.",
        );
      }
      if (kind !== "address")
        throw new SourceValidationError("Zcash supports transparent addresses.");
      const value = parseZcashTransparent(input);
      return { source: { kind, value, options: {} }, displayHint: maskValue(value) };
    },

    async getBalance(ctx, src) {
      const cached = ctx.memo.get("zec:first") as AddressDashboard | undefined;
      const d = cached ?? (await dashboard(ctx, src.value, 0));
      return [{ asset: ZEC, amount: BigInt(d.address.balance) }];
    },

    async getTokens() {
      return [];
    },

    async getTransactions(ctx, src, opts) {
      const rows: AddressDashboard["transactions"] = [];
      for (let page = 0; page < opts.maxPages; page++) {
        const d = await dashboard(ctx, src.value, page * PAGE);
        if (page === 0) ctx.memo.set("zec:first", d);
        rows.push(...d.transactions);
        const reachedKnown = d.transactions.some(
          (t) => t.block_id > 0 && opts.knownTxids.has(t.hash),
        );
        if (reachedKnown || d.transactions.length < PAGE) break;
      }

      // balance_change includes the fee when we spent; fetch fees for those only.
      const fresh = rows.filter((t) => !opts.knownTxids.has(t.hash) || t.block_id <= 0);
      const spent = fresh.filter((t) => t.balance_change < 0).map((t) => t.hash);
      const fees = new Map<string, number>();
      for (let i = 0; i < spent.length; i += TX_BATCH) {
        const batch = spent.slice(i, i + TX_BATCH);
        const data = await get<Record<string, TxDashboard>>(
          ctx,
          `/dashboards/transactions/${batch.join(",")}`,
        );
        for (const [hash, d] of Object.entries(data)) fees.set(hash, d.transaction.fee);
      }

      return fresh
        .map((t): NormalizedTx => {
          const pending = t.block_id <= 0;
          const feeRaw = fees.get(t.hash);
          const fee = t.balance_change < 0 && feeRaw !== undefined ? BigInt(feeRaw) : null;
          const amount = BigInt(t.balance_change) + (fee ?? 0n);
          return {
            txid: t.hash,
            blockTime: pending ? null : parseTime(t.time),
            blockHeight: pending ? null : t.block_id,
            status: pending ? "pending" : "confirmed",
            fee,
            movements: amount === 0n ? [] : [{ asset: ZEC, amount }],
          };
        })
        .sort(newestFirst);
    },

    explorerUrl(kind, id) {
      return `${cfg.explorerUrl.replace(/\/$/, "")}/${kind === "tx" ? "transaction" : "address"}/${id}`;
    },
  };
}
