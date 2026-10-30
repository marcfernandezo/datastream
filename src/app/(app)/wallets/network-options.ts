import "server-only";
import { getAdapters } from "@/server/chains/registry";
import type { NetworkOption } from "./add-wallet-dialog";

const COPY: Record<string, { placeholder: string; hint: string }> = {
  btc: {
    placeholder: "bc1q… / 1… / 3… or xpub… / ypub… / zpub…",
    hint: "An address, or an account extended public key to track every derived address.",
  },
  eth: { placeholder: "0x…", hint: "ETH and ERC-20 tokens on Ethereum mainnet." },
  sol: { placeholder: "Base58 address", hint: "SOL and SPL tokens." },
  zec: { placeholder: "t1… or uview1…", hint: "Transparent address or Unified Full Viewing Key." },
};

export function networkOptions(): NetworkOption[] {
  return [...getAdapters().values()].map((a) => ({
    id: a.network,
    label: a.label,
    placeholder: COPY[a.network]?.placeholder ?? "",
    hint: COPY[a.network]?.hint ?? "",
    scriptTypes: a.sourceOptions?.xpub?.find((o) => o.key === "scriptType")?.choices ?? [],
  }));
}
