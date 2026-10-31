import "server-only";
import { env } from "@/env";
import { getAdapters } from "@/server/chains/registry";
import type { NetworkOption } from "./add-wallet-dialog";

const COPY: Record<string, { placeholder: string; hint: string }> = {
  btc: {
    placeholder: "bc1q… / 1… / 3… or xpub… / ypub… / zpub…",
    hint: "An address, or an account extended public key to track every derived address.",
  },
  eth: { placeholder: "0x…", hint: "ETH and ERC-20 tokens on Ethereum mainnet." },
  sol: { placeholder: "Base58 address", hint: "SOL and SPL tokens." },
  zec: {
    placeholder: "t1… / t3… / tex1… or uview1…",
    hint: "A transparent address, or a unified full viewing key (uview1…) for the shielded balance and history.",
  },
};

const ZEC_TRANSPARENT_ONLY = {
  placeholder: "t1… / t3… / tex1…",
  hint: "Transparent address. Shielded viewing keys need the zcash-viewer sidecar (see README).",
};

export function networkOptions(): NetworkOption[] {
  const shielded = !!env().ZCASH_VIEWER_URL;
  return [...getAdapters().values()].map((a) => {
    const copy = a.network === "zec" && !shielded ? ZEC_TRANSPARENT_ONLY : COPY[a.network];
    return {
      id: a.network,
      label: a.label,
      placeholder: copy?.placeholder ?? "",
      hint: copy?.hint ?? "",
      scriptTypes: a.sourceOptions?.xpub?.find((o) => o.key === "scriptType")?.choices ?? [],
    };
  });
}
