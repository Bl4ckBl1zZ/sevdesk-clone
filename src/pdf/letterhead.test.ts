import { inflateSync } from "node:zlib";
import {
  cmyk,
  PDFArray,
  PDFDocument,
  PDFName,
  type PDFRawStream,
  PDFString,
  rgb,
  StandardFonts,
} from "@cantoo/pdf-lib";
import { makeSnapshot } from "@test/factories/snapshot";
import { pdfText } from "@test/golden/pdf-text";
import { describe, expect, test } from "vitest";
import { DEFAULT_LAYOUT } from "@/domain/documents/render-model";
import { extractInvoiceXml } from "./hybrid";
import {
  A4_POINTS,
  applyLetterhead,
  LETTERHEAD_MAX_BYTES,
  LETTERHEAD_MESSAGES,
  validateLetterhead,
} from "./letterhead";
import { renderArtifacts, renderPdf } from "./render-artifacts";

const A4: [number, number] = [A4_POINTS.width, A4_POINTS.height];

/** A vector-only letterhead (no fonts): a coloured band per page. */
async function vectorLetterhead(pages = 1, size: [number, number] = A4): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage(size);
    p.drawRectangle({ x: 0, y: size[1] - 60, width: size[0], height: 60, color: rgb(0.1, 0.4, 0.2) });
  }
  return doc.save();
}

/** A letterhead with text in a standard font (Helvetica is referenced, not embedded). */
async function textLetterhead(labels: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of labels) {
    const p = doc.addPage(A4);
    p.drawText(label, { x: 40, y: 800, size: 9, font });
  }
  return doc.save();
}

describe("letterhead upload checks (F01 SET-072, ER-11)", () => {
  test("SET-072 a 1- or 2-page A4 portrait PDF without fonts, scripts or encryption is accepted", async () => {
    expect(await validateLetterhead(await vectorLetterhead(1))).toEqual({ ok: true, pages: 1 });
    expect(await validateLetterhead(await vectorLetterhead(2))).toEqual({ ok: true, pages: 2 });
    // a react-pdf document with embedded font subsets is a valid letterhead as well
    expect(await validateLetterhead(await renderPdf(makeSnapshot(), DEFAULT_LAYOUT, "original"))).toEqual({
      ok: true,
      pages: 1,
    });
  });

  test("SET-072 page count, A4 portrait, size and file type are enforced", async () => {
    expect(await validateLetterhead(await vectorLetterhead(3))).toMatchObject({ code: "letterhead_page_count" });
    expect(await validateLetterhead(await vectorLetterhead(1, [A4[1], A4[0]]))).toMatchObject({
      code: "letterhead_not_a4_portrait",
    });
    expect(await validateLetterhead(await vectorLetterhead(1, [612, 792]))).toMatchObject({
      code: "letterhead_not_a4_portrait",
      message: "Das Briefpapier muss im Format A4 hochkant (210 × 297 mm) angelegt sein.",
    });
    const big = new Uint8Array(LETTERHEAD_MAX_BYTES + 1);
    big.set(new TextEncoder().encode("%PDF-1.7\n"));
    expect(await validateLetterhead(big)).toMatchObject({ code: "letterhead_too_large" });
    expect(await validateLetterhead(new TextEncoder().encode("GIF89a"))).toMatchObject({ code: "letterhead_not_pdf" });
  });

  test("SET-072 JavaScript (document script or action) and encryption are refused", async () => {
    const doc = await PDFDocument.load(await vectorLetterhead(1));
    doc.catalog.set(PDFName.of("OpenAction"), doc.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert('x')") }));
    expect(await validateLetterhead(await doc.save())).toEqual({
      ok: false,
      code: "letterhead_javascript",
      message: LETTERHEAD_MESSAGES.letterhead_javascript,
    });
    const plain = new TextDecoder("latin1").decode(await vectorLetterhead(1));
    // an incremental update whose trailer names an encryption dictionary
    const encrypted = new TextEncoder().encode(`${plain}\ntrailer\n<< /Encrypt 9 0 R >>\n%%EOF\n`);
    expect(await validateLetterhead(encrypted)).toMatchObject({ code: "letterhead_encrypted" });
  });

  test("SET-072 ER-11 a DeviceCMYK letterhead is refused (the PDF/A-3 output intent is sRGB, LEGAL-OPEN)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage(A4).drawRectangle({ x: 0, y: 780, width: 595, height: 60, color: cmyk(0.9, 0.1, 0, 0.2) });
    expect(await validateLetterhead(await doc.save())).toEqual({
      ok: false,
      code: "letterhead_cmyk",
      message: LETTERHEAD_MESSAGES.letterhead_cmyk,
    });
    // a CMYK image or colour space resource is caught as well
    const named = await PDFDocument.load(await vectorLetterhead(1));
    named.getPage(0).node.set(PDFName.of("Resources"), named.context.obj({ ColorSpace: { CS0: "DeviceCMYK" } }));
    expect(await validateLetterhead(await named.save())).toMatchObject({ code: "letterhead_cmyk" });
  });

  test("SET-072 a letterhead with non-embedded fonts is refused (no rasteriser on the server, LEGAL-OPEN)", async () => {
    expect(await validateLetterhead(await textLetterhead(["Muster Design GmbH"]))).toMatchObject({
      code: "letterhead_fonts_not_embedded",
    });
  });
});

