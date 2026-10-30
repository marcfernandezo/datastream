import { afterEach } from "vitest";
import { resetEnvCache } from "@/env";

// Deterministic test key: never use outside tests.
process.env.WATCHTOWER_ENC_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.LOG_LEVEL = "silent";

afterEach(() => resetEnvCache());
