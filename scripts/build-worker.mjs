// Bundles the worker and CLI into dist/. Native and worker-thread packages
// stay external and are resolved from node_modules at runtime.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("../tests/stubs/empty.ts", import.meta.url));

await build({
  entryPoints: { worker: "src/worker.ts", cli: "src/cli.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  alias: { "server-only": stub },
  external: ["better-sqlite3", "@node-rs/argon2", "pino", "pino-pretty"],
  banner: {
    js: "import { createRequire as __dsCreateRequire } from 'node:module'; const require = __dsCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});
