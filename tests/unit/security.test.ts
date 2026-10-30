import { describe, expect, it } from "vitest";
import { decrypt, encrypt, fingerprint, keyId, type Keyring } from "@/server/crypto/envelope";
import {
  assertNotPrivateMaterial,
  detectPrivateMaterial,
  PrivateKeyMaterialError,
} from "@/server/crypto/secret-guard";
import { clientIp, ipAllowed } from "@/server/auth/ip";
import { createLimiter } from "@/server/auth/rate-limit";
import { maskDeep, maskSensitive } from "@/server/log/mask";

const k1 = Buffer.alloc(32, 1);
const k2 = Buffer.alloc(32, 2);

const ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

describe("envelope encryption", () => {
  const ring: Keyring = { current: k1 };

  it("round-trips and never contains the plaintext", () => {
    const env = encrypt(ring, ZPUB, "wallet-source");
    expect(env).toMatch(/^v1\.[0-9a-f]{8}\./);
    expect(env).not.toContain(ZPUB.slice(4, 20));
    expect(decrypt(ring, env, "wallet-source")).toBe(ZPUB);
  });

  it("uses a fresh IV every time", () => {
    expect(encrypt(ring, "x", "a")).not.toBe(encrypt(ring, "x", "a"));
  });

  it("rejects tampering and wrong AAD", () => {
    const env = encrypt(ring, "secret", "wallet-source");
    const parts = env.split(".");
    const ct = Buffer.from(parts[3]!, "base64url");
    ct[0]! ^= 1;
    const tampered = [...parts.slice(0, 3), ct.toString("base64url")].join(".");
    expect(() => decrypt(ring, tampered, "wallet-source")).toThrow();
    expect(() => decrypt(ring, env, "alert-channel")).toThrow();
  });

  it("decrypts with the previous key during rotation", () => {
    const old = encrypt({ current: k1 }, "v", "a");
    expect(decrypt({ current: k2, previous: k1 }, old, "a")).toBe("v");
    expect(() => decrypt({ current: k2 }, old, "a")).toThrow(/No key available/);
    expect(keyId(k1)).not.toBe(keyId(k2));
  });

  it("fingerprints deterministically per key", () => {
    expect(fingerprint({ current: k1 }, "a")).toBe(fingerprint({ current: k1 }, "a"));
    expect(fingerprint({ current: k1 }, "a")).not.toBe(fingerprint({ current: k2 }, "a"));
  });
});

describe("private key material guard", () => {
  const bad = [
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote",
    "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi",
    "zprvAWgYBBk7JR8Gjrh4UJQ2uJdG1r3WNRRfURiABBE3RvMXYSrRJL62XuezvGdPvG6GFBZduosCc1YP5wixPox7zhZLfiUm8aunE96BBa4Kei5",
    "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ",
    "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn",
    "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
    "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
    `[${Array.from({ length: 64 }, (_, i) => i).join(",")}]`,
    "secret-extended-key-main1qwerty",
  ];
  it.each(bad)("rejects %s", (s) => {
    expect(detectPrivateMaterial(s)).not.toBeNull();
    expect(() => assertNotPrivateMaterial(s)).toThrow(PrivateKeyMaterialError);
  });

  const good = [
    "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
    "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    ZPUB,
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV",
    "t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU",
  ];
  it.each(good)("accepts %s", (s) => expect(detectPrivateMaterial(s)).toBeNull());
});

describe("log masking", () => {
  it("masks addresses, xpubs and tx hashes", () => {
    const line = `sync bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu ${ZPUB} 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 tx 4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b`;
    const out = maskSensitive(line);
    expect(out).not.toContain("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(out).not.toContain(ZPUB);
    expect(out).not.toContain("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    expect(out).not.toContain("4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b");
    expect(out).toContain("bc1q…6fyu");
  });

  it("masks Solana and base58 addresses", () => {
    expect(maskSensitive("addr 7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV")).toBe(
      "addr 7EcD…FLtV",
    );
    expect(maskSensitive("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe("1A1z…vfNa");
  });

  it("leaves ordinary text and numbers alone", () => {
    expect(maskSensitive("synced 42 txs in 1200ms for wallet Cold Storage")).toBe(
      "synced 42 txs in 1200ms for wallet Cold Storage",
    );
  });

  it("deep-masks objects and errors", () => {
    const out = maskDeep({
      nested: { a: ["bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"] },
      err: new Error(`bad ${ZPUB}`),
    });
    expect(JSON.stringify(out)).not.toContain("cr8te4kr609gcawutmrza0j4xv80jy8z3");
    expect(JSON.stringify(out)).not.toContain(ZPUB);
  });
});

describe("client IP and CIDR allowlist", () => {
  const h = (xff?: string) => new Headers(xff ? { "x-forwarded-for": xff } : {});

  it("ignores X-Forwarded-For unless the proxy is trusted", () => {
    expect(clientIp(h("10.0.0.5"), false)).toBeNull();
  });

  it("uses the rightmost (proxy-observed) hop", () => {
    expect(clientIp(h("192.168.1.10, 203.0.113.7"), true)).toBe("203.0.113.7");
  });

  it("matches IPv4, IPv6 and IPv4-mapped IPv6", () => {
    const cidrs = ["192.168.0.0/16", "100.64.0.0/10", "fd7a:115c:a1e0::/48"];
    expect(ipAllowed("192.168.1.10", cidrs)).toBe(true);
    expect(ipAllowed("100.101.102.103", cidrs)).toBe(true);
    expect(ipAllowed("::ffff:192.168.4.4", cidrs)).toBe(true);
    expect(ipAllowed("fd7a:115c:a1e0::1", cidrs)).toBe(true);
    expect(ipAllowed("203.0.113.7", cidrs)).toBe(false);
    expect(ipAllowed(null, cidrs)).toBe(false);
    expect(ipAllowed(null, [])).toBe(true);
  });
});

describe("rate limiter", () => {
  it("allows the burst, then limits, then refills", () => {
    const l = createLimiter(`t-${Math.random()}`, { capacity: 3, windowMs: 3000 });
    const t = 1_000_000;
    expect([l.take("ip", t), l.take("ip", t), l.take("ip", t)]).toEqual([0, 0, 0]);
    expect(l.take("ip", t)).toBeGreaterThan(0);
    expect(l.take("other", t)).toBe(0);
    expect(l.take("ip", t + 1000)).toBe(0);
  });
});
