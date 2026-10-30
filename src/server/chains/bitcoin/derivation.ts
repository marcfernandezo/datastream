import { HDKey } from "@scure/bip32";
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { Address, NETWORK, p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer";
import { SourceValidationError } from "../types";

/**
 * Watch-only BIP32 derivation from an *account-level* extended public key
 * (m/purpose'/0'/account'). Addresses are m/…/chain/index, chain 0 = receive,
 * chain 1 = change. Mainnet only.
 */

export type ScriptType = "p2pkh" | "p2sh-p2wpkh" | "p2wpkh" | "p2tr";

const b58c = createBase58check(sha256);

/** SLIP-132 public version bytes. Private versions are deliberately absent. */
const PUBLIC_VERSIONS: Record<string, { version: number; scriptType: ScriptType | null }> = {
  xpub: { version: 0x0488b21e, scriptType: null }, // ambiguous: legacy, or any type exported as xpub
  ypub: { version: 0x049d7cb2, scriptType: "p2sh-p2wpkh" },
  zpub: { version: 0x04b24746, scriptType: "p2wpkh" },
};

const XPUB_VERSION = 0x0488b21e;
const XPRV_VERSION = 0x0488ade4;

export interface ParsedXpub {
  /** Normalized to the `xpub` version bytes. */
  xpub: string;
  /** Prefix the user supplied. */
  prefix: "xpub" | "ypub" | "zpub";
  /** Script type implied by the prefix, or null when the user must choose. */
  impliedScriptType: ScriptType | null;
  depth: number;
}

export function parseExtendedPublicKey(input: string): ParsedXpub {
  const s = input.trim();
  const prefix = s.slice(0, 4);
  const meta = PUBLIC_VERSIONS[prefix];
  if (!meta) throw new SourceValidationError("Expected an xpub, ypub or zpub.");

  let payload: Uint8Array;
  try {
    payload = b58c.decode(s);
  } catch {
    throw new SourceValidationError("Invalid extended public key (checksum mismatch).");
  }
  if (payload.length !== 78) throw new SourceValidationError("Invalid extended public key length.");
  const version = new DataView(payload.buffer, payload.byteOffset).getUint32(0);
  if (version !== meta.version)
    throw new SourceValidationError("Extended key version does not match its prefix.");
  // Public keys start with 0x02/0x03 at byte 45; private keys with 0x00.
  if (payload[45] !== 0x02 && payload[45] !== 0x03) {
    throw new SourceValidationError("Not a public key.");
  }

  const normalized = new Uint8Array(payload);
  new DataView(normalized.buffer).setUint32(0, XPUB_VERSION);
  const xpub = b58c.encode(normalized);
  // Constructing the HDKey validates the curve point.
  const key = HDKey.fromExtendedKey(xpub, { public: XPUB_VERSION, private: XPRV_VERSION });
  if (key.privateKey) throw new SourceValidationError("Not a public key.");

  return {
    xpub,
    prefix: prefix as ParsedXpub["prefix"],
    impliedScriptType: meta.scriptType,
    depth: key.depth,
  };
}

/** Re-encodes a normalized xpub with the SLIP-132 prefix the user supplied (for display). */
export function withPrefix(xpub: string, prefix: string): string {
  const meta = PUBLIC_VERSIONS[prefix];
  if (!meta) return xpub;
  const payload = new Uint8Array(b58c.decode(xpub));
  new DataView(payload.buffer).setUint32(0, meta.version);
  return b58c.encode(payload);
}

export function addressForPubkey(pubkey: Uint8Array, scriptType: ScriptType): string {
  switch (scriptType) {
    case "p2pkh":
      return p2pkh(pubkey, NETWORK).address!;
    case "p2wpkh":
      return p2wpkh(pubkey, NETWORK).address!;
    case "p2sh-p2wpkh":
      return p2sh(p2wpkh(pubkey, NETWORK), NETWORK).address!;
    case "p2tr":
      // BIP86: key-path only, x-only internal key.
      return p2tr(pubkey.slice(1), undefined, NETWORK).address!;
  }
}

export class AddressDeriver {
  private readonly chains: [HDKey, HDKey];
  private readonly cache = new Map<string, string>();

  constructor(
    xpub: string,
    readonly scriptType: ScriptType,
  ) {
    const account = HDKey.fromExtendedKey(xpub, { public: XPUB_VERSION, private: XPRV_VERSION });
    this.chains = [account.deriveChild(0), account.deriveChild(1)];
  }

  address(chain: 0 | 1, index: number): string {
    const key = `${chain}/${index}`;
    let addr = this.cache.get(key);
    if (!addr) {
      const pub = this.chains[chain].deriveChild(index).publicKey;
      if (!pub) throw new Error("derivation failed");
      addr = addressForPubkey(pub, this.scriptType);
      this.cache.set(key, addr);
    }
    return addr;
  }
}

/** Validates a mainnet address and returns its canonical form (bech32 lowercased). */
export function parseBitcoinAddress(input: string): string {
  const s = input.trim();
  const candidate = /^(bc1)/i.test(s) ? s.toLowerCase() : s;
  try {
    Address(NETWORK).decode(candidate);
  } catch {
    throw new SourceValidationError("Invalid Bitcoin mainnet address.");
  }
  return candidate;
}
