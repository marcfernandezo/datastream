/** Input to the wallet dedup HMAC. The source is already canonicalized by its adapter. */
export function walletFingerprintInput(network: string, canonicalSource: string) {
  return `${network}:${canonicalSource}`;
}
