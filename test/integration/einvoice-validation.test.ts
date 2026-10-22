/**
 * CI job `einvoice-validate` (07 §4): every golden XML through KoSIT (XRechnung 3.0.2 configuration, must be
 * "acceptable"), every hybrid PDF through Mustang + veraPDF (valid PDF/A-3 + XML) and every other PDF through
 * veraPDF (PDF/A-3b). Needs the einvoice-tools sidecar (services/einvoice-tools); skipped unless
 * EINVOICE_TOOLS_URL is set, e.g. `EINVOICE_TOOLS_URL=http://127.0.0.1:8080 pnpm test -p integration`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, rgb } from "@cantoo/pdf-lib";
import { describe, expect, test } from "vitest";
import { DEFAULT_LAYOUT } from "@/domain/documents/render-model";
import { validateLetterhead } from "@/pdf/letterhead";
import { renderArtifacts, renderPdf } from "@/pdf/render-artifacts";
import { CASES_DIR, ciiFormat, goldenSnapshot, loadGoldenCases, ublFormat } from "../golden/cases";

const url = process.env.EINVOICE_TOOLS_URL;
const cases = loadGoldenCases().filter((c) => !c.file.expectError);

interface KositResult {
  readonly acceptable: boolean;
  readonly scenario: string;
  readonly errors: readonly unknown[];
}
interface MustangResult {
  readonly valid: boolean;
  readonly pdfaValid: boolean;
  readonly pdfaFlavour?: string;
  readonly xmlValid?: boolean;
  readonly xmlPresent?: boolean;
  readonly errors: readonly unknown[];
}

async function kosit(xml: string): Promise<KositResult> {
  const res = await fetch(`${url}/validate/xml`, {
    method: "POST",
    body: xml,
    headers: { "content-type": "application/xml" },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as KositResult;
}

async function mustang(pdf: Uint8Array): Promise<MustangResult> {
  const res = await fetch(`${url}/validate/pdf`, {
    method: "POST",
    body: Buffer.from(pdf),
    headers: { "content-type": "application/pdf" },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as MustangResult;
}

describe.skipIf(!url)("einvoice-validate (KoSIT 1.6.3 / XRechnung 3.0.2, Mustang 2.26 + veraPDF)", () => {
  for (const c of cases) {
    const s = goldenSnapshot(c);
    for (const [kind, format] of [
      ["cii", ciiFormat(s)],
      ["ubl", ublFormat(s)],
    ] as const) {
      if (!format) continue;
      test(`${c.file.id} KoSIT accepts ${c.dir}/expected.${kind}.xml (${format})`, { timeout: 60_000 }, async () => {
        const xml = readFileSync(join(CASES_DIR, c.dir, `expected.${kind}.xml`), "utf8");
        const r = await kosit(xml);
        expect(r.errors, JSON.stringify(r.errors, null, 1)).toEqual([]);
        expect(r.acceptable).toBe(true);
      });
    }

    test(`${c.file.id} veraPDF/Mustang validate the PDF of ${c.dir}`, { timeout: 120_000 }, async () => {
      const a = await renderArtifacts(s, c.layout, c.variant);
      const r = await mustang(a.pdf);
      expect(r.pdfaValid, JSON.stringify(r.errors, null, 1)).toBe(true);
      expect(r.pdfaFlavour).toBe("3b");
      if (a.kind === "zugferd_pdf") {
        expect(r.xmlPresent).toBe(true);
        expect(r.xmlValid, JSON.stringify(r.errors, null, 1)).toBe(true);
        expect(r.valid).toBe(true);
      }
    });
  }

  test("SET-072 ER-11 a ZUGFeRD PDF with a letterhead background (vector + embedded-font page) stays PDF/A-3b", {
    timeout: 120_000,
  }, async () => {
    const c = cases.find((x) => goldenSnapshot(x).type === "invoice") ?? cases[0];
    if (!c) throw new Error("no golden case");
    const s = goldenSnapshot(c);
    const vector = await PDFDocument.create();
    vector.addPage([595.28, 841.89]).drawRectangle({ x: 0, y: 780, width: 595, height: 60, color: rgb(0.1, 0.4, 0.2) });
    // page 2: a react-pdf page with embedded font subsets, as a "text" letterhead for the later pages
    const text = await PDFDocument.load(await renderPdf(s, DEFAULT_LAYOUT, "original"));
    const [copied] = await vector.copyPages(text, [0]);
    if (copied) vector.addPage(copied);
    const letterhead = await vector.save();
    expect(await validateLetterhead(letterhead)).toEqual({ ok: true, pages: 2 });
    const a = await renderArtifacts(s, c.layout, c.variant, { letterhead: { first: letterhead } });
    const r = await mustang(a.pdf);
    expect(r.pdfaValid, JSON.stringify(r.errors, null, 1)).toBe(true);
    expect(r.pdfaFlavour).toBe("3b");
    if (a.kind === "zugferd_pdf") expect(r.xmlValid, JSON.stringify(r.errors, null, 1)).toBe(true);
  });
});
