import { sha256 } from "@noble/hashes/sha2.js";
import { bech32m, createBase58check } from "@scure/base";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { createZcashAdapter, parseZcashTransparent } from "@/server/chains/zcash/adapter";
import { detectPrivateMaterial } from "@/server/crypto/secret-guard";
import { maskSensitive } from "@/server/log/mask";
import { makeCtx, server, setupMsw } from "./helpers/msw";

setupMsw();

const b58c = createBase58check(sha256);
const HASH = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
const T1 = b58c.encode(Uint8Array.from([0x1c, 0xb8, ...HASH]));
const T3 = b58c.encode(Uint8Array.from([0x1c, 0xbd, ...HASH]));
const TEX = bech32m.encode("tex", bech32m.toWords(HASH));
const API = "https://zec.test/zcash";

describe("zcash address parsing", () => {
  it("accepts t1/t3 and converts TEX to the equivalent t1", () => {
    expect(T1.startsWith("t1")).toBe(true);
    expect(T3.startsWith("t3")).toBe(true);
    expect(parseZcashTransparent(T1)).toBe(T1);
    expect(parseZcashTransparent(T3)).toBe(T3);
    expect(parseZcashTransparent(TEX)).toBe(T1);
  });

  it("rejects bad checksums, other networks and private keys", () => {
    expect(() => parseZcashTransparent(T1.slice(0, -1) + (T1.endsWith("a") ? "b" : "a"))).toThrow();
    expect(() => parseZcashTransparent("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toThrow();
    expect(detectPrivateMaterial("secret-extended-key-main1qqqq")).not.toBeNull();
  });

  it("masks transparent and TEX addresses in logs", () => {
    expect(maskSensitive(`sync ${T1} ${TEX}`)).not.toContain(T1);
    expect(maskSensitive(`sync ${TEX}`)).not.toContain(TEX);
  });
});

describe("zcash adapter (blockchair)", () => {
  const zec = createZcashAdapter({
    apiUrl: API,
    apiKey: "k",
    explorerUrl: "https://blockchair.test/zcash",
    rps: 1000,
  });

  it("parses balance and history, separating fees from sends", async () => {
    const feeBatches: string[] = [];
    server.use(
      http.get(`${API}/dashboards/address/:addr`, ({ params, request }) => {
        expect(new URL(request.url).searchParams.get("key")).toBe("k");
        return HttpResponse.json({
          data: {
            [String(params.addr)]: {
              address: { balance: 270_953, transaction_count: 3 },
              transactions: [
                {
                  block_id: -1,
                  hash: "c".repeat(64),
                  time: "2026-10-31 08:10:00",
                  balance_change: 5_000,
                },
                {
                  block_id: 3_536_791,
                  hash: "b".repeat(64),
                  time: "2026-10-31 08:07:38",
                  balance_change: -100_026_000,
                },
                {
                  block_id: 3_536_000,
                  hash: "a".repeat(64),
                  time: "2026-10-30 12:00:00",
                  balance_change: 100_291_953,
                },
              ],
            },
          },
          context: { code: 200 },
        });
      }),
      http.get(`${API}/dashboards/transactions/:hashes`, ({ params }) => {
        feeBatches.push(String(params.hashes));
        return HttpResponse.json({
          data: {
            ["b".repeat(64)]: {
              transaction: { hash: "b".repeat(64), fee: 26_000, block_id: 3_536_791 },
            },
          },
          context: { code: 200 },
        });
      }),
    );
    const { source } = zec.parseSource("address", TEX, {});
    expect(source.value).toBe(T1);
    const ctx = makeCtx();
    const txs = await zec.getTransactions(ctx, source, { knownTxids: new Set(), maxPages: 3 });
    const [balance] = await zec.getBalance(ctx, source);

    expect(balance!.amount).toBe(270_953n);
    expect(feeBatches).toEqual(["b".repeat(64)]);
    expect(txs.map((t) => t.status)).toEqual(["pending", "confirmed", "confirmed"]);
    expect(txs[1]).toMatchObject({
      fee: 26_000n,
      blockTime: Date.UTC(2026, 9, 31, 8, 7, 38) / 1000,
    });
    expect(txs[1]!.movements[0]!.amount).toBe(-100_000_000n);
    expect(txs[2]).toMatchObject({ fee: null });
    expect(txs[2]!.movements[0]!.amount).toBe(100_291_953n);
  });

  it("surfaces explorer errors and points viewing keys at the sidecar", async () => {
    server.use(
      http.get(`${API}/dashboards/address/:addr`, () =>
        HttpResponse.json({ data: null, context: { code: 430, error: "Rate limit" } }),
      ),
    );
    const { source } = zec.parseSource("address", T1, {});
    await expect(zec.getBalance(makeCtx(), source)).rejects.toThrow(/430/);
    // No `viewer` configured: see zcash-shielded.test.ts for the sidecar path.
    expect(() => zec.parseSource("ufvk", "uview1abc", {})).toThrow(/zcash-viewer sidecar/);
  });
});
