import { z } from "zod";

/** Validates the history filters coming from the URL. Invalid values are dropped, not errors. */
const schema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).catch(1),
  direction: z.enum(["in", "out", "self", "swap"]).optional().catch(undefined),
  asset: z
    .string()
    .max(120)
    .regex(/^[a-z]+(:[A-Za-z0-9]+)?$/)
    .optional()
    .catch(undefined),
  q: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9]*$/)
    .optional()
    .catch(undefined),
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
});

type Raw = Record<string, string | string[] | undefined>;

export function parseTxSearchParams(raw: Raw) {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const p = schema.parse({
    page: first(raw.page),
    direction: first(raw.direction),
    asset: first(raw.asset),
    q: first(raw.q),
    from: first(raw.from),
    to: first(raw.to),
  });
  return {
    ...p,
    fromTs: p.from ? Math.floor(Date.parse(`${p.from}T00:00:00Z`) / 1000) : undefined,
    toTs: p.to ? Math.floor(Date.parse(`${p.to}T23:59:59Z`) / 1000) : undefined,
  };
}

/** Builds a query string preserving current filters. */
export function txQuery(p: ReturnType<typeof parseTxSearchParams>, page: number) {
  const q = new URLSearchParams();
  if (p.direction) q.set("direction", p.direction);
  if (p.asset) q.set("asset", p.asset);
  if (p.q) q.set("q", p.q);
  if (p.from) q.set("from", p.from);
  if (p.to) q.set("to", p.to);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `?${s}` : "";
}
