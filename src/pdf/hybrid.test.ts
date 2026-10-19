import { CII_BASIC_WL, CII_V6, ciiXml, hybridPdf, plainPdf } from "@test/fixtures/einvoice-in/builders";
import { describe, expect, test } from "vitest";
import { compareWithPdfText } from "@/domain/einvoice/compare-pdf";
import { parseReceivedXml } from "@/domain/einvoice/parse";
import { ENCRYPTED_PDF_MESSAGE, extractInvoiceXml, isEncryptedPdf, multipleXmlMessage, pdfTextLayer } from "./hybrid";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("hybrid PDFs (INB-022)", { timeout: 30_000 }, () => {
  test("INB-022 ER-02 T06-022 the embedded factur-x.xml is extracted byte-identically and parses", async () => {
    const xml = ciiXml();
    const r = await extractInvoiceXml(await hybridPdf([{ name: "factur-x.xml", xml }]));
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.name).toBe("factur-x.xml");
    expect(dec(r.bytes)).toBe(xml);
    expect(r.others).toEqual([]);
    expect(parseReceivedXml(dec(r.bytes)).ok).toBe(true);
  });

  test("INB-022 INB-023 golden V7: a BASIC-WL hybrid yields the XML flagged „keine E-Rechnung“", async () => {
    const r = await extractInvoiceXml(await hybridPdf([{ name: "ZUGFeRD-invoice.xml", xml: CII_BASIC_WL }]));
    expect(r.kind === "found" && r.name).toBe("ZUGFeRD-invoice.xml");
    if (r.kind !== "found") return;
    const p = parseReceivedXml(dec(r.bytes));
    expect(p.ok && p.value.invoice.notEInvoice).toBe(true);
  });

  test("INB-022 EC-INB-14 T06-029 two embedded invoice XMLs → factur-x.xml is used, the other listed", async () => {
    const pdf = await hybridPdf([
      { name: "xrechnung.xml", xml: CII_V6 },
      { name: "Factur-X.xml", xml: ciiXml() },
      { name: "notes.xml", xml: "<x/>" },
    ]);
    const r = await extractInvoiceXml(pdf);
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.name).toBe("Factur-X.xml");
    expect(r.others).toEqual(["xrechnung.xml"]);
    expect(multipleXmlMessage(r.name)).toBe("Mehrere eingebettete Rechnungs-XML gefunden. Verwendet: Factur-X.xml.");
  });

  test("INB-022 a plain PDF has no invoice XML; garbage is unreadable", async () => {
    expect(await extractInvoiceXml(await plainPdf())).toEqual({ kind: "none" });
    expect(await extractInvoiceXml(new TextEncoder().encode("%PDF-1.7 kaputt"))).toEqual({ kind: "unreadable" });
  });

  test("EC-INB-03 T06-028 an encrypted PDF is detected and never opened", async () => {
    const bytes = new TextEncoder().encode(
      "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer\n<</Root 1 0 R/Encrypt 5 0 R/ID[<a><a>]>>\n%%EOF",
    );
    expect(isEncryptedPdf(bytes)).toBe(true);
    expect(await extractInvoiceXml(bytes)).toEqual({ kind: "encrypted" });
    expect(await pdfTextLayer(bytes)).toBe("");
    expect(ENCRYPTED_PDF_MESSAGE).toContain("passwortgeschützt");
    expect(isEncryptedPdf(await plainPdf())).toBe(false);
  });

  test("EC-INB-15 EC-101 T06-030a the PDF text layer is read (no OCR) and compared with the XML", async () => {
    const pdf = await hybridPdf(
      [{ name: "factur-x.xml", xml: CII_V6 }],
      ["Rechnung", "Rechnungsnummer: LF-2026-0815", "Rechnungsdatum: 05.10.2026", "Gesamtbetrag 1.190,00 EUR"],
    );
    const text = await pdfTextLayer(pdf);
    expect(text).toContain("LF-2026-0815");
    const r = await extractInvoiceXml(pdf);
    if (r.kind !== "found") throw new Error(r.kind);
    const parsed = parseReceivedXml(dec(r.bytes));
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(compareWithPdfText(parsed.value.invoice, text)).toEqual(["Bruttobetrag"]);
    expect(await pdfTextLayer(new TextEncoder().encode("nope"))).toBe("");
  });
});
