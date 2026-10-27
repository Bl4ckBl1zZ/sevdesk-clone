import { makeSnapshot } from "@test/factories/snapshot";
import { pdfText } from "@test/golden/pdf-text";
import { describe, expect, test } from "vitest";
import { PREVIEW_NUMBER } from "@/domain/documents/snapshot";
import { draftPdfFileName, pdfToPngs, renderDraftPdf } from "./draft-preview";
import { readEmbeddedFiles } from "./embedded-files";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG IHDR width/height (big-endian at bytes 16–23). */
const pngSize = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

describe("draft PDF preview (DOC-42, MCP-017)", { timeout: 60_000 }, () => {
  test("DOC-42 the draft PDF carries the ENTWURF watermark and no e-invoice XML", async () => {
    const snapshot = makeSnapshot({ number: PREVIEW_NUMBER });
    const pdf = await renderDraftPdf({ snapshot, layoutConfig: null, logo: null, letterhead: null });
    expect(Buffer.from(pdf.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(await pdfText(pdf)).toContain("ENTWURF – keine gültige Rechnung");
    expect(await readEmbeddedFiles(pdf)).toEqual([]);
  });

  test("DOC-42 the preview file name says Entwurf instead of the placeholder number", () => {
    expect(draftPdfFileName("invoice")).toBe("Rechnung-Entwurf.pdf");
    expect(draftPdfFileName("quote")).toBe("Angebot-Entwurf.pdf");
  });

  test("MCP-017 pdfToPngs rasterises each page (A4 portrait) up to the page limit", async () => {
    const pdf = await renderDraftPdf({ snapshot: makeSnapshot(), layoutConfig: null, logo: null, letterhead: null });
    const r = await pdfToPngs(pdf, { maxPages: 1, scale: 1 });
    expect(r.pageCount).toBeGreaterThanOrEqual(1);
    expect(r.pages).toHaveLength(1);
    const png = r.pages[0] ?? new Uint8Array();
    expect([...png.subarray(0, 8)]).toEqual(PNG_MAGIC);
    const { width, height } = pngSize(png);
    // A4 = 595 × 842 pt at scale 1
    expect(width).toBe(595);
    expect(height).toBe(842);
  });
});
