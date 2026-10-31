import { HDKey } from "@scure/bip32";
import { maskValue } from "@/server/log/mask";
import {
  SourceValidationError,
  type AssetInfo,
  type ChainAdapter,
  type NormalizedTx,
  type SyncContext,
  type TxFetchOptions,
  type WalletSource,
} from "../types";
import { newestFirst } from "../util";
import {
  AddressDeriver,
  addressForPubkey,
  parseBitcoinAddress,
  parseExtendedPublicKey,
  type ScriptType,
  withPrefix,
} from "./derivation";
import {
  balanceOf,
  EsploraClient,
  ESPLORA_PAGE_SIZE,
  txCount,
  type EsploraAddress,
  type EsploraTx,
} from "./esplora";

export const BTC: AssetInfo = {
  id: "btc",
  network: "btc",
  contract: null,
  symbol: "BTC",
  name: "Bitcoin",
  decimals: 8,
  coingeckoId: "bitcoin",
};

const SCRIPT_TYPES: ScriptType[] = ["p2wpkh", "p2tr", "p2sh-p2wpkh", "p2pkh"];
const SCAN_BATCH = 5;

export interface BitcoinConfig {
  esploraUrl: string;
  explorerUrl: string;
  gapLimit: number;
  /** Requests per second to the Esplora host. */
  rps?: number;
}

interface ScanResult {
  /** Addresses with any history, keyed `chain/index` (or `addr` for single addresses). */
  used: Map<string, { address: string; stats: EsploraAddress }>;
  ours: Set<string>;
}

interface BtcState {
  scriptType?: ScriptType;
  /** tx_count per derivation path, to skip unchanged addresses on incremental syncs. */
  txCounts?: Record<string, number>;
}

