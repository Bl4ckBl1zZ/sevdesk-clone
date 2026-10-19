import { describe, expect, test } from "vitest";
import { findDuplicates, normaliseDocumentNumber } from "./duplicates";
import { correctProfile, learnProfile, suggestAccount } from "./suggest";
import { jaroWinkler, normaliseSupplierName, supplierKey, supplierKeys } from "./supplier-key";

describe("supplier key (VOU-040)", () => {
  test("VOU-040 key cascade VAT ID → IBAN → normalised name with legal forms stripped", () => {
    expect(supplierKey({ vatId: "de 123 456 789", iban: "DE89…", name: "X" })).toBe("vat:DE123456789");
    expect(supplierKey({ iban: "DE89 3704 0044 0532 0130 00", name: "X" })).toBe("iban:DE89370400440532013000");
    expect(supplierKey({ name: "Müller & Söhne GmbH & Co. KG" })).toBe("name:mueller soehne");
    expect(normaliseSupplierName("Google Ireland Ltd.")).toBe("google ireland");
    expect(normaliseSupplierName("Schreinerei Weiß e.K.")).toBe("schreinerei weiss");
    expect(normaliseSupplierName("Start UG (haftungsbeschränkt)")).toBe("start");
    expect(normaliseSupplierName("Amazon EU S.à r.l.")).toBe("amazon eu r l");
    expect(supplierKeys({ vatId: "IE1", name: "Google" })).toEqual(["vat:IE1", "name:google"]);
    expect(supplierKey({})).toBeNull();
  });
});

describe("account suggestions (VOU-041/042)", () => {
  const allowed = new Set(["4920", "4600", "4930", "4964"]);

  test("VOU-041 T06-090 cascade: profile 5× same account → 0.95 gelernt; 1–2 uses → 0.8; OCR × 0.9; keyword 0.6", () => {
    expect(
      suggestAccount({
        profile: { lastAccount: "4930", uses: 5, accountStreak: 5 },
        text: "",
        chart: "SKR03",
        allowed,
      }),
    ).toEqual({ account: "4930", confidence: 0.95, source: "profile", reason: "gelernt (5×)" });
    expect(
      suggestAccount({ profile: { lastAccount: "4930", uses: 2, accountStreak: 2 }, text: "", chart: "SKR03", allowed })
        ?.confidence,
    ).toBe(0.8);
    expect(
      suggestAccount({ ocr: { account: "4600", confidence: 0.9 }, text: "", chart: "SKR03", allowed }),
    ).toMatchObject({ account: "4600", confidence: 0.81, source: "ocr" });
    expect(suggestAccount({ text: "Telekom Deutschland GmbH", chart: "SKR03", allowed })).toEqual({
      account: "4920",
      confidence: 0.6,
      source: "keyword",
      reason: "Stichwort (Telefon)",
    });
    expect(suggestAccount({ text: "Unbekannt", chart: "SKR03", allowed })).toBeNull();
  });

  test("VOU-041 suggestions are restricted to the allowed accounts (direction and tax rule)", () => {
    expect(
      suggestAccount({
        profile: { lastAccount: "8400", uses: 9, accountStreak: 9 },
        text: "Telekom",
        chart: "SKR03",
        allowed,
      })?.account,
    ).toBe("4920");
  });

  test("VOU-042 T06-091 learning on finalisation and on correction", () => {
    const p1 = learnProfile(null, { account: "4930", taxRule: "input_vat_deductible" });
    expect(p1).toEqual({ lastAccount: "4930", lastTaxRule: "input_vat_deductible", uses: 1, accountStreak: 1 });
    const p3 = learnProfile(learnProfile(p1, { account: "4930", taxRule: "input_vat_deductible" }), {
      account: "4930",
      taxRule: "input_vat_deductible",
    });
    expect(p3).toMatchObject({ uses: 3, accountStreak: 3 });
    expect(learnProfile(p3, { account: "4600", taxRule: "no_input_vat" })).toMatchObject({
      lastAccount: "4600",
      uses: 4,
      accountStreak: 1,
    });
    expect(correctProfile(p3, { account: "4600", taxRule: "input_vat_deductible" })).toMatchObject({
      lastAccount: "4600",
      uses: 3,
      accountStreak: 1,
    });
  });
});

describe("duplicates (VOU-050…053)", () => {
  const base = {
    id: "v1",
    supplierName: "Büro Schmidt GmbH",
    documentNumber: "RE-2026/0042",
    documentDate: "2026-03-10",
    grossCents: 11_900,
  };

  test("VOU-052 EC-160 EC-VOU-24 normalised number match with the same supplier is a strong duplicate", () => {
    expect(normaliseDocumentNumber(" re-2026/0042 ")).toBe("RE20260042");
    expect(normaliseDocumentNumber("000123")).toBe("123");
    const f = findDuplicates({ ...base, id: "new", documentNumber: "RE 2026 0042" }, [base]);
    expect(f).toEqual([
      { id: "v1", level: "strong", reason: "gleiche Rechnung (Nummer und Datum)", label: "RE-2026/0042" },
    ]);
  });

  test("VOU-051 E-Rechnung identity: same seller VAT ID, BT-1 and BT-2 (ZUGFeRD PDF + separate XML) → strong", () => {
    const pdf = { ...base, supplierVatId: "DE123456789", supplierName: "Schmidt" };
    const xml = { ...base, id: "x", supplierVatId: "DE 123456789", supplierName: "Büro Schmidt" };
    expect(findDuplicates(xml, [pdf])[0]?.level).toBe("strong");
  });

  test("VOU-052 EC-VOU-25: same supplier and gross ± 3 days → probable; monthly subscription 30 days apart → none", () => {
    const other = { ...base, id: "v2", documentNumber: undefined, documentDate: "2026-03-12" };
    expect(findDuplicates({ ...base, id: "n", documentNumber: undefined }, [other])[0]?.level).toBe("probable");
    const monthly = { ...base, id: "v3", documentNumber: undefined, documentDate: "2026-04-09" };
    expect(findDuplicates({ ...base, id: "n", documentNumber: undefined }, [monthly])).toEqual([]);
  });

  test("VOU-052 possible: same gross, same date, similar name (Jaro-Winkler ≥ 0.85)", () => {
    expect(jaroWinkler("buero schmidt", "buero schmid")).toBeGreaterThan(0.85);
    const other = { id: "v9", supplierName: "Buero Schmid", documentDate: "2026-03-10", grossCents: 11_900 };
    expect(findDuplicates({ ...base, id: "n", documentNumber: undefined }, [other])[0]?.level).toBe("possible");
  });

  test("VOU-050 EC-160 identical file hash is a strong duplicate", () => {
    const a = { id: "a", documentDate: "2026-01-01", grossCents: 1, sha256s: ["abc"] };
    expect(
      findDuplicates({ id: "b", documentDate: "2026-05-01", grossCents: 99, sha256s: ["abc"] }, [a])[0],
    ).toMatchObject({
      level: "strong",
      reason: "identische Datei",
    });
  });

  test("VOU-053 a pair dismissed as „Keine Dublette“ is never reported again (both directions)", () => {
    const other = { ...base, id: "v2", duplicateDismissals: ["new"] };
    expect(findDuplicates({ ...base, id: "new" }, [other])).toEqual([]);
    expect(findDuplicates({ ...base, id: "new", duplicateDismissals: ["v2"] }, [{ ...base, id: "v2" }])).toEqual([]);
  });
});
