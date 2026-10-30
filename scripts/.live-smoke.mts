import { openDatabase, runMigrations, setHandleForTests, schema } from "@/server/db/client";
import { createWallet } from "@/server/wallets/service";
import { syncWallet } from "@/server/wallets/sync";
import { sharedHttp } from "@/server/chains/registry";
import { listWallets } from "@/server/wallets/queries";

const h = openDatabase(":memory:");
runMigrations(h.db);
setHandleForTests(h);
const zpub =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const items = [
  { network: "btc", input: zpub, label: "bip84 vector" },
  { network: "sol", input: "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg", label: "sol public" },
];
for (const it of items) {
  const { id } = createWallet(it);
  const t = Date.now();
  try {
    const r = await syncWallet(id, { http: sharedHttp(), signal: AbortSignal.timeout(900_000) });
    const w = listWallets().find((x) => x.id === id)!;
    console.log(
      it.label,
      "ok in",
      Date.now() - t,
      "ms; txs:",
      r.txCount,
      "balances:",
      w.balances
        .map((b) => `${b.symbol}=${b.amount}`)
        .slice(0, 5)
        .join(", "),
      "state keys:",
      Object.keys(w.syncState),
    );
  } catch (e) {
    console.log(it.label, "FAILED", (e as Error).message);
  }
}
console.log("tx rows:", h.db.select().from(schema.transactions).all().length);
