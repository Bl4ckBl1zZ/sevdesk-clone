import { pdfText } from "@test/golden/pdf-text";
import { describe, expect, test } from "vitest";
import { renderCorrectionLetter } from "./correction-letter";

describe("INB-046 correction letter PDF", { timeout: 60_000 }, () => {
  test("INB-046 the letter text is printed as a PDF; reproducible for the same input and time", async () => {
    const letter = {
      subject: "Bitte um Rechnungskorrektur – Ihre Rechnung Nr. R-4711 vom 01.10.2026",
      text: "Muster GmbH\n\nBitte um Rechnungskorrektur – Ihre Rechnung Nr. R-4711 vom 01.10.2026\n\n– Geschäftsregelfehler (BR-DE-15): Leitweg-ID fehlt.\n– eine berichtigte Rechnung (Berichtigung nach § 31 Abs. 5 UStDV)",
    };
    const pdf = await renderCorrectionLetter(letter, 1_760_000_000_000);
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe("%PDF-");
    const text = await pdfText(pdf);
    expect(text).toContain("Bitte um Rechnungskorrektur");
    expect(text).toContain("Geschäftsregelfehler (BR-DE-15)");
    expect(text).toContain("§ 31 Abs. 5 UStDV");
    expect(await renderCorrectionLetter(letter, 1_760_000_000_000)).toEqual(pdf);
  });
});
