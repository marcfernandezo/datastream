import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import pino from "pino";
import { createHttpClient } from "@/server/http/client";
import type { SyncContext } from "@/server/chains/types";

export const server = setupServer();

export function setupMsw() {
  beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}

export function makeCtx(state: Record<string, unknown> = {}): SyncContext {
  return {
    http: createHttpClient({ timeoutMs: 2_000, defaultRps: 1_000 }),
    signal: new AbortController().signal,
    log: pino({ level: "silent" }),
    state,
    memo: new Map(),
  };
}

/** JSON-RPC router: maps method name to a result factory. */
export function rpcResult(handlers: Record<string, (params: unknown) => unknown>) {
  return async ({ request }: { request: Request }) => {
    const body = (await request.json()) as { id: number; method: string; params: unknown };
    const handler = handlers[body.method];
    if (!handler)
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `unmocked ${body.method}` },
      });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: handler(body.params) });
  };
}
