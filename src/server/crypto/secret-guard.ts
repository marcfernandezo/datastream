/**
 * Watchtower is watch-only. This guard rejects anything that looks like
 * private key material *before* it reaches validation, storage or logs.
 * False positives are acceptable; false negatives are not.
 */

const B58 = "[1-9A-HJ-NP-Za-km-z]";

const RULES: { name: string; test: (s: string) => boolean }[] = [
  {
    name: "extended private key",
    test: (s) => /[xyztuvYZUV]prv[1-9A-HJ-NP-Za-km-z]{20,}/.test(s),
  },
  {
    name: "mnemonic seed phrase",
    // 12–24 alphabetic words; real seeds are lowercase but be generous.
    test: (s) => {
      const words = s.trim().split(/[\s,]+/);
      return (
        words.length >= 12 && words.length <= 25 && words.every((w) => /^[a-zA-Z]{3,8}$/.test(w))
      );
    },
  },
  { name: "WIF private key", test: (s) => new RegExp(`^[5KLc9]${B58}{50,51}$`).test(s) },
  { name: "raw 32-byte private key", test: (s) => /^(0x)?[0-9a-fA-F]{64}$/.test(s) },
  {
    name: "Solana secret key",
    test: (s) =>
      new RegExp(`^${B58}{86,90}$`).test(s) || /^\[\s*\d{1,3}(\s*,\s*\d{1,3}){63}\s*\]$/.test(s),
  },
  {
    name: "Zcash spending key",
    test: (s) => /^(secret-extended-key|secret-spending-key|usk|uskt|zxsk)/i.test(s),
  },
];

export class PrivateKeyMaterialError extends Error {
  constructor(public readonly kind: string) {
    super(
      `This looks like a ${kind}. Watchtower is watch-only and never accepts private keys or seed phrases. Use a public address, xpub/ypub/zpub or viewing key instead.`,
    );
    this.name = "PrivateKeyMaterialError";
  }
}

export function detectPrivateMaterial(input: string): string | null {
  const s = input.trim();
  for (const rule of RULES) if (rule.test(s)) return rule.name;
  return null;
}

export function assertNotPrivateMaterial(input: string): void {
  const kind = detectPrivateMaterial(input);
  if (kind) throw new PrivateKeyMaterialError(kind);
}
