import type { HttpClient } from "@/server/http/client";

/**
 * CoinGecko client. Free "demo" tier is ~30 calls/min, so callers batch ids
 * and every request goes through the shared per-host throttle.
 */

export interface CoinGeckoConfig {
  apiKey: string | undefined;
  tier: "demo" | "pro";
  baseUrl: string | undefined;
  requestsPerMinute: number;
}

export interface SpotPrice {
  eur: number;
  change24h: number | null;
}

export interface CoinListEntry {
  id: string;
  symbol: string;
  name: string;
  platforms?: Record<string, string | null>;
}

/** CoinGecko platform ids for the networks we support. */
export const PLATFORM_FOR_NETWORK: Record<string, string> = {
  eth: "ethereum",
  sol: "solana",
};

const BATCH = 100;

export function createCoinGecko(http: HttpClient, cfg: CoinGeckoConfig) {
  const base =
    cfg.baseUrl?.replace(/\/$/, "") ??
    (cfg.tier === "pro"
      ? "https://pro-api.coingecko.com/api/v3"
      : "https://api.coingecko.com/api/v3");
  const headers: Record<string, string> = cfg.apiKey
    ? { [cfg.tier === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key"]: cfg.apiKey }
    : {};
  const rps = cfg.requestsPerMinute / 60;

  const get = <T>(path: string, signal?: AbortSignal) =>
    http.json<T>(`${base}${path}`, { headers, rps, ...(signal ? { signal } : {}) });

  return {
    async simplePrice(ids: string[], signal?: AbortSignal): Promise<Map<string, SpotPrice>> {
      const out = new Map<string, SpotPrice>();
      for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH);
        const q = new URLSearchParams({
          ids: chunk.join(","),
          vs_currencies: "eur",
          include_24hr_change: "true",
        });
        const res = await get<Record<string, { eur?: number; eur_24h_change?: number | null }>>(
          `/simple/price?${q}`,
          signal,
        );
        for (const [id, v] of Object.entries(res)) {
          if (typeof v.eur === "number")
            out.set(id, { eur: v.eur, change24h: v.eur_24h_change ?? null });
        }
      }
      return out;
    },

    /** Daily EUR closes for the last `days` days (free tier: max 365). */
    async dailyHistory(
      id: string,
      days: number,
      signal?: AbortSignal,
    ): Promise<[day: number, eur: number][]> {
      const q = new URLSearchParams({ vs_currency: "eur", days: String(days), interval: "daily" });
      const res = await get<{ prices: [number, number][] }>(
        `/coins/${encodeURIComponent(id)}/market_chart?${q}`,
        signal,
      );
      const byDay = new Map<number, number>();
      for (const [ms, eur] of res.prices) byDay.set(Math.floor(ms / 86_400_000), eur);
      return [...byDay];
    },

    coinsList(signal?: AbortSignal) {
      return get<CoinListEntry[]>("/coins/list?include_platform=true", signal);
    },
  };
}

export type CoinGecko = ReturnType<typeof createCoinGecko>;
