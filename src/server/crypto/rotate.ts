import { eq } from "drizzle-orm";
import { db, schema } from "@/server/db/client";
import { keyId } from "./envelope";
import { AAD, fp, keyring, open, seal } from "./keyring";
import { walletFingerprintInput } from "./wallet-fingerprint";

/**
 * Re-encrypts every envelope not sealed with the current key and recomputes
 * wallet fingerprints (they are keyed too). Run inside a transaction.
 */
export function rotateKeys() {
  const currentKid = keyId(keyring().current);
  let wallets = 0;
  let channels = 0;

  for (const w of db().select().from(schema.wallets).all()) {
    const plain = open(w.sourceEnc, AAD.walletSource);
    const sourceEnc =
      w.sourceEnc.split(".")[1] === currentKid ? w.sourceEnc : seal(plain, AAD.walletSource);
    const fingerprint = fp(walletFingerprintInput(w.network, plain));
    if (sourceEnc !== w.sourceEnc || fingerprint !== w.fingerprint) {
      db()
        .update(schema.wallets)
        .set({ sourceEnc, fingerprint })
        .where(eq(schema.wallets.id, w.id))
        .run();
      wallets++;
    }
  }

  for (const c of db().select().from(schema.alertChannels).all()) {
    if (c.configEnc.split(".")[1] === currentKid) continue;
    const configEnc = seal(open(c.configEnc, AAD.alertChannel), AAD.alertChannel);
    db()
      .update(schema.alertChannels)
      .set({ configEnc })
      .where(eq(schema.alertChannels.id, c.id))
      .run();
    channels++;
  }

  return { wallets, channels };
}
