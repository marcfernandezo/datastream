import { z } from "zod";

const bool = (def: boolean) => z.stringbool().default(def);
const int = (def: number, min = 1, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);
const optionalString = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();
const url = (def: string) => z.url({ protocol: /^https?$/ }).default(def);

const base64Key = z
  .string()
  .trim()
  .refine((v) => Buffer.from(v, "base64").length === 32, {
    message: "must be 32 random bytes, base64-encoded (generate with `pnpm ds gen-key`)",
  });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_PATH: z.string().default("./data/datastream.db"),
    BACKUP_DIR: z.string().default("./data/backups"),
    BACKUP_KEEP_DAILY: int(7, 0, 365),
    BACKUP_KEEP_WEEKLY: int(4, 0, 104),

    DATASTREAM_ENC_KEY: base64Key,
    DATASTREAM_ENC_KEY_PREVIOUS: base64Key.optional().or(z.literal("").transform(() => undefined)),

    AUTH_MODE: z.enum(["password", "network-only"]).default("password"),
    SETUP_TOKEN: optionalString,
    LOGIN_MAX_ATTEMPTS: int(5, 1, 1000),
    SESSION_TTL_HOURS: int(24 * 30, 1, 24 * 365),
    SESSION_IDLE_HOURS: int(24 * 7, 1, 24 * 365),
    COOKIE_SECURE: bool(true),
    ALLOWED_CIDRS: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    TRUST_PROXY: bool(false),
    PUBLIC_URL: optionalString.pipe(z.url().optional()),

    BASE_CURRENCY: z.literal("eur").default("eur"),
    SYNC_INTERVAL_MINUTES: int(15, 1, 24 * 60),
    PRICE_INTERVAL_MINUTES: int(5, 1, 24 * 60),
    HTTP_TIMEOUT_MS: int(20_000, 1_000, 120_000),

    BTC_ESPLORA_URL: url("https://mempool.space/api"),
    BTC_EXPLORER_URL: url("https://mempool.space"),
    BTC_GAP_LIMIT: int(20, 1, 200),
    /** Requests/second to Esplora. mempool.space blocks aggressive clients; raise for your own instance. */
    BTC_ESPLORA_RPS: z.coerce.number().positive().max(100).default(1),

    ETH_PROVIDER: z.enum(["etherscan", "alchemy"]).default("etherscan"),
    ETHERSCAN_API_URL: url("https://api.etherscan.io/v2/api"),
    ETHERSCAN_API_KEY: optionalString,
    ALCHEMY_API_URL: optionalString.pipe(z.url().optional()),
    ALCHEMY_API_KEY: optionalString,
    ETH_EXPLORER_URL: url("https://etherscan.io"),

    SOL_PROVIDER: z.enum(["helius", "rpc"]).default("rpc"),
    SOL_RPC_URL: url("https://api.mainnet-beta.solana.com"),
    HELIUS_API_KEY: optionalString,
    HELIUS_RPC_URL: url("https://mainnet.helius-rpc.com"),
    SOL_EXPLORER_URL: url("https://solscan.io"),
    /** Requests/second to SOL_RPC_URL (public mainnet RPC is heavily rate-limited). */
    SOL_RPC_RPS: z.coerce.number().positive().max(100).default(2),

    COINGECKO_API_KEY: optionalString,
    COINGECKO_API_TIER: z.enum(["demo", "pro"]).default("demo"),
    COINGECKO_BASE_URL: optionalString.pipe(z.url().optional()),
    COINGECKO_REQUESTS_PER_MINUTE: int(25, 1, 1000),
  })
  .superRefine((env, ctx) => {
    if (env.ALLOWED_CIDRS.length > 0 && !env.TRUST_PROXY) {
      ctx.addIssue({
        code: "custom",
        path: ["TRUST_PROXY"],
        message:
          "ALLOWED_CIDRS requires TRUST_PROXY=true behind a reverse proxy that overwrites X-Forwarded-For (e.g. the bundled Caddy). Without it the client IP is spoofable.",
      });
    }
    if (env.AUTH_MODE === "network-only" && env.ALLOWED_CIDRS.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_MODE"],
        message: "AUTH_MODE=network-only requires ALLOWED_CIDRS to be set.",
      });
    }
    if (env.ETH_PROVIDER === "alchemy" && !env.ALCHEMY_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["ALCHEMY_API_KEY"],
        message: "required for ETH_PROVIDER=alchemy",
      });
    }
    if (env.SOL_PROVIDER === "helius" && !env.HELIUS_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["HELIUS_API_KEY"],
        message: "required for SOL_PROVIDER=helius",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Parsed lazily so `next build` never needs runtime secrets. Fails fast with a readable error. */
export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper. */
export function resetEnvCache() {
  cached = undefined;
}
