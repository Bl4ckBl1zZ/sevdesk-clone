import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Synthetic sevdesk export set (F09 TST-IMP-16, `test/fixtures/sevdesk-export/README.md`). */
export const SEVDESK_FIXTURES = join(import.meta.dirname);

export function sevdeskFixtureBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(SEVDESK_FIXTURES, path)));
}

export function sevdeskPdfNames(): string[] {
  return readdirSync(join(SEVDESK_FIXTURES, "pdf")).sort();
}
