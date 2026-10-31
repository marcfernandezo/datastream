import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { createBitcoinAdapter } from "@/server/chains/bitcoin/adapter";
import { AddressDeriver, parseExtendedPublicKey } from "@/server/chains/bitcoin/derivation";
import { createEthereumAdapter } from "@/server/chains/ethereum/adapter";
import { createEtherscanProvider } from "@/server/chains/ethereum/etherscan";
import { createAlchemyProvider } from "@/server/chains/ethereum/alchemy";
import { createSolanaAdapter } from "@/server/chains/solana/adapter";
import { makeCtx, rpcResult, server, setupMsw } from "./helpers/msw";

setupMsw();

const ESPLORA = "https://esplora.test/api";
const stats = (funded: number, spent: number, txs: number, mempoolTxs = 0) => ({
  chain_stats: { funded_txo_sum: funded, spent_txo_sum: spent, tx_count: txs },
  mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: mempoolTxs },
});
const EXTERNAL = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

describe("bitcoin adapter (esplora)", () => {
  const btc = createBitcoinAdapter({
    esploraUrl: ESPLORA,
    explorerUrl: "https://mempool.test",
    gapLimit: 5,
  });

  it("single address: balance, incoming and outgoing with change", async () => {
    const me = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
    const txIn = {
      txid: "a".repeat(64),
      fee: 300,
      status: { confirmed: true, block_height: 800_000, block_time: 1_700_000_000 },
      vin: [{ prevout: { scriptpubkey_address: EXTERNAL, value: 100_300 } }],
      vout: [{ scriptpubkey_address: me, value: 100_000 }],
    };
    const txOut = {
      txid: "b".repeat(64),
      fee: 1_000,
      status: { confirmed: false },
      vin: [{ prevout: { scriptpubkey_address: me, value: 100_000 } }],
      vout: [
        { scriptpubkey_address: EXTERNAL, value: 60_000 },
        { scriptpubkey_address: me, value: 39_000 },
      ],
    };
    server.use(
      http.get(`${ESPLORA}/address/${me}`, () => HttpResponse.json(stats(139_000, 100_000, 2, 1))),
      http.get(`${ESPLORA}/address/${me}/txs`, () => HttpResponse.json([txOut, txIn])),
    );
    const { source } = btc.parseSource("address", me, {});
    const ctx = makeCtx();
    const txs = await btc.getTransactions(ctx, source, { knownTxids: new Set(), maxPages: 5 });
    const [balance] = await btc.getBalance(ctx, source);

    expect(balance!.amount).toBe(39_000n);
    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({ txid: txOut.txid, status: "pending", fee: 1_000n });
    expect(txs[0]!.movements[0]!.amount).toBe(-60_000n);
    expect(txs[1]).toMatchObject({
      txid: txIn.txid,
      status: "confirmed",
      fee: null,
      blockTime: 1_700_000_000,
    });
    expect(txs[1]!.movements[0]!.amount).toBe(100_000n);
  });

  it("xpub: gap-limit scan over receive and change chains", async () => {
    const zpub =
      "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
    const d = new AddressDeriver(parseExtendedPublicKey(zpub).xpub, "p2wpkh");
    const recv0 = d.address(0, 0);
    const recv2 = d.address(0, 2);
    const change0 = d.address(1, 0);

    const tx1 = {
      txid: "1".repeat(64),
      fee: 200,
      status: { confirmed: true, block_height: 1, block_time: 1_600_000_000 },
      vin: [{ prevout: { scriptpubkey_address: EXTERNAL, value: 50_200 } }],
      vout: [{ scriptpubkey_address: recv0, value: 50_000 }],
    };
    const tx2 = {
      txid: "2".repeat(64),
      fee: 500,
      status: { confirmed: true, block_height: 2, block_time: 1_600_100_000 },
      vin: [{ prevout: { scriptpubkey_address: recv0, value: 50_000 } }],
      vout: [
        { scriptpubkey_address: EXTERNAL, value: 30_000 },
        { scriptpubkey_address: change0, value: 19_500 },
      ],
    };
    // An internal transfer between our own addresses: only the fee leaves.
    const tx3 = {
      txid: "3".repeat(64),
      fee: 100,
      status: { confirmed: true, block_height: 3, block_time: 1_600_200_000 },
      vin: [{ prevout: { scriptpubkey_address: change0, value: 19_500 } }],
      vout: [{ scriptpubkey_address: recv2, value: 19_400 }],
    };
    const requested: string[] = [];
    server.use(
      http.get(`${ESPLORA}/address/:addr`, ({ params }) => {
        const a = String(params.addr);
        requested.push(a);
        if (a === recv0) return HttpResponse.json(stats(50_000, 50_000, 2));
        if (a === change0) return HttpResponse.json(stats(19_500, 19_500, 2));
        if (a === recv2) return HttpResponse.json(stats(19_400, 0, 1));
        return HttpResponse.json(stats(0, 0, 0));
      }),
      http.get(`${ESPLORA}/address/:addr/txs`, ({ params }) => {
        const a = String(params.addr);
        if (a === recv0) return HttpResponse.json([tx2, tx1]);
        if (a === change0) return HttpResponse.json([tx3, tx2]);
        if (a === recv2) return HttpResponse.json([tx3]);
        return HttpResponse.json([]);
      }),
    );

    const { source } = btc.parseSource("xpub", zpub, {});
    expect(source.options.scriptType).toBe("p2wpkh");
    const ctx = makeCtx();
    const txs = await btc.getTransactions(ctx, source, { knownTxids: new Set(), maxPages: 5 });
    const [balance] = await btc.getBalance(ctx, source);

    expect(balance!.amount).toBe(19_400n);
    expect(txs.map((t) => t.txid)).toEqual([tx3.txid, tx2.txid, tx1.txid]);
    expect(txs[0]).toMatchObject({ fee: 100n, movements: [] });
    expect(txs[1]!.movements[0]!.amount).toBe(-30_000n);
    expect(txs[2]!.movements[0]!.amount).toBe(50_000n);
    // receive: 0..4 then 5..9 (gap reached after index 7); change: 0..4 then 5..9.
    expect(requested.length).toBe(20);
    expect(ctx.state.txCounts).toEqual({ "0/0": 2, "0/2": 1, "1/0": 2 });
  });

  it("auto-detects the script type of an ambiguous xpub", async () => {
    const xpub =
      "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ";
    const taproot0 = new AddressDeriver(xpub, "p2tr").address(0, 0);
    server.use(
      http.get(`${ESPLORA}/address/:addr`, ({ params }) =>
        HttpResponse.json(params.addr === taproot0 ? stats(1_000, 0, 1) : stats(0, 0, 0)),
      ),
      http.get(`${ESPLORA}/address/:addr/txs`, () => HttpResponse.json([])),
    );
    const { source } = btc.parseSource("xpub", xpub, { scriptType: "auto" });
    const ctx = makeCtx();
    const [balance] = await btc.getBalance(ctx, source);
    expect(ctx.state.scriptType).toBe("p2tr");
    expect(balance!.amount).toBe(1_000n);
  });

  it("rejects non-account-level xpubs", () => {
    expect(() =>
      btc.parseSource(
        "xpub",
        "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8",
        {},
      ),
    ).toThrow(/account-level/);
  });
});

