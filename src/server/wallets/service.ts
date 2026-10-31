import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getAdapter, getAdapters } from "@/server/chains/registry";
import { SourceValidationError } from "@/server/chains/types";
import { AAD, fp, seal } from "@/server/crypto/keyring";
import { assertNotPrivateMaterial } from "@/server/crypto/secret-guard";
import { walletFingerprintInput } from "@/server/crypto/wallet-fingerprint";
import { db, schema } from "@/server/db/client";
import { enqueue } from "@/server/jobs/queue";
import { logger } from "@/server/log/logger";
import { detectSourceKind } from "@/lib/source-kind";

export class DuplicateWalletError extends Error {
  constructor() {
    super("This wallet is already being watched.");
    this.name = "DuplicateWalletError";
  }
}

export const labelSchema = z
  .string()
  .trim()
  .min(1, "Label is required")
  .max(60, "Max 60 characters");

export const createWalletSchema = z.object({
  network: z.string().refine((n) => getAdapters().has(n as never), "Unsupported network"),
  input: z.string().trim().min(1, "Paste an address or public key").max(1000),
  label: labelSchema,
  options: z.record(z.string(), z.string().max(40)).default({}),
});

export function enqueueSync(walletId: string, delayMs = 0) {
  return enqueue(
    "wallet.sync",
    { walletId },
    { key: `sync:${walletId}`, runAfter: new Date(Date.now() + delayMs) },
  );
}

export function createWallet(raw: unknown): { id: string } {
  // The guard runs before anything else touches the input.
  if (raw && typeof raw === "object" && "input" in raw && typeof raw.input === "string") {
    assertNotPrivateMaterial(raw.input);
  }
  const data = createWalletSchema.parse(raw);
  const adapter = getAdapter(data.network);
  const kind = detectSourceKind(data.network, data.input);
  if (!adapter.supportedSources.includes(kind)) {
    throw new SourceValidationError(`${adapter.label} does not support ${kind} sources.`);
  }
  const { source, displayHint } = adapter.parseSource(kind, data.input, data.options);

  const fingerprint = fp(walletFingerprintInput(data.network, source.value));
  const dup = db()
    .select({ id: schema.wallets.id })
    .from(schema.wallets)
    .where(eq(schema.wallets.fingerprint, fingerprint))
    .get();
  if (dup) throw new DuplicateWalletError();

  const id = randomUUID();
  db()
    .insert(schema.wallets)
    .values({
      id,
      label: data.label,
      network: data.network,
      sourceKind: source.kind,
      sourceEnc: seal(source.value, AAD.walletSource),
      fingerprint,
      displayHint,
      options: source.options,
    })
    .run();
  enqueueSync(id);
  logger.info({ walletId: id, network: data.network, kind }, "wallet added");
  return { id };
}

export function renameWallet(id: string, label: string) {
  const parsed = labelSchema.parse(label);
  db().update(schema.wallets).set({ label: parsed }).where(eq(schema.wallets.id, id)).run();
}

export function setArchived(id: string, archived: boolean) {
  db().update(schema.wallets).set({ archived }).where(eq(schema.wallets.id, id)).run();
  if (!archived) enqueueSync(id);
}

export function deleteWallet(id: string) {
  const wallet = db()
    .select({ network: schema.wallets.network, syncState: schema.wallets.syncState })
    .from(schema.wallets)
    .where(eq(schema.wallets.id, id))
    .get();
  if (!wallet) return;
  // Cascades to balances, transactions, movements, group links and alert logs.
  db().delete(schema.wallets).where(eq(schema.wallets.id, id)).run();
  // Provider-side cleanup (e.g. the shielded sidecar's copy of a viewing key)
  // runs in the worker: the web process makes no outbound calls.
  const adapter = getAdapters().get(wallet.network as never);
  if (adapter?.forget && Object.keys(wallet.syncState).length > 0) {
    enqueue("wallet.forget", { network: wallet.network, state: wallet.syncState });
  }
  logger.info({ walletId: id }, "wallet deleted");
}

export function setAssetHidden(assetId: string, hidden: boolean) {
  db().update(schema.assets).set({ hidden }).where(eq(schema.assets.id, assetId)).run();
}
