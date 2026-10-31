import { base58 } from "@scure/base";
import { HttpError } from "@/server/http/client";
import { maskValue } from "@/server/log/mask";
import {
  SourceValidationError,
  type AssetAmount,
  type AssetInfo,
  type ChainAdapter,
  type NormalizedTx,
  type SyncContext,
} from "../types";
import { addTo, newestFirst } from "../util";

export const SOL: AssetInfo = {
  id: "sol",
  network: "sol",
  contract: null,
  symbol: "SOL",
  name: "Solana",
  decimals: 9,
  coingeckoId: "solana",
};

const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

/** Metadata for common mints when no DAS API is available. CoinGecko fills the rest. */
const WELL_KNOWN_MINTS: Record<string, { symbol: string; name: string }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", name: "USD Coin" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", name: "Tether USD" },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", name: "Jupiter" },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", name: "Bonk" },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: "mSOL", name: "Marinade staked SOL" },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: "JitoSOL", name: "Jito Staked SOL" },
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": {
    symbol: "WETH",
    name: "Wrapped Ether (Wormhole)",
  },
};

const SIGNATURE_PAGE = 50;

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

interface ParsedTokenAccount {
  account: {
    data: {
      parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } };
    };
  };
}

interface TokenBalanceEntry {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

interface SolTx {
  blockTime: number | null;
  slot: number;
  meta: {
    fee: number;
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalanceEntry[];
    postTokenBalances?: TokenBalanceEntry[];
  } | null;
  transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[] } };
}

interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

export interface SolanaConfig {
  rpcUrl: string;
  /** Helius: enables DAS `getAssetBatch` for token metadata. */
  dasEnabled: boolean;
  explorerUrl: string;
  rps: number;
  /** First-sync history depth, in pages of 50 signatures. */
  initialPages: number;
}

