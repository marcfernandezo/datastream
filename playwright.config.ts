import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const PORT = 3210;
const dataDir = path.resolve("test-results/e2e-data");

/** Isolated, deterministic environment. Upstream APIs point at the local mock server. */
export const e2eEnv = {
  NODE_ENV: "production",
  PORT: String(PORT),
  HOSTNAME: "127.0.0.1",
  DATABASE_PATH: path.join(dataDir, "wt.db"),
  BACKUP_DIR: path.join(dataDir, "backups"),
  MIGRATIONS_DIR: path.resolve("drizzle"),
  WATCHTOWER_ENC_KEY: Buffer.alloc(32, 9).toString("base64"),
  SETUP_TOKEN: "e2e-setup-token",
  COOKIE_SECURE: "false",
  LOG_LEVEL: "warn",
  LOGIN_MAX_ATTEMPTS: "100",
};

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    // Fresh DB every run.
    command: `rm -rf "${dataDir}" && node .next/standalone/server.js`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    env: e2eEnv,
    timeout: 60_000,
  },
});
