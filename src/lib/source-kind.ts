/** Client-safe: infers the source kind from what the user pasted. */
export function detectSourceKind(network: string, input: string): "address" | "xpub" | "ufvk" {
  const s = input.trim();
  if (network === "btc" && /^[xyz]pub/.test(s)) return "xpub";
  if (network === "zec" && /^uview1/.test(s)) return "ufvk";
  return "address";
}

/** True for a plain `xpub`, where the address type can't be inferred from the prefix. */
export function isAmbiguousXpub(network: string, input: string) {
  return network === "btc" && input.trim().startsWith("xpub");
}
