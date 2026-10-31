"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z, ZodError } from "zod";
import { authorizeAction, AuthError } from "@/server/auth/dal";
import { SourceValidationError } from "@/server/chains/types";
import { PrivateKeyMaterialError } from "@/server/crypto/secret-guard";
import { logger } from "@/server/log/logger";
import {
  createGroup,
  deleteGroup,
  DuplicateGroupError,
  setMembership,
} from "@/server/wallets/groups";
import {
  createWallet,
  deleteWallet,
  DuplicateWalletError,
  enqueueSync,
  renameWallet,
  setArchived,
  setAssetHidden,
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
    const options: Record<string, string> = {};
    for (const key of ["scriptType", "birthday"]) {
      const v = formData.get(key);
      if (typeof v === "string" && v.trim()) options[key] = v.trim();
    }
    ({ id } = createWallet({
      network: formData.get("network"),
      input: formData.get("input"),
      label: formData.get("label"),
      options,
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

const assetIdSchema = z
  .string()
  .max(120)
  .regex(/^[a-z]+(:[A-Za-z0-9]+)?$/);

/** hide=true hides a token everywhere; hide=false shows it even if unpriced. */
export async function setAssetVisibilityAction(assetId: string, hide: boolean) {
  await authorizeAction();
  setAssetHidden(assetIdSchema.parse(assetId), hide);
  revalidatePath("/", "layout");
}

export async function createGroupAction(
  _prev: WalletFormState,
  formData: FormData,
): Promise<WalletFormState> {
  try {
    await authorizeAction();
    createGroup(String(formData.get("name") ?? ""));
  } catch (err) {
    if (err instanceof DuplicateGroupError) return { error: err.message };
    return { error: toMessage(err) };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function deleteGroupAction(groupId: string) {
  await authorizeAction();
  deleteGroup(idSchema.parse(groupId));
  revalidatePath("/", "layout");
}

export async function setMembershipAction(walletId: string, groupId: string, member: boolean) {
  await authorizeAction();
  setMembership(idSchema.parse(walletId), idSchema.parse(groupId), member);
  revalidatePath("/", "layout");
}
