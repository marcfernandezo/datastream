import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { describe, expect, it } from "vitest";
import {
  AddressDeriver,
  parseBitcoinAddress,
  parseExtendedPublicKey,
} from "@/server/chains/bitcoin/derivation";

/*
 * Published test vectors for the "abandon … about" mnemonic, taken from
 * BIP-44 (via common wallet test suites), BIP-49, BIP-84 and BIP-86.
 * The mnemonic is only used here to independently cross-check the account
 * xpubs. Application code never handles seeds.
 */
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const VECTORS = {
  bip84: {
    path: "m/84'/0'/0'",
    zpub: "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs",
    receive: [
      "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
      "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g",
    ],
    change: ["bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el"],
  },
  bip49: {
    path: "m/49'/0'/0'",
    ypub: "ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP",
    receive: ["37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf"],
  },
  bip44: {
    path: "m/44'/0'/0'",
    xpub: "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj",
    receive: ["1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"],
  },
  bip86: {
    path: "m/86'/0'/0'",
    xpub: "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ",
    receive: ["bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"],
  },
};

describe("BTC extended public key parsing", () => {
  it("cross-checks the vector xpubs against the mnemonic", () => {
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
    const xpubOf = (path: string) => root.derive(path).publicExtendedKey;
    expect(parseExtendedPublicKey(VECTORS.bip84.zpub).xpub).toBe(xpubOf(VECTORS.bip84.path));
    expect(parseExtendedPublicKey(VECTORS.bip49.ypub).xpub).toBe(xpubOf(VECTORS.bip49.path));
    expect(VECTORS.bip44.xpub).toBe(xpubOf(VECTORS.bip44.path));
    expect(VECTORS.bip86.xpub).toBe(xpubOf(VECTORS.bip86.path));
  });

  it("infers script types from SLIP-132 prefixes", () => {
    expect(parseExtendedPublicKey(VECTORS.bip84.zpub)).toMatchObject({
      prefix: "zpub",
      impliedScriptType: "p2wpkh",
      depth: 3,
    });
    expect(parseExtendedPublicKey(VECTORS.bip49.ypub).impliedScriptType).toBe("p2sh-p2wpkh");
    expect(parseExtendedPublicKey(VECTORS.bip44.xpub).impliedScriptType).toBeNull();
  });

  it("rejects private keys, bad checksums and garbage", () => {
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
    expect(() => parseExtendedPublicKey(root.derive("m/84'/0'/0'").privateExtendedKey)).toThrow();
    const corrupted =
      VECTORS.bip84.zpub.slice(0, -1) + (VECTORS.bip84.zpub.endsWith("s") ? "t" : "s");
    expect(() => parseExtendedPublicKey(corrupted)).toThrow(/checksum/);
    expect(() => parseExtendedPublicKey("hello")).toThrow();
  });
});

describe("BTC address derivation (BIP test vectors)", () => {
  it("BIP84 native segwit receive and change", () => {
    const d = new AddressDeriver(parseExtendedPublicKey(VECTORS.bip84.zpub).xpub, "p2wpkh");
    expect(d.address(0, 0)).toBe(VECTORS.bip84.receive[0]);
    expect(d.address(0, 1)).toBe(VECTORS.bip84.receive[1]);
    expect(d.address(1, 0)).toBe(VECTORS.bip84.change[0]);
  });

  it("BIP49 nested segwit", () => {
    const d = new AddressDeriver(parseExtendedPublicKey(VECTORS.bip49.ypub).xpub, "p2sh-p2wpkh");
    expect(d.address(0, 0)).toBe(VECTORS.bip49.receive[0]);
  });

  it("BIP44 legacy", () => {
    const d = new AddressDeriver(VECTORS.bip44.xpub, "p2pkh");
    expect(d.address(0, 0)).toBe(VECTORS.bip44.receive[0]);
  });

  it("BIP86 taproot", () => {
    const d = new AddressDeriver(VECTORS.bip86.xpub, "p2tr");
    expect(d.address(0, 0)).toBe(VECTORS.bip86.receive[0]);
  });
});

describe("BTC address validation", () => {
  it.each([
    ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"],
    ["37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf", "37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf"],
    ["BC1QCR8TE4KR609GCAWUTMRZA0J4XV80JY8Z306FYU", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"],
    [VECTORS.bip86.receive[0]!, VECTORS.bip86.receive[0]!],
  ])("accepts %s", (input, canonical) => expect(parseBitcoinAddress(input)).toBe(canonical));

  it.each([
    "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb",
    "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  ])("rejects %s", (input) => expect(() => parseBitcoinAddress(input)).toThrow());
});

describe("SLIP-132 display", () => {
  it("round-trips the user's prefix", async () => {
    const { withPrefix } = await import("@/server/chains/bitcoin/derivation");
    const parsed = parseExtendedPublicKey(VECTORS.bip84.zpub);
    expect(withPrefix(parsed.xpub, "zpub")).toBe(VECTORS.bip84.zpub);
    expect(withPrefix(parseExtendedPublicKey(VECTORS.bip49.ypub).xpub, "ypub")).toBe(
      VECTORS.bip49.ypub,
    );
  });
});
