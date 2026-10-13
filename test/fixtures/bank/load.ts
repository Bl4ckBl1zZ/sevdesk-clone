import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Bank statement fixtures (07-testing §3.3): `test/fixtures/bank/<group>/<case>/<file>`. */
export const BANK_FIXTURES = join(import.meta.dirname);

export function bankFixture(path: string): string {
  return readFileSync(join(BANK_FIXTURES, path), "utf8");
}

export function bankFixtureBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(BANK_FIXTURES, path)));
}

/** Case directories below `revolut-statements/` (synthetic and, once provided, the owner's anonymised months). */
export function statementCases(): { dir: string; files: string[] }[] {
  const root = join(BANK_FIXTURES, "revolut-statements");
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      dir: d.name,
      files: readdirSync(join(root, d.name))
        .filter((f) => /\.(xml|csv|txt|sta|mt940)$/i.test(f))
        .sort(),
    }));
}

export const SYNTH = "revolut-statements/synthetic-2026-10";
