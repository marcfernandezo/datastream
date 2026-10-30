import "server-only";
import { env } from "@/env";
import { decrypt, encrypt, fingerprint, parseKey, type Keyring } from "./envelope";

let ring: Keyring | undefined;

export function keyring(): Keyring {
  if (!ring) {
    const e = env();
    ring = {
      current: parseKey(e.WATCHTOWER_ENC_KEY),
      previous: e.WATCHTOWER_ENC_KEY_PREVIOUS ? parseKey(e.WATCHTOWER_ENC_KEY_PREVIOUS) : undefined,
    };
  }
  return ring;
}

export const AAD = {
  walletSource: "wallet-source",
  alertChannel: "alert-channel",
} as const;

export const seal = (plaintext: string, aad: string) => encrypt(keyring(), plaintext, aad);
export const open = (envelope: string, aad: string) => decrypt(keyring(), envelope, aad);
export const fp = (value: string) => fingerprint(keyring(), value);
