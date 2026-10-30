import pino, { type Logger } from "pino";
import { maskDeep, maskSensitive } from "./mask";

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");

/**
 * Every message and every field goes through maskDeep, so a full address,
 * xpub, viewing key or txid can never reach stdout, even by accident.
 */
export const logger: Logger = pino({
  level,
  base: { app: "datastream", proc: process.env.DATASTREAM_PROCESS ?? "web" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ["*.password", "*.token", "*.apiKey", "*.authorization", "*.cookie", "*.xpub", "*.ufvk"],
    censor: "[redacted]",
  },
  formatters: {
    log: (obj) => maskDeep(obj) as Record<string, unknown>,
  },
  hooks: {
    logMethod(args, method) {
      const masked = args.map((a) => (typeof a === "string" ? maskSensitive(a) : a));
      return method.apply(this, masked as Parameters<typeof method>);
    },
  },
});

export function childLogger(bindings: Record<string, string>) {
  return logger.child(bindings);
}
