import type { NormalizedTx } from "./types";

const PENDING = Number.MAX_SAFE_INTEGER;

/** Newest first; pending (no block time) sorts on top. */
export function newestFirst(a: NormalizedTx, b: NormalizedTx) {
  return (b.blockTime ?? PENDING) - (a.blockTime ?? PENDING);
}

/** Adds `amount` to the running per-key total. */
export function addTo<K>(map: Map<K, bigint>, key: K, amount: bigint) {
  map.set(key, (map.get(key) ?? 0n) + amount);
}
