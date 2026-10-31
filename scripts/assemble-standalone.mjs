// Makes .next/standalone self-contained: static chunks, public/, DB
// migrations and the worker/CLI bundles, plus top-level links for the
// packages those bundles keep external (Next only reaches them through
// hashed .pnpm paths). Fails the build if any external can't be resolved.
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const out = ".next/standalone";
if (!existsSync(out)) throw new Error("Run `next build` first");
cpSync(".next/static", `${out}/.next/static`, { recursive: true });
cpSync("public", `${out}/public`, { recursive: true });
cpSync("drizzle", `${out}/drizzle`, { recursive: true });
cpSync("dist", `${out}/dist`, { recursive: true });

// Keep in sync with `external` in scripts/build-worker.mjs.
const EXTERNALS = ["better-sqlite3", "@node-rs/argon2", "pino"];
const nm = path.join(out, "node_modules");
const pnpmDir = path.join(nm, ".pnpm");

for (const pkg of EXTERNALS) {
  const target = path.join(nm, pkg);
  if (existsSync(target)) continue;
  mkdirSync(path.dirname(target), { recursive: true });
  // Prefer the copy Next already traced into .pnpm (it has the right native binary).
  const prefix = `${pkg.replace("/", "+")}@`;
  const traced = existsSync(pnpmDir)
    ? readdirSync(pnpmDir)
        .filter((d) => d.startsWith(prefix))
        .map((d) => path.join(pnpmDir, d, "node_modules", pkg))
        .find((p) => existsSync(p))
    : undefined;
  if (traced) {
    symlinkSync(path.relative(path.dirname(target), traced), target);
  } else {
    cpSync(realpathSync(path.join("node_modules", pkg)), target, {
      recursive: true,
      dereference: true,
    });
  }
}

const req = createRequire(path.resolve(out, "dist/worker.mjs"));
for (const pkg of EXTERNALS) {
  try {
    req.resolve(pkg);
  } catch {
    throw new Error(`standalone: external package "${pkg}" is not resolvable from dist/`);
  }
}
console.log("standalone assembled");