export function createBitcoinAdapter(cfg: BitcoinConfig): ChainAdapter {
  const client = (ctx: SyncContext) =>
    new EsploraClient(ctx.http, cfg.esploraUrl, ctx.signal, cfg.rps);

  async function resolveScriptType(
    ctx: SyncContext,
    src: WalletSource,
  ): Promise<ScriptType | null> {
    const chosen = src.options.scriptType as ScriptType | "auto" | undefined;
    if (chosen && chosen !== "auto") return chosen;
    const state = ctx.state as BtcState;
    if (state.scriptType) return state.scriptType;

    // Probe receive/0 of every script type; pick the one with history.
    const esplora = client(ctx);
    const account = HDKey.fromExtendedKey(src.value);
    const pub = account.deriveChild(0).deriveChild(0).publicKey!;
    for (const type of SCRIPT_TYPES) {
      if (txCount(await esplora.address(addressForPubkey(pub, type))) > 0) {
        state.scriptType = type;
        ctx.log.info({ scriptType: type }, "detected xpub script type");
        return type;
      }
    }
    return null;
  }

  async function scan(ctx: SyncContext, src: WalletSource): Promise<ScanResult> {
    const cached = ctx.memo.get("btc:scan") as ScanResult | undefined;
    if (cached) return cached;

    const esplora = client(ctx);
    const used: ScanResult["used"] = new Map();
    const ours = new Set<string>();

    if (src.kind === "address") {
      ours.add(src.value);
      const stats = await esplora.address(src.value);
      if (txCount(stats) > 0) used.set("addr", { address: src.value, stats });
    } else {
      const scriptType = await resolveScriptType(ctx, src);
      if (scriptType) {
        const deriver = new AddressDeriver(src.value, scriptType);
        for (const chain of [0, 1] as const) {
          let index = 0;
          let gap = 0;
          while (gap < cfg.gapLimit) {
            const batch = Array.from({ length: SCAN_BATCH }, (_, i) => index + i);
            const results = await Promise.all(
              batch.map(async (i) => {
                const address = deriver.address(chain, i);
                return { i, address, stats: await esplora.address(address) };
              }),
            );
            for (const { i, address, stats } of results) {
              ours.add(address);
              if (txCount(stats) > 0) {
                used.set(`${chain}/${i}`, { address, stats });
                gap = 0;
              } else {
                gap++;
              }
            }
            index += SCAN_BATCH;
          }
        }
      }
    }
    const result = { used, ours };
    ctx.memo.set("btc:scan", result);
    return result;
  }

  function normalize(tx: EsploraTx, ours: Set<string>): NormalizedTx {
    let received = 0n;
    let sent = 0n;
    for (const out of tx.vout)
      if (out.scriptpubkey_address && ours.has(out.scriptpubkey_address))
        received += BigInt(out.value);
    for (const input of tx.vin) {
      const addr = input.prevout?.scriptpubkey_address;
      if (addr && ours.has(addr)) sent += BigInt(input.prevout!.value);
    }
    const weSpent = sent > 0n;
    const fee = weSpent ? BigInt(tx.fee) : null;
    // Net change excluding the fee we paid.
    const amount = received - sent + (fee ?? 0n);
    return {
      txid: tx.txid,
      blockTime: tx.status.block_time ?? null,
      blockHeight: tx.status.block_height ?? null,
      status: tx.status.confirmed ? "confirmed" : "pending",
      fee,
      movements: amount === 0n ? [] : [{ asset: BTC, amount }],
    };
  }

  return {
    network: "btc",
    label: "Bitcoin",
    nativeAsset: BTC,
    supportedSources: ["address", "xpub"],
    sourceOptions: {
      xpub: [
        {
          key: "scriptType",
          label: "Address type",
          appliesTo: "xpub-ambiguous",
          choices: [
            { value: "auto", label: "Auto-detect" },
            { value: "p2wpkh", label: "Native SegWit (bc1q…, BIP84)" },
            { value: "p2tr", label: "Taproot (bc1p…, BIP86)" },
            { value: "p2sh-p2wpkh", label: "Nested SegWit (3…, BIP49)" },
            { value: "p2pkh", label: "Legacy (1…, BIP44)" },
          ],
        },
      ],
    },

    parseSource(kind, input, options) {
      if (kind === "address") {
        const value = parseBitcoinAddress(input);
        return { source: { kind, value, options: {} }, displayHint: maskValue(value) };
      }
      if (kind === "xpub") {
        const parsed = parseExtendedPublicKey(input);
        if (parsed.depth !== 3) {
          throw new SourceValidationError(
            "Use the account-level extended public key (depth 3, e.g. m/84'/0'/0'), as exported by Ledger Live, Sparrow or Electrum.",
          );
        }
        const requested = String(options.scriptType ?? "auto");
        const scriptType = parsed.impliedScriptType ?? requested;
        if (scriptType !== "auto" && !SCRIPT_TYPES.includes(scriptType as ScriptType)) {
          throw new SourceValidationError("Unknown address type.");
        }
        return {
          source: { kind, value: parsed.xpub, options: { scriptType, prefix: parsed.prefix } },
          displayHint: `${parsed.prefix}…${input.trim().slice(-4)}`,
        };
      }
      throw new SourceValidationError("Bitcoin supports addresses and xpub/ypub/zpub.");
    },

    async getBalance(ctx, src) {
      const { used } = await scan(ctx, src);
      let total = 0n;
      for (const { stats } of used.values()) total += balanceOf(stats);
      return [{ asset: BTC, amount: total }];
    },

    async getTokens() {
      return [];
    },

    async getTransactions(ctx, src, opts: TxFetchOptions) {
      const { used, ours } = await scan(ctx, src);
      const esplora = client(ctx);
      const state = ctx.state as BtcState;
      const prevCounts = state.txCounts ?? {};
      const nextCounts: Record<string, number> = {};
      const seen = new Map<string, EsploraTx>();

      for (const [path, { address, stats }] of used) {
        const count = txCount(stats);
        nextCounts[path] = count;
        // Unchanged since last sync and nothing pending: nothing new to fetch.
        if (
          prevCounts[path] === count &&
          stats.mempool_stats.tx_count === 0 &&
          opts.knownTxids.size > 0
        )
          continue;

        let page = await esplora.txs(address);
        let pages = 1;
        for (;;) {
          for (const tx of page) seen.set(tx.txid, tx);
          const confirmed = page.filter((t) => t.status.confirmed);
          const reachedKnown = confirmed.some((t) => opts.knownTxids.has(t.txid));
          if (reachedKnown || confirmed.length < ESPLORA_PAGE_SIZE || pages >= opts.maxPages) break;
          page = await esplora.txsAfter(address, confirmed.at(-1)!.txid);
          pages++;
        }
      }
      state.txCounts = nextCounts;

      return [...seen.values()].map((tx) => normalize(tx, ours)).sort(newestFirst);
    },

    displaySource(src) {
      const prefix = src.options.prefix;
      return src.kind === "xpub" && typeof prefix === "string"
        ? withPrefix(src.value, prefix)
        : src.value;
    },

    explorerUrl(kind, id) {
      return `${cfg.explorerUrl.replace(/\/$/, "")}/${kind === "tx" ? "tx" : "address"}/${id}`;
    },
  };
}
