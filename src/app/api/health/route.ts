import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";

export function GET() {
  try {
    db().get(sql`select 1`);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