export function createSolanaAdapter(cfg: SolanaConfig): ChainAdapter {
  async function rpc<T>(ctx: SyncContext, method: string, params: unknown): Promise<T> {
    const res = await ctx.http.json<RpcResponse<T>>(cfg.rpcUrl, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method, params },
      signal: ctx.signal,
      rps: cfg.rps,
    });
    if (res.error) {
      const retryable = res.error.code === 429 || res.error.code === -32429;
      throw new HttpError(`Solana ${method}: ${res.error.message.slice(0, 120)}`, 200, retryable);
    }
    return res.result as T;
  }

  const mintAsset = (
    mint: string,
    decimals: number,
    meta?: { symbol: string; name: string },
  ): AssetInfo => {
    const known = meta ?? WELL_KNOWN_MINTS[mint];
    return {
      id: `sol:${mint}`,
      network: "sol",
      contract: mint,
      symbol: known?.symbol?.slice(0, 32) || maskValue(mint),
      name: known?.name?.slice(0, 64) || "SPL token",
      decimals,
      coingeckoId: null,
    };
  };

  async function dasMetadata(ctx: SyncContext, mints: string[]) {
    const out = new Map<string, { symbol: string; name: string }>();
    if (!cfg.dasEnabled || mints.length === 0) return out;
    for (let i = 0; i < mints.length; i += 100) {
      const assets = await rpc<
        ({
          id: string;
          content?: { metadata?: { symbol?: string; name?: string } };
          token_info?: { symbol?: string };
        } | null)[]
      >(ctx, "getAssetBatch", { ids: mints.slice(i, i + 100) });
      for (const a of assets) {
        if (!a) continue;
        const symbol = a.token_info?.symbol || a.content?.metadata?.symbol;
        const name = a.content?.metadata?.name;
        if (symbol) out.set(a.id, { symbol, name: name || symbol });
      }
    }
    return out;
  }

  function normalize(sig: SignatureInfo, tx: SolTx | null, me: string): NormalizedTx {
    const base = {
      txid: sig.signature,
      blockTime: tx?.blockTime ?? sig.blockTime,
      blockHeight: tx?.slot ?? sig.slot,
      status: sig.err || tx?.meta?.err ? ("failed" as const) : ("confirmed" as const),
    };
    if (!tx?.meta) return { ...base, fee: null, movements: [] };

    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
    const idx = keys.indexOf(me);
    const feePayer = keys[0] === me;
    const fee = feePayer ? BigInt(tx.meta.fee) : null;

    const movements: AssetAmount[] = [];
    if (idx >= 0) {
      const delta = BigInt(tx.meta.postBalances[idx]! - tx.meta.preBalances[idx]!) + (fee ?? 0n);
      if (delta !== 0n) movements.push({ asset: SOL, amount: delta });
    }

    const tokenDeltas = new Map<string, bigint>();
    const decimals = new Map<string, number>();
    for (const [entries, sign] of [
      [tx.meta.postTokenBalances ?? [], 1n],
      [tx.meta.preTokenBalances ?? [], -1n],
    ] as const) {
      for (const b of entries) {
        if (b.owner !== me) continue;
        addTo(tokenDeltas, b.mint, sign * BigInt(b.uiTokenAmount.amount));
        decimals.set(b.mint, b.uiTokenAmount.decimals);
      }
    }
    for (const [mint, amount] of tokenDeltas) {
      if (amount !== 0n)
        movements.push({ asset: mintAsset(mint, decimals.get(mint) ?? 0), amount });
    }
    return { ...base, fee, movements };
  }

  return {
    network: "sol",
    label: "Solana",
    nativeAsset: SOL,
    supportedSources: ["address"],
    initialMaxPages: cfg.initialPages,

    parseSource(kind, input) {
      if (kind !== "address") throw new SourceValidationError("Solana supports addresses only.");
      const value = input.trim();
      let bytes: Uint8Array;
      try {
        bytes = base58.decode(value);
      } catch {
        throw new SourceValidationError("Invalid Solana address.");
      }
      if (bytes.length !== 32) throw new SourceValidationError("Invalid Solana address.");
      return { source: { kind, value, options: {} }, displayHint: maskValue(value) };
    },

    async getBalance(ctx, src) {
      const res = await rpc<{ value: number }>(ctx, "getBalance", [
        src.value,
        { commitment: "confirmed" },
      ]);
      return [{ asset: SOL, amount: BigInt(res.value) }];
    },

    async getTokens(ctx, src) {
      const totals = new Map<string, bigint>();
      const decimals = new Map<string, number>();
      for (const programId of TOKEN_PROGRAMS) {
        const res = await rpc<{ value: ParsedTokenAccount[] }>(ctx, "getTokenAccountsByOwner", [
          src.value,
          { programId },
          { encoding: "jsonParsed", commitment: "confirmed" },
        ]);
        for (const acc of res.value) {
          const { mint, tokenAmount } = acc.account.data.parsed.info;
          addTo(totals, mint, BigInt(tokenAmount.amount));
          decimals.set(mint, tokenAmount.decimals);
        }
      }
      const nonZero = [...totals].filter(([, amount]) => amount > 0n);
      const meta = await dasMetadata(
        ctx,
        nonZero.map(([mint]) => mint).filter((m) => !WELL_KNOWN_MINTS[m]),
      );
      return nonZero.map(([mint, amount]) => ({
        asset: mintAsset(mint, decimals.get(mint) ?? 0, meta.get(mint)),
        amount,
      }));
    },

    async getTransactions(ctx, src, opts) {
      const sigs: SignatureInfo[] = [];
      let before: string | undefined;
      for (let page = 0; page < opts.maxPages; page++) {
        const batch = await rpc<SignatureInfo[]>(ctx, "getSignaturesForAddress", [
          src.value,
          { limit: SIGNATURE_PAGE, commitment: "confirmed", ...(before ? { before } : {}) },
        ]);
        const fresh = batch.filter((s) => !opts.knownTxids.has(s.signature));
        sigs.push(...fresh);
        if (batch.length < SIGNATURE_PAGE || fresh.length < batch.length) break;
        before = batch.at(-1)!.signature;
      }

      const txs: NormalizedTx[] = [];
      for (const sig of sigs) {
        const tx = await rpc<SolTx | null>(ctx, "getTransaction", [
          sig.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
        ]);
        txs.push(normalize(sig, tx, src.value));
      }
      return txs.sort(newestFirst);
    },

    explorerUrl(kind, id) {
      return `${cfg.explorerUrl.replace(/\/$/, "")}/${kind === "tx" ? "tx" : "account"}/${id}`;
    },
  };
}
