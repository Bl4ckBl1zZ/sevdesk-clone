import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, test } from "vitest";
import { buildLayoutPreview, type LayoutPreviewData, renderLayoutPreview } from "./layout-preview";

const DATA: LayoutPreviewData = {
  today: "2026-10-12",
  layout: {
    name: "Standard",
    config: {
      template: "modern",
      accentColor: "#1F6FEB",
      printOptions: { foldMarks: true, pageNumbers: true, senderLine: true, footerInLetterhead: null },
    },
  },
  company: {
    legalForm: "gmbh",
    name: "Muster Design GmbH",
    address: { street: "Hauptstr. 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
    seat: "Berlin",
    contact: { name: "Erika Musterfrau", phone: "+49 30 123456", email: "info@muster.de" },
    register: { court: "Amtsgericht Charlottenburg", type: "HRB", number: "123456 B" },
    representatives: [{ name: "Max Mustermann" }],
    vatId: "DE123456788",
  },
  accounts: [{ iban: "DE89370400440532013000", bic: "COBADEFFXXX", accountHolder: "Muster Design GmbH" }],
  kleinunternehmer: false,
};

async function pdfText(buffer: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: false }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    parts.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  return parts.join("\n").replace(/\s+/g, " ");
}

describe("SET-073 layout preview PDF", () => {
  test("SET-073 SET-013 a sample invoice shows title, sample number, totals with 19 % and the Geschäftsbrief footer", async () => {
    const model = buildLayoutPreview(DATA, { type: "invoice", b2b: true });
    const text = await pdfText(await renderLayoutPreview(model));
    expect(text).toContain("Rechnung");
    expect(text).toContain("RE-2026-0001 (Muster)");
    expect(text).toContain("Beispiel Kunde GmbH");
    expect(text).toContain("USt 19 %");
    expect(text).toContain("1.785,00");
    expect(text).toContain("Geschäftsführer: Max Mustermann");
    expect(text).toContain("Registergericht: Amtsgericht Charlottenburg");
    expect(text).toContain("IBAN: DE89 3704 0044 0532 0130 00");
    expect(text).toContain("Seite 1 von 1");
  });

  test("SET-073 SET-072 the preview shows the uploaded letterhead as the page background", async () => {
    const lh = await PDFDocument.create();
    const font = await lh.embedFont(StandardFonts.Helvetica);
    lh.addPage([595.28, 841.89]).drawText("BRIEFPAPIER-VORSCHAU", { x: 40, y: 800, size: 9, font });
    const model = buildLayoutPreview(DATA, { type: "invoice", b2b: true });
    const text = await pdfText(await renderLayoutPreview(model, null, { first: await lh.save() }));
    expect(text).toContain("BRIEFPAPIER-VORSCHAU");
    expect(text).toContain("RE-2026-0001 (Muster)");
    expect(await pdfText(await renderLayoutPreview(model))).not.toContain("BRIEFPAPIER-VORSCHAU");
  });

  test("SET-073 KU-02 the Kleinunternehmer switch removes VAT and prints the § 19 note", async () => {
    const model = buildLayoutPreview(DATA, { type: "invoice", b2b: false, ku: true });
    const text = await pdfText(await renderLayoutPreview(model));
    expect(text).toContain("Erika Beispiel");
    expect(text).not.toContain("USt 19 %");
    expect(text).toContain("§ 19 Abs. 1 UStG");
  });

  test("SET-073 the delivery note has no prices; Angebot and Mahnung render with their titles", async () => {
    const ls = await pdfText(await renderLayoutPreview(buildLayoutPreview(DATA, { type: "delivery_note", b2b: true })));
    expect(ls).toContain("Lieferschein");
    expect(ls).not.toContain("Einzelpreis");
    expect(ls).not.toContain("Gesamtbetrag");
    const quote = buildLayoutPreview(DATA, { type: "quote", b2b: true });
    expect(quote.sample.title).toBe("Angebot");
    const reminder = buildLayoutPreview(DATA, { type: "reminder", b2b: true });
    expect(reminder.sample.title).toBe("Zahlungserinnerung");
  });

  test("SET-014 SET-075 the footer disappears only when the letterhead confirmation covers every legal-form item", () => {
    const withConfirmation = (items: string[]): LayoutPreviewData => ({
      ...DATA,
      layout: {
        name: "Briefpapier",
        config: {
          template: "classic",
          accentColor: "#000000",
          printOptions: { footerInLetterhead: { confirmedAt: 1, items } },
        },
      },
    });
    expect(
      buildLayoutPreview(withConfirmation(["Firma", "Sitz"]), { type: "invoice", b2b: true }).footer,
    ).not.toBeNull();
    expect(
      buildLayoutPreview(withConfirmation(["Firma", "Sitz", "Registergericht", "HRB", "Geschäftsführer"]), {
        type: "invoice",
        b2b: true,
      }).footer,
    ).toBeNull();
  });
});

describe("SET-073 preview query parameters", () => {
  test("SET-073 sample type, B2B/B2C, KU override and layout id; unknown values fall back to a B2B invoice", async () => {
    const { parsePreviewParams } = await import("./layout-preview");
    expect(parsePreviewParams(new URLSearchParams("typ=reminder&kunde=b2c&ku=1&layout=k57abc123def456"))).toEqual({
      type: "reminder",
      b2b: false,
      ku: true,
      layoutId: "k57abc123def456",
    });
    expect(parsePreviewParams(new URLSearchParams("typ=storno&layout=../x"))).toEqual({ type: "invoice", b2b: true });
  });
});
