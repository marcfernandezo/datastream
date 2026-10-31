import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { SourceValidationError } from "../types";

/** EIP-55 checksum encoding. */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, "");
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const c = lower[i]!;
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/** Validates an EVM address; mixed-case input must carry a valid EIP-55 checksum. */
export function parseEvmAddress(input: string): string {
  const s = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new SourceValidationError("Invalid Ethereum address.");
  const body = s.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  const checksummed = toChecksumAddress(s);
  if (mixed && checksummed !== s) {
    throw new SourceValidationError("Address checksum mismatch. Check for a typo.");
  }
  return checksummed;
}
