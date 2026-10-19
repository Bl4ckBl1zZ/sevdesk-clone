import { describe, expect, test } from "vitest";
import { type LayoutConfigLike, layoutDiffSummary, sameLayoutConfig } from "./layout-history";

const base: LayoutConfigLike = {
  template: "classic",
  accentColor: "#16a34a",
  font: "inter",
  logoPosition: "right",
  printOptions: {
    foldMarks: true,
    pageNumbers: true,
    senderLine: true,
    vatPerLine: false,
    productNumbers: false,
    lineDescriptions: true,
    grossLineTotals: false,
    epcQr: true,
    portalQr: false,
    allInvoiceAccountsInFooter: false,
    footerInLetterhead: null,
  },
};

describe("layout version history (SET-076)", () => {
  test("SET-076 the diff summary names every changed setting in German", () => {
    expect(layoutDiffSummary(null, base)).toEqual(["Erste Version"]);
    const next: LayoutConfigLike = {
      ...base,
      template: "modern",
      accentColor: "#1F6FEB",
      printOptions: { ...base.printOptions, foldMarks: false, vatPerLine: true },
    };
    expect(layoutDiffSummary(base, next)).toEqual([
      "Vorlage: Klassisch → Modern",
      "Akzentfarbe: #16a34a → #1F6FEB",
      "Falzmarken aus",
      "USt je Position an",
    ]);
    expect(layoutDiffSummary(base, { ...base, accentColor: "#16A34A" })).toEqual(["Keine Änderung"]);
    expect(sameLayoutConfig(base, { ...base })).toBe(true);
    expect(sameLayoutConfig(base, next)).toBe(false);
  });
});