describe("letterhead as the page background (F01 SET-072)", { timeout: 60_000 }, () => {
  const lines = Array.from({ length: 45 }, (_, i) => ({
    kind: "item" as const,
    name: `Position ${i + 1}`,
    quantityMilli: 1_000,
    unitCode: "C62",
    unitPriceMicros: 100_000,
    vatCategory: "S" as const,
    vatRateBp: 1900,
  }));

  test("SET-072 page 1 is the background of the first page, page 2 of all later pages; the content stays on top", async () => {
    const snapshot = makeSnapshot({ lines });
    const plain = await renderPdf(snapshot, DEFAULT_LAYOUT, "original");
    const withLetterhead = await applyLetterhead(plain, {
      first: await textLetterhead(["BRIEFKOPF-ERSTE-SEITE", "BRIEFKOPF-FOLGESEITE"]),
    });
    const text = await pdfText(withLetterhead);
    const pages = text.split(/--- page \d+ ---\n/).filter(Boolean);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]).toContain("BRIEFKOPF-ERSTE-SEITE");
    expect(pages[0]).not.toContain("BRIEFKOPF-FOLGESEITE");
    for (const later of pages.slice(1)) {
      expect(later).toContain("BRIEFKOPF-FOLGESEITE");
      expect(later).not.toContain("BRIEFKOPF-ERSTE-SEITE");
    }
    expect(pages[0]).toContain("Position 1");
    // painted first: the letterhead XObject is drawn by the first content stream of every page
    const doc = await PDFDocument.load(withLetterhead);
    for (const page of doc.getPages()) {
      const contents = page.node.Contents();
      expect(contents).toBeInstanceOf(PDFArray);
      const first = doc.context.lookup((contents as PDFArray).get(0)) as PDFRawStream;
      const ops = Buffer.from(
        first.dict.has(PDFName.of("Filter")) ? inflateSync(first.contents) : first.contents,
      ).toString("latin1");
      expect(ops).toMatch(/\/[\w-]+ Do/);
    }
  });

  test("SET-072 a one-page letterhead is used on every page; a separate follow-page file wins for later pages", async () => {
    const plain = await renderPdf(makeSnapshot({ lines }), DEFAULT_LAYOUT, "original");
    const one = await pdfText(await applyLetterhead(plain, { first: await textLetterhead(["NUR-EINE-SEITE"]) }));
    expect(one.split("NUR-EINE-SEITE").length - 1).toBe(one.split(/--- page \d+ ---/).length - 1);
    const follow = await pdfText(
      await applyLetterhead(plain, {
        first: await textLetterhead(["ERSTE"]),
        follow: await textLetterhead(["FOLGE-DATEI"]),
      }),
    );
    const pages = follow.split(/--- page \d+ ---\n/).filter(Boolean);
    expect(pages[0]).toContain("ERSTE");
    expect(pages[1]).toContain("FOLGE-DATEI");
  });

  test("SET-072 INV-21 the ZUGFeRD XML is embedded after the letterhead and extracts unchanged", async () => {
    const snapshot = makeSnapshot();
    const a = await renderArtifacts(snapshot, DEFAULT_LAYOUT, "original", {
      letterhead: { first: await vectorLetterhead(1) },
    });
    expect(a.kind).toBe("zugferd_pdf");
    const xml = await extractInvoiceXml(a.pdf);
    expect(xml.kind).toBe("found");
    if (xml.kind === "found") expect(new TextDecoder().decode(xml.bytes)).toBe(new TextDecoder().decode(a.xml));
    // without a letterhead the rendering is unchanged (the goldens stay byte-identical)
    const without = await renderArtifacts(snapshot);
    expect(without.pdf.length).not.toBe(a.pdf.length);
  });
});
