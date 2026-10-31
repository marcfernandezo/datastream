import { and, asc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { getAdapter } from "@/server/chains/registry";
import { db, schema } from "@/server/db/client";
import { txEurValues } from "@/server/portfolio/queries";
import { formatUnits } from "@/lib/format";

export const CSV_COLUMNS = [
  "date_utc",
  "wallet",
  "network",
  "txid",
  "direction",
  "status",
  "asset",
  "amount",
  "fee",
  "fee_asset",
  "eur_value_at_time",
  "explorer_url",
] as const;

/**
 * Escapes a text cell. Token names/symbols come from arbitrary on-chain
 * contracts, so formula injection (=, +, -, @, tab, CR) is neutralized by
 * prefixing a quote (OWASP CSV injection guidance).
 */
export function textCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Numeric cells we format ourselves; never escaped so spreadsheets parse them. */
const numCell = (value: string) => value.replace(/,/g, "");

const BATCH = 500;

export interface ExportScope {
  walletIds: string[];
  from?: number | undefined;
  to?: number | undefined;
}

/** Streams CSV in batches so large histories never sit fully in memory. */
export function exportCsv(scope: ExportScope): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const conds: SQL[] = [inArray(schema.transactions.walletId, scope.walletIds)];
  if (scope.from) conds.push(gte(schema.transactions.blockTime, scope.from));
  if (scope.to) conds.push(lte(schema.transactions.blockTime, scope.to));
  const where = and(...conds);
  const labels = new Map(
    db()
      .select({ id: schema.wallets.id, label: schema.wallets.label })
      .from(schema.wallets)
      .where(inArray(schema.wallets.id, scope.walletIds))
      .all()
      .map((w) => [w.id, w.label]),
  );
  let offset = 0;
  let headerSent = false;

  return new ReadableStream({
    pull(controller) {
      if (!headerSent) {
        controller.enqueue(encoder.encode(`${CSV_COLUMNS.join(",")}\n`));
        headerSent = true;
      }
      const txs = db()
        .select()
        .from(schema.transactions)
        .where(where)
        .orderBy(asc(schema.transactions.blockTime), asc(schema.transactions.id))
        .limit(BATCH)
        .offset(offset)
        .all();
      if (txs.length === 0) {
        controller.close();
        return;
      }
      offset += txs.length;

      const movements = db()
        .select({
          txId: schema.txMovements.txId,
          amount: schema.txMovements.amount,
          symbol: schema.assets.symbol,
          decimals: schema.assets.decimals,
          coingeckoId: schema.assets.coingeckoId,
        })
        .from(schema.txMovements)
        .innerJoin(schema.assets, eq(schema.assets.id, schema.txMovements.assetId))
        .where(
          inArray(
            schema.txMovements.txId,
            txs.map((t) => t.id),
          ),
        )
        .all();

      // Value every movement in the batch at once (keyed by its index).
      const blockTimes = new Map(txs.map((t) => [t.id, t.blockTime]));
      const eurByMovement = txEurValues(
        movements.map((m, idx) => ({
          id: idx,
          blockTime: blockTimes.get(m.txId) ?? null,
          movements: [m],
        })),
      );
      const indexOf = new Map(movements.map((m, idx) => [m, idx]));

      let out = "";
      for (const tx of txs) {
        const adapter = getAdapter(tx.network);
        const native = adapter.nativeAsset;
        const ms = movements.filter((m) => m.txId === tx.id);
        const date = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "";
        const rows = ms.length ? ms : [null];
        rows.forEach((m, i) => {
          const eur = m ? eurByMovement.get(indexOf.get(m)!) : null;
          const fee =
            i === 0 && tx.fee ? numCell(formatUnits(tx.fee, native.decimals, native.decimals)) : "";
          out +=
            [
              date,
              textCell(labels.get(tx.walletId) ?? ""),
              tx.network,
              textCell(tx.txid),
              tx.direction,
              tx.status,
              m ? textCell(m.symbol) : "",
              m ? numCell(formatUnits(m.amount, m.decimals, m.decimals)) : "",
              fee,
              fee ? native.symbol : "",
              eur === null || eur === undefined ? "" : eur.toFixed(2),
              textCell(adapter.explorerUrl("tx", tx.txid)),
            ].join(",") + "\n";
        });
      }
      controller.enqueue(encoder.encode(out));
    },
  });
}
