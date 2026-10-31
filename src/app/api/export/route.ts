import { eq } from "drizzle-orm";
import { z } from "zod";
import { authorizeRoute } from "@/server/auth/dal";
import { db, schema } from "@/server/db/client";
import { exportCsv } from "@/server/export/csv";
import { logger } from "@/server/log/logger";
import { walletIdsInGroup } from "@/server/wallets/groups";

const querySchema = z.object({
  wallet: z.uuid().optional(),
  group: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export async function GET(request: Request) {
  const denied = await authorizeRoute("export");
  if (denied) return denied;

  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) return Response.json({ error: "invalid_query" }, { status: 400 });
  const q = parsed.data;

  let walletIds: string[];
  let scopeName: string;
  if (q.wallet) {
    walletIds = [q.wallet];
    scopeName = "wallet";
  } else if (q.group) {
    walletIds = walletIdsInGroup(q.group);
    scopeName = "group";
  } else {
    walletIds = db()
      .select({ id: schema.wallets.id })
      .from(schema.wallets)
      .where(eq(schema.wallets.archived, false))
      .all()
      .map((w) => w.id);
    scopeName = "all";
  }
  if (walletIds.length === 0) return Response.json({ error: "nothing_to_export" }, { status: 404 });

  const stream = exportCsv({
    walletIds,
    from: q.from ? Math.floor(Date.parse(`${q.from}T00:00:00Z`) / 1000) : undefined,
    to: q.to ? Math.floor(Date.parse(`${q.to}T23:59:59Z`) / 1000) : undefined,
  });
  logger.info({ scope: scopeName, wallets: walletIds.length }, "csv export");
  const date = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="datastream-${scopeName}-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
