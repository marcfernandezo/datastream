// Copies the assets `output: "standalone"` leaves out, so .next/standalone is
// self-contained: static chunks, public/, DB migrations and the worker bundle.
import { cpSync, existsSync } from "node:fs";

const out = ".next/standalone";
if (!existsSync(out)) throw new Error("Run `next build` first");
cpSync(".next/static", `${out}/.next/static`, { recursive: true });
cpSync("public", `${out}/public`, { recursive: true });
cpSync("drizzle", `${out}/drizzle`, { recursive: true });
cpSync("dist", `${out}/dist`, { recursive: true });
console.log("standalone assembled");
