"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z, ZodError } from "zod";
import { authorizeAction, AuthError } from "@/server/auth/dal";
import { SourceValidationError } from "@/server/chains/types";
import { PrivateKeyMaterialError } from "@/server/crypto/secret-guard";
import { logger } from "@/server/log/logger";
import {
  createWallet,
  deleteWallet,
  DuplicateWalletError,
  enqueueSync,
  renameWallet,
  setArchived,
} from "@/server/wallets/service";

export type WalletFormState = { error?: string; ok?: boolean } | undefined;

const idSchema = z.uuid();

/** Maps known errors to safe messages. Never echoes user input back. */
function toMessage(err: unknown): string {
  if (err instanceof PrivateKeyMaterialError) return err.message;
  if (err instanceof SourceValidationError || err instanceof DuplicateWalletError)
    return err.message;
  if (err instanceof AuthError) return err.message;
  if (err instanceof ZodError) return err.issues[0]?.message ?? "Invalid input";
  logger.error({ err }, "wallet action failed");
  return "Something went wrong. Check the server logs.";
}

export async function addWallet(
  _prev: WalletFormState,
  formData: FormData,
): Promise<WalletFormState> {
  let id: string;
  try {
    await authorizeAction();
    const scriptType = formData.get("scriptType");
    ({ id } = createWallet({
      network: formData.get("network"),
      input: formData.get("input"),
      label: formData.get("label"),
      options: typeof scriptType === "string" && scriptType ? { scriptType } : {},
    }));
  } catch (err) {
    return { error: toMessage(err) };
  }
  revalidatePath("/wallets");
  redirect(`/wallets/${id}`);
}

export async function renameWalletAction(
  id: string,
  _prev: WalletFormState,
  formData: FormData,
): Promise<WalletFormState> {
  try {
    await authorizeAction();
    renameWallet(idSchema.parse(id), String(formData.get("label") ?? ""));
  } catch (err) {
    return { error: toMessage(err) };
  }
  revalidatePath(`/wallets/${id}`);
  return { ok: true };
}

export async function syncWalletAction(id: string) {
  await authorizeAction();
  enqueueSync(idSchema.parse(id));
  revalidatePath(`/wallets/${id}`);
}

export async function setArchivedAction(id: string, archived: boolean) {
  await authorizeAction();
  setArchived(idSchema.parse(id), archived);
  revalidatePath("/wallets");
  revalidatePath(`/wallets/${id}`);
}

export async function deleteWalletAction(id: string) {
  await authorizeAction();
  deleteWallet(idSchema.parse(id));
  revalidatePath("/wallets");
  redirect("/wallets");
}
