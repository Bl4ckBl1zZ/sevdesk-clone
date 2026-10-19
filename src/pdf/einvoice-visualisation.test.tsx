import { CII_V6 } from "@test/fixtures/einvoice-in/builders";
import { pdfText } from "@test/golden/pdf-text";
import { describe, expect, test } from "vitest";
import { parseReceivedXml } from "@/domain/einvoice/parse";
import { renderEinvoiceVisualisation } from "./einvoice-visualisation";

describe("INB-040 E-Rechnung visualisation PDF", { timeout: 60_000 }, () => {
  test("INB-040 T06-040 the rendition shows the BT groups and is stamped „Visualisierung – nicht das Original“", async () => {
    const r = parseReceivedXml(CII_V6);
    if (!r.ok) throw new Error(r.error.message);
    const pdf = await renderEinvoiceVisualisation(r.value.invoice);
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe("%PDF-");
    const text = await pdfText(pdf);
    for (const s of [
      "Visualisierung – nicht das Original",
      "Rechnung LF-2026-0815",
      "Bürobedarf Schmidt & Söhne GmbH",
      "Muster Design GmbH",
      "Bestellung BEST-77",
      "Druckerpapier A4",
      "Treuerabatt",
      "160,60 EUR",
      "DE02120300000000202051",
      "Skonto 2 %",
      "Vielen Dank",
    ]) {
      expect(text).toContain(s);
    }
    // reproducible bytes for the same invoice
    expect(await renderEinvoiceVisualisation(r.value.invoice)).toEqual(pdf);
  });
});
