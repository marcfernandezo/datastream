import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM envelopes for sensitive-at-rest values (xpubs, viewing keys,
 * alert channel secrets).
 *
 * Format: `v1.<kid>.<iv>.<ciphertext+tag>` (base64url segments).
 * - kid identifies the master key, so values can be decrypted during rotation.
 * - The AAD binds a ciphertext to its purpose (e.g. "wallet-source"), so a
 *   ciphertext copied into another column fails to decrypt.
 * - Subkeys are HKDF-derived from the master key; the master key itself is
 *   never used directly.
 */

const VERSION = "v1";

export interface Keyring {
  current: Buffer;
  previous?: Buffer | undefined;
}

export function keyId(master: Buffer): string {
  return createHash("sha256").update("datastream-kid").update(master).digest("hex").slice(0, 8);
}

function subkey(master: Buffer, purpose: "enc" | "fingerprint"): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `datastream:${purpose}`, 32));
}

export function parseKey(b64: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  return key;
}

export function encrypt(keyring: Keyring, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", subkey(keyring.current, "enc"), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return [VERSION, keyId(keyring.current), iv.toString("base64url"), ct.toString("base64url")].join(
    ".",
  );
}

export function decrypt(keyring: Keyring, envelope: string, aad: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Malformed envelope");
  const [, kid, ivB64, ctB64] = parts as [string, string, string, string];
  const master = [keyring.current, keyring.previous].find((k) => k && keyId(k) === kid);
  if (!master) throw new Error(`No key available for kid ${kid}`);
  const iv = Buffer.from(ivB64, "base64url");
  const data = Buffer.from(ctB64, "base64url");
  if (iv.length !== 12 || data.length < 16) throw new Error("Malformed envelope");
  const decipher = createDecipheriv("aes-256-gcm", subkey(master, "enc"), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([
    decipher.update(data.subarray(0, data.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}

export function envelopeKeyId(envelope: string): string | undefined {
  return envelope.split(".")[1];
}

/** Deterministic keyed fingerprint for dedup without decrypting. */
export function fingerprint(keyring: Keyring, value: string): string {
  return createHmac("sha256", subkey(keyring.current, "fingerprint")).update(value).digest("hex");
}
