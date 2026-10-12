import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads `.env.test.local` (written by `pnpm test:backend`, scripts/test-backend.ts) into process.env for the
 * integration project and Playwright. Variables that are already set win, so CI can inject its own values.
 * Without the file nothing happens and the backend suites skip.
 */
export function loadTestEnv(root = process.cwd()): void {
  const file = join(root, ".env.test.local");
  if (!existsSync(file)) return;
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
}

loadTestEnv();
