/**
 * Masking of anything that could identify a wallet: addresses, extended public
 * keys, viewing keys and tx hashes. Applied to every log line (see logger.ts)
 * and to alert messages. Keep this file dependency-free: it's also used in tests.
 */

const B58 = "1-9A-HJ-NP-Za-km-z";
const PATTERNS: RegExp[] = [
  // Extended keys first (longest), so they aren't partially matched as addresses.
  new RegExp(`\\b[xyztuvYZUV](?:pub|prv)[${B58}]{100,}`, "g"),
  /\buview(?:test)?1[02-9ac-hj-np-z]{100,}/gi, // Zcash UFVK
  /\b(?:bc|tb|bcrt)1[02-9ac-hj-np-z]{8,87}\b/gi, // bech32/bech32m BTC
  /\b(?:zs|ztestsapling|u|utest|tex)1[02-9ac-hj-np-z]{20,}\b/gi, // Zcash shielded / unified / TEX
  /\b0x[0-9a-fA-F]{64}\b/g, // EVM tx hashes
  /\b0x[0-9a-fA-F]{40}\b/g, // EVM addresses
  /\b[0-9a-fA-F]{64}\b/g, // BTC/ZEC txids, raw 32-byte hex
  new RegExp(`\\bt[13m][${B58}]{33}\\b`, "g"), // Zcash transparent
  new RegExp(`\\b[123mn][${B58}]{25,34}\\b`, "g"), // BTC base58
  new RegExp(`\\b[${B58}]{32,88}\\b`, "g"), // Solana pubkeys / signatures
];

export function maskValue(value: string): string {
  if (value.length <= 10) return "…";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function maskSensitive(input: string): string {
  let out = input;
  for (const re of PATTERNS) out = out.replace(re, (m) => maskValue(m));
  return out;
}

/** Deep-masks strings inside arbitrary log payloads. Depth-limited, cycle-safe. */
export function maskDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return maskSensitive(value);
  if (value === null || typeof value !== "object" || depth > 6) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) {
    return {
      type: value.name,
      message: maskSensitive(value.message),
      stack: value.stack ? maskSensitive(value.stack) : undefined,
      cause: value.cause === undefined ? undefined : maskDeep(value.cause, depth + 1, seen),
    };
  }
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, depth + 1, seen);
  return out;
}
