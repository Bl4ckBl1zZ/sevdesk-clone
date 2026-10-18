import { describe, expect, test } from "vitest";
import {
  detectDateFormat,
  detectNumberFormat,
  normalizeHeader,
  parseAmountCents,
  parseImportDate,
  parseRateBp,
} from "./formats";

describe("F09 IMP-016/IMP-017 header normalisation and German CSV formats", () => {
  test("IMP-017 headers normalise case, umlauts (both spellings), punctuation and whitespace", () => {
    expect(normalizeHeader("Fällig am")).toBe("faellig am");
    expect(normalizeHeader("Faellig  am")).toBe("faellig am");
    expect(normalizeHeader("Straße")).toBe(normalizeHeader("Strasse"));
    expect(normalizeHeader("Kunden-Nr.")).toBe("kunden nr");
    expect(normalizeHeader(" USt-IdNr. ")).toBe("ust idnr");
    expect(normalizeHeader("Preis (netto)")).toBe("preis netto");
    expect(normalizeHeader("Netto 19%")).toBe("netto 19 %");
  });

  test("TST-IMP-24 IMP-016 German amounts parse to integer cents (comma decimal, dot grouping, €, minus)", () => {
    expect(parseAmountCents("1.234,56", "de")).toEqual({ ok: true, value: 123456 });
    expect(parseAmountCents("-119,00 €", "de")).toEqual({ ok: true, value: -11900 });
    expect(parseAmountCents("0,1", "de")).toEqual({ ok: true, value: 10 });
    expect(parseAmountCents("1\u00a0234,56 EUR", "de")).toEqual({ ok: true, value: 123456 });
    expect(parseAmountCents("1,234.56", "en")).toEqual({ ok: true, value: 123456 });
    expect(parseAmountCents("", "de")).toEqual({ ok: true, value: undefined });
    expect(parseAmountCents("12,345", "de").ok).toBe(false);
    expect(parseAmountCents("abc", "de").ok).toBe(false);
  });

  test("TST-IMP-24 E-IMP-26 number format detected from all values; „1.234“ alone is ambiguous", () => {
    expect(detectNumberFormat(["100,00", "1.190,00", ""])).toEqual({ kind: "decided", value: "de" });
    expect(detectNumberFormat(["100.00", "1,190.00"])).toEqual({ kind: "decided", value: "en" });
    expect(detectNumberFormat(["100", "250"])).toEqual({ kind: "decided", value: "de" });
    expect(detectNumberFormat(["1.234", "2.500"])).toEqual({ kind: "ambiguous" });
    expect(detectNumberFormat(["1.234", "12,50"])).toEqual({ kind: "decided", value: "de" });
    expect(detectNumberFormat(["12,50", "12.50"])).toEqual({ kind: "ambiguous" });
  });

  test("TST-IMP-24 E-IMP-26 dates: dotted and ISO decided, „03/04/2025“ needs a choice", () => {
    expect(detectDateFormat(["31.12.2025", "2025-01-02"])).toEqual({ kind: "decided", value: "dmy" });
    expect(detectDateFormat(["13/04/2025", "03/04/2025"])).toEqual({ kind: "decided", value: "dmy" });
    expect(detectDateFormat(["04/13/2025"])).toEqual({ kind: "decided", value: "mdy" });
    expect(detectDateFormat(["03/04/2025", "05/06/2025"])).toEqual({ kind: "ambiguous" });
    expect(parseImportDate("3.4.2025", "dmy")).toEqual({ ok: true, value: "2025-04-03" });
    expect(parseImportDate("03/04/2025", "mdy")).toEqual({ ok: true, value: "2025-03-04" });
    expect(parseImportDate("2025-04-03 00:00:00", "dmy")).toEqual({ ok: true, value: "2025-04-03" });
    expect(parseImportDate("31.12.25", "dmy")).toEqual({ ok: true, value: "2025-12-31" });
    expect(parseImportDate("31.02.2025", "dmy").ok).toBe(false);
    expect(parseImportDate("", "dmy")).toEqual({ ok: true, value: undefined });
  });

  test("IMP-010 VAT rates to basis points", () => {
    expect(parseRateBp("19")).toEqual({ ok: true, value: 1900 });
    expect(parseRateBp("7,0 %")).toEqual({ ok: true, value: 700 });
    expect(parseRateBp("16.00")).toEqual({ ok: true, value: 1600 });
    expect(parseRateBp("")).toEqual({ ok: true, value: undefined });
    expect(parseRateBp("viel").ok).toBe(false);
  });
});
