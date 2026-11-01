import { BUYERS, makeSnapshot, SELLERS } from "@test/factories/snapshot";
import { pdfText } from "@test/golden/pdf-text";
import { describe, expect, test } from "vitest";
import type { SnapshotInputItem } from "@/domain/documents/build-snapshot";
import { DEFAULT_LAYOUT, type RenderLayout } from "@/domain/documents/render-model";
import { renderArtifacts } from "./render-artifacts";
import { footerReserve } from "./sevdesk-document";

const SEVDESK: RenderLayout = { ...DEFAULT_LAYOUT, template: "sevdesk" };

const line = (i: number): SnapshotInputItem => ({
  kind: "item",
  name: `Artikel ${i}`,
  description: "Farbe: Grün",
  quantityMilli: 6_000,
  unitCode: "C62",
  unitLabel: "Stk",
  unitPriceMicros: 120_000,
  vatCategory: "KU",
  vatRateBp: 0,
});

const ku = (lines: SnapshotInputItem[]) =>
  makeSnapshot({
    seller: SELLERS.ku,
    buyer: BUYERS.b2b,
    taxCase: "kleinunternehmer",
    einvoice: { format: "none", decision: "NOT_REQUIRED" },
    lines,
  });

const flat = (text: string) => text.replaceAll(" | ", " ");

describe("SevdeskDocument (SET-071, DOC-30)", { timeout: 60_000 }, () => {
  test("DOC-30 prints every App. F item of a KU invoice in the sevdesk layout", async () => {
    const a = await renderArtifacts(ku([line(1)]), SEVDESK);
    const text = flat(await pdfText(a.pdf));
    expect(text).toContain("Rechnung Nr. RE-2026-0042");
    expect(text).toContain("Beschreibung Menge Einzelpreis Gesamtpreis");
    expect(text).toContain("6,00 Stk 12,00 EUR 72,00 EUR");
    expect(text).toContain("Gesamtbetrag netto 72,00 EUR");
    expect(text).toContain("Gesamtbetrag brutto 72,00 EUR");
    expect(text).toContain("§ 19");
    expect(text).toContain("Beispiel Kunde GmbH");
    expect(text).toContain("Lena Kleinert Fotografie → Gartenweg 3 → 04109 Leipzig");
    expect(text).toContain("201/815/08150");
    expect(text).toContain("1/1");
  });

  test("DOC-31 logo-less header, table head and footer repeat on every page", async () => {
    const a = await renderArtifacts(ku(Array.from({ length: 12 }, (_, i) => line(i + 1))), SEVDESK);
    const pages = (await pdfText(a.pdf)).split(/--- page \d+ ---/).filter(Boolean);
    expect(pages.length).toBeGreaterThan(1);
    for (const [i, page] of pages.entries()) {
      expect(flat(page)).toContain("Beschreibung Menge Einzelpreis Gesamtpreis");
      expect(page).toContain("Gartenweg 3");
      expect(page).toContain(`${i + 1}/${pages.length}`);
    }
  });

  test("DOC-32 UST-34 the Kopie stamp and the draft watermark still print", async () => {
    const copy = await pdfText((await renderArtifacts(ku([line(1)]), SEVDESK, "copy")).pdf);
    expect(copy).toContain("Kopie");
    const draft = await pdfText((await renderArtifacts(ku([line(1)]), SEVDESK, "draft")).pdf);
    expect(draft).toContain("ENTWURF");
  });

  test("INV-21 a regular invoice in this layout stays a hybrid PDF/A-3b", async () => {
    const a = await renderArtifacts(makeSnapshot(), SEVDESK);
    expect(a.kind).toBe("zugferd_pdf");
    expect(Buffer.from(a.pdf).toString("latin1")).toContain("<pdfaid:part>3</pdfaid:part>");
  });

  test("DOC-31 the page keeps room for a tall footer, so positions never run into the Pflichtangaben", () => {
    const short = [[{ value: "Lena Kleinert" }, { value: "Gartenweg 3" }, { value: "04109 Leipzig" }]];
    expect(footerReserve(short)).toBe(96);
    const tall = [
      Array.from({ length: 9 }, (_, i) => ({
        label: "Geschäftsführer",
        value: `Vorname Nachname ${i}, Weitere Person`,
      })),
    ];
    expect(footerReserve(tall)).toBeGreaterThan(21 + 9 * 2 * 11.5);
  });

  test("DOC-32 rendering is deterministic", async () => {
    const [a, b] = await Promise.all([
      renderArtifacts(ku([line(1)]), SEVDESK),
      renderArtifacts(ku([line(1)]), SEVDESK),
    ]);
    expect(b.sha256).toBe(a.sha256);
  });
});
