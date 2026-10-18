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

/** Synthetic set in the layout verified against real sevdesk exports (`test/fixtures/sevdesk-export-verified/`). */
export const SEVDESK_VERIFIED_FIXTURES = join(import.meta.dirname, "../sevdesk-export-verified");

export function sevdeskVerifiedBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(SEVDESK_VERIFIED_FIXTURES, path)));
}

export function sevdeskVerifiedPdfNames(): string[] {
  return readdirSync(join(SEVDESK_VERIFIED_FIXTURES, "pdf")).sort();
}