const ME_ETH = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const OTHER_ETH = "0x000000000000000000000000000000000000dead";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

describe("ethereum adapter (etherscan)", () => {
  const API = "https://etherscan.test/v2/api";
  const eth = createEthereumAdapter({
    explorerUrl: "https://etherscan.test",
    provider: createEtherscanProvider({ apiUrl: API, apiKey: "k", chainId: 1 }),
  });

  it("normalizes ETH, fees and ERC-20 movements; refreshes token balances", async () => {
    const me = ME_ETH.toLowerCase();
    const calls: string[] = [];
    server.use(
      http.get(API, ({ request }) => {
        const p = new URL(request.url).searchParams;
        const action = p.get("action")!;
        calls.push(action);
        expect(p.get("chainid")).toBe("1");
        const ok = (result: unknown) => HttpResponse.json({ status: "1", message: "OK", result });
        switch (action) {
          case "txlist":
            return ok([
              {
                hash: "0xbb",
                blockNumber: "2",
                timeStamp: "1700000100",
                from: me,
                to: USDC,
                value: "0",
                gasUsed: "50000",
                gasPrice: "20000000000",
                isError: "0",
              },
              {
                hash: "0xaa",
                blockNumber: "1",
                timeStamp: "1700000000",
                from: OTHER_ETH,
                to: me,
                value: "1000000000000000000",
                gasUsed: "21000",
                gasPrice: "1",
                isError: "0",
              },
            ]);
          case "txlistinternal":
            return HttpResponse.json({ status: "0", message: "No transactions found", result: [] });
          case "tokentx":
            return ok([
              {
                hash: "0xbb",
                blockNumber: "2",
                timeStamp: "1700000100",
                from: me,
                to: OTHER_ETH,
                value: "5000000",
                contractAddress: USDC,
                tokenName: "USD Coin",
                tokenSymbol: "USDC",
                tokenDecimal: "6",
              },
            ]);
          case "balance":
            return ok("123");
          case "tokenbalance":
            expect(p.get("contractaddress")).toBe(USDC);
            return ok("1000000");
          default:
            return HttpResponse.json({ status: "0", message: "NOTOK", result: "unexpected" });
        }
      }),
    );
    const { source } = eth.parseSource("address", ME_ETH.toLowerCase(), {});
    expect(source.value).toBe(ME_ETH); // checksummed
    const ctx = makeCtx();
    const txs = await eth.getTransactions(ctx, source, { knownTxids: new Set(), maxPages: 3 });
    const native = await eth.getBalance(ctx, source);
    const tokens = await eth.getTokens(ctx, source);

    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({
      txid: "0xbb",
      fee: 1_000_000_000_000_000n,
      status: "confirmed",
    });
    expect(txs[0]!.movements).toEqual([expect.objectContaining({ amount: -5_000_000n })]);
    expect(txs[0]!.movements[0]!.asset).toMatchObject({
      id: `eth:${USDC}`,
      symbol: "USDC",
      decimals: 6,
    });
    expect(txs[1]).toMatchObject({ txid: "0xaa", fee: null });
    expect(txs[1]!.movements[0]).toMatchObject({ amount: 10n ** 18n, asset: { id: "eth" } });
    expect(native[0]!.amount).toBe(123n);
    expect(tokens).toEqual([expect.objectContaining({ amount: 1_000_000n })]);
    expect(calls.filter((c) => c === "tokenbalance")).toHaveLength(1);
  });

  it("rejects bad checksums and surfaces API errors without leaking the key", async () => {
    expect(() =>
      eth.parseSource("address", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96046", {}),
    ).toThrow(/checksum/);
    server.use(
      http.get(API, () =>
        HttpResponse.json({ status: "0", message: "NOTOK", result: "Invalid API Key" }),
      ),
    );
    const { source } = eth.parseSource("address", ME_ETH, {});
    const err = await eth.getBalance(makeCtx(), source).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Invalid API Key");
    expect((err as Error).message).not.toContain("apikey=k");
  });
});

describe("ethereum adapter (alchemy)", () => {
  const RPC = "https://alchemy.test/v2/key";
  const eth = createEthereumAdapter({
    explorerUrl: "https://etherscan.test",
    provider: createAlchemyProvider({ rpcUrl: RPC }),
  });

  it("merges sent/received transfers and fetches receipts for fees", async () => {
    const me = ME_ETH.toLowerCase();
    server.use(
      http.post(
        RPC,
        rpcResult({
          alchemy_getAssetTransfers: (params) => {
            const [q] = params as [{ fromAddress?: string }];
            return {
              transfers: q.fromAddress
                ? [
                    {
                      hash: "0x01",
                      blockNum: "0x10",
                      from: me,
                      to: OTHER_ETH,
                      category: "external",
                      rawContract: { value: "0x64", address: null, decimal: "0x12" },
                      asset: "ETH",
                      metadata: { blockTimestamp: "2024-01-01T00:00:00Z" },
                    },
                  ]
                : [
                    {
                      hash: "0x02",
                      blockNum: "0x11",
                      from: OTHER_ETH,
                      to: me,
                      category: "erc20",
                      rawContract: { value: "0x0f4240", address: USDC, decimal: "0x6" },
                      asset: "USDC",
                      metadata: { blockTimestamp: "2024-01-02T00:00:00Z" },
                    },
                  ],
            };
          },
          eth_getTransactionReceipt: () => ({
            gasUsed: "0x5208",
            effectiveGasPrice: "0x3b9aca00",
            status: "0x1",
          }),
          alchemy_getTokenMetadata: () => ({ symbol: "USDC", name: "USD Coin", decimals: 6 }),
          eth_getBalance: () => "0xde0b6b3a7640000",
          alchemy_getTokenBalances: () => ({
            tokenBalances: [{ contractAddress: USDC, tokenBalance: "0x0f4240" }],
          }),
        }),
      ),
    );
    const { source } = eth.parseSource("address", ME_ETH, {});
    const ctx = makeCtx();
    const txs = await eth.getTransactions(ctx, source, { knownTxids: new Set(), maxPages: 2 });
    expect(txs.map((t) => t.txid)).toEqual(["0x02", "0x01"]);
    expect(txs[1]).toMatchObject({ fee: 21_000n * 1_000_000_000n });
    expect(txs[1]!.movements[0]!.amount).toBe(-100n);
    expect(txs[0]!.movements[0]).toMatchObject({ amount: 1_000_000n, asset: { symbol: "USDC" } });
    expect((await eth.getBalance(ctx, source))[0]!.amount).toBe(10n ** 18n);
    expect(await eth.getTokens(ctx, source)).toEqual([
      expect.objectContaining({ amount: 1_000_000n }),
    ]);
  });
});

describe("solana adapter (rpc)", () => {
  const RPC = "https://solana.test";
  const ME = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
  const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const sol = createSolanaAdapter({
    rpcUrl: RPC,
    dasEnabled: false,
    explorerUrl: "https://solscan.test",
    rps: 1000,
    initialPages: 4,
  });

  it("computes SOL and SPL deltas, fees and balances", async () => {
    server.use(
      http.post(
        RPC,
        rpcResult({
          getBalance: () => ({ value: 1_500_000_000 }),
          getTokenAccountsByOwner: (params) => {
            const [, { programId }] = params as [string, { programId: string }];
            return {
              value: programId.startsWith("Tokenkeg")
                ? [
                    {
                      account: {
                        data: {
                          parsed: {
                            info: {
                              mint: USDC_MINT,
                              tokenAmount: { amount: "2500000", decimals: 6 },
                            },
                          },
                        },
                      },
                    },
                  ]
                : [],
            };
          },
          getSignaturesForAddress: () => [
            { signature: "sig1", slot: 10, blockTime: 1_700_000_000, err: null },
          ],
          getTransaction: () => ({
            blockTime: 1_700_000_000,
            slot: 10,
            meta: {
              fee: 5_000,
              err: null,
              preBalances: [2_000_000_000, 0],
              postBalances: [999_995_000, 1_000_000_000],
              preTokenBalances: [
                { mint: USDC_MINT, owner: ME, uiTokenAmount: { amount: "3000000", decimals: 6 } },
              ],
              postTokenBalances: [
                { mint: USDC_MINT, owner: ME, uiTokenAmount: { amount: "2500000", decimals: 6 } },
              ],
            },
            transaction: {
              message: {
                accountKeys: [
                  { pubkey: ME, signer: true },
                  { pubkey: OTHER, signer: false },
                ],
              },
            },
          }),
        }),
      ),
    );
    const { source } = sol.parseSource("address", ME, {});
    const ctx = makeCtx();
    const txs = await sol.getTransactions(ctx, source, { knownTxids: new Set(), maxPages: 2 });
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ txid: "sig1", fee: 5_000n, status: "confirmed" });
    expect(txs[0]!.movements).toEqual([
      expect.objectContaining({
        amount: -1_000_000_000n,
        asset: expect.objectContaining({ id: "sol" }),
      }),
      expect.objectContaining({
        amount: -500_000n,
        asset: expect.objectContaining({ id: `sol:${USDC_MINT}`, symbol: "USDC" }),
      }),
    ]);
    expect((await sol.getBalance(ctx, source))[0]!.amount).toBe(1_500_000_000n);
    expect(await sol.getTokens(ctx, source)).toEqual([
      expect.objectContaining({ amount: 2_500_000n }),
    ]);
  });

  it("stops paging at known signatures", async () => {
    let txCalls = 0;
    server.use(
      http.post(
        RPC,
        rpcResult({
          getSignaturesForAddress: () => [
            { signature: "new", slot: 2, blockTime: 2, err: null },
            { signature: "old", slot: 1, blockTime: 1, err: null },
          ],
          getTransaction: () => {
            txCalls++;
            return null;
          },
        }),
      ),
    );
    const { source } = sol.parseSource("address", ME, {});
    const txs = await sol.getTransactions(makeCtx(), source, {
      knownTxids: new Set(["old"]),
      maxPages: 5,
    });
    expect(txs.map((t) => t.txid)).toEqual(["new"]);
    expect(txCalls).toBe(1);
  });

  it("rejects invalid addresses", () => {
    expect(() => sol.parseSource("address", "not-base58-0OIl", {})).toThrow();
    expect(() => sol.parseSource("address", "abc", {})).toThrow();
  });
});
