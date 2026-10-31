import { z } from "zod";
import type { HttpClient } from "@/server/http/client";
import { HttpError } from "@/server/http/client";

/** Channel configs are stored encrypted (AAD alert-channel); they contain secrets. */

export const ntfyConfigSchema = z.object({
  kind: z.literal("ntfy"),
  /** Full topic URL, e.g. https://ntfy.sh/my-secret-topic or a self-hosted server. */
  url: z.url({
    protocol: /^https?$/,
    message: "Enter the full topic URL, e.g. https://ntfy.sh/your-topic",
  }),
  token: z.string().trim().max(200).optional(),
  hideAmounts: z.boolean().default(false),
});

export const telegramConfigSchema = z.object({
  kind: z.literal("telegram"),
  botToken: z
    .string()
    .trim()
    .regex(/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/, "That doesn't look like a Telegram bot token"),
  chatId: z
    .string()
    .trim()
    .regex(/^-?\d{3,20}$|^@[A-Za-z0-9_]{5,64}$/, "Use a numeric chat id or @channelname"),
  hideAmounts: z.boolean().default(false),
});

export const channelConfigSchema = z.discriminatedUnion("kind", [
  ntfyConfigSchema,
  telegramConfigSchema,
]);
export type ChannelConfig = z.infer<typeof channelConfigSchema>;

export interface AlertMessage {
  title: string;
  body: string;
  /** Link back to this Datastream instance (never to a block explorer). */
  link?: string | undefined;
  tags?: string[];
}

/** Display form that never reveals secrets. */
export function describeChannel(cfg: ChannelConfig): string {
  if (cfg.kind === "ntfy") {
    const u = new URL(cfg.url);
    return `${u.host}/••••`;
  }
  return `chat ${cfg.chatId.slice(0, 3)}••••`;
}

export async function sendAlert(
  http: HttpClient,
  cfg: ChannelConfig,
  msg: AlertMessage,
  signal?: AbortSignal,
) {
  if (cfg.kind === "ntfy") {
    // ntfy takes the raw text body; the JSON publish API needs the topic split out.
    const u = new URL(cfg.url);
    const topic = u.pathname.replace(/^\/+|\/+$/g, "");
    const res = await http
      .json<{ id?: string }>(`${u.origin}/`, {
        method: "POST",
        body: {
          topic,
          title: msg.title,
          message: msg.body,
          tags: msg.tags ?? [],
          ...(msg.link ? { click: msg.link } : {}),
        },
        headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
        retries: 2,
        ...(signal ? { signal } : {}),
      })
      .catch((err: unknown) => {
        throw new Error(
          `ntfy delivery failed${err instanceof HttpError ? ` (${err.status})` : ""}`,
        );
      });
    return res.id ?? null;
  }

  // The bot token is in the URL path: never let the underlying error message escape.
  const text = msg.link ? `${msg.title}\n${msg.body}\n${msg.link}` : `${msg.title}\n${msg.body}`;
  const res = await http
    .json<{ ok: boolean; description?: string }>(
      `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
      {
        method: "POST",
        body: { chat_id: cfg.chatId, text, disable_web_page_preview: true },
        retries: 2,
        ...(signal ? { signal } : {}),
      },
    )
    .catch((err: unknown) => {
      throw new Error(
        `Telegram delivery failed${err instanceof HttpError ? ` (${err.status})` : ""}`,
      );
    });
  if (!res.ok) throw new Error("Telegram delivery failed");
  return null;
}
