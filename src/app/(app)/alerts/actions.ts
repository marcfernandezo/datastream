"use server";

import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { authorizeAction, AuthError } from "@/server/auth/dal";
import {
  createChannel,
  deleteChannel,
  sendTestAlert,
  setChannelEnabled,
} from "@/server/alerts/service";
import { logger } from "@/server/log/logger";

export type ChannelFormState = { error?: string; ok?: boolean } | undefined;

const idSchema = z.uuid();

function toMessage(err: unknown) {
  if (err instanceof ZodError) return err.issues[0]?.message ?? "Invalid input";
  if (err instanceof AuthError) return err.message;
  logger.error({ err }, "alert action failed");
  return "Something went wrong. Check the server logs.";
}

const str = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
};

export async function addChannelAction(
  _prev: ChannelFormState,
  fd: FormData,
): Promise<ChannelFormState> {
  try {
    await authorizeAction();
    const kind = str(fd, "kind");
    const hideAmounts = fd.get("hideAmounts") === "on";
    const config =
      kind === "telegram"
        ? { kind, botToken: str(fd, "botToken"), chatId: str(fd, "chatId"), hideAmounts }
        : { kind, url: str(fd, "url"), token: str(fd, "token") || undefined, hideAmounts };
    const custom = str(fd, "scopeMode") === "custom";
    const scope = custom
      ? {
          walletIds: fd.getAll("walletIds").map(String),
          groupIds: fd.getAll("groupIds").map(String),
        }
      : null;
    if (scope && scope.walletIds.length === 0 && scope.groupIds.length === 0) {
      return { error: "Pick at least one wallet or group, or choose all wallets." };
    }
    createChannel({
      name: str(fd, "name"),
      config: config as never,
      scope,
      minEur: str(fd, "minEur") || 0,
    });
  } catch (err) {
    return { error: toMessage(err) };
  }
  revalidatePath("/alerts");
  return { ok: true };
}

export async function toggleChannelAction(id: string, enabled: boolean) {
  await authorizeAction();
  setChannelEnabled(idSchema.parse(id), enabled);
  revalidatePath("/alerts");
}

export async function deleteChannelAction(id: string) {
  await authorizeAction();
  deleteChannel(idSchema.parse(id));
  revalidatePath("/alerts");
}

export async function testChannelAction(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await authorizeAction();
    await sendTestAlert(idSchema.parse(id));
    return { ok: true };
  } catch (err) {
    // Channel errors are already secret-free (see alerts/channels.ts).
    return { ok: false, error: err instanceof Error ? err.message : "Delivery failed" };
  }
}
