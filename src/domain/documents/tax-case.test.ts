import { describe, expect, test } from "vitest";
import type { VatCategory } from "../tax/vat-category";
import type { CalendarDate } from "../time/calendar-date";
import { CATEGORIES_BY_TAX_CASE, defaultCategoryFor, deriveTaxCase, type TaxCaseInput } from "./tax-case";

const DATE = "2026-10-12" as CalendarDate;
const valid = { status: "valid" as const, qualified: true };
const service = { productType: "service" as const, vatRateKey: "standard" };
const good = { productType: "good" as const, vatRateKey: "standard" };

const base: TaxCaseInput = {
  companyIsKleinunternehmer: false,
  companyHasVatId: true,
  contact: { countryCode: "DE", isConsumer: false, isPublicAuthority: false },
  lines: [service],
  date: DATE,
};
const derive = (patch: Partial<TaxCaseInput>, contact: Partial<NonNullable<TaxCaseInput["contact"]>> = {}) =>
  deriveTaxCase({ ...base, ...patch, contact: { ...(base.contact as object), ...contact } as TaxCaseInput["contact"] });
const caseOf = (...a: Parameters<typeof derive>) => {
  const r = derive(...a);
  return r.kind === "ok" ? [r.taxCase, r.row] : [r.kind, r.code];
};

describe("tax-case derivation (F04 App. C.2)", () => {
  test.each([
    // [label, input patch, contact patch, expected [taxCase, row]]
    ["row 1 document override", { override: "export" }, {}, ["export", 1]],
    ["row 1 contact default", {}, { defaultTaxCase: "exempt_4" }, ["exempt_4", 1]],
    ["row 2 margin scheme blocked", { marginScheme: true }, {}, ["blocked", "margin_scheme_blocked"]],
    ["row 3 KU, German business", { companyIsKleinunternehmer: true }, {}, ["kleinunternehmer", 3]],
    [
      "row 3 KU, foreign consumer",
      { companyIsKleinunternehmer: true },
      { countryCode: "FR", isConsumer: true },
      ["kleinunternehmer", 3],
    ],
    [
      "row 4 KU, EU business service",
      { companyIsKleinunternehmer: true },
      { countryCode: "AT", vatId: "ATU12345678", vatIdStatus: valid },
      ["eu_b2b_service", 4],
    ],
    [
      "row 4 KU, EU business service without own VAT ID",
      { companyIsKleinunternehmer: true, companyHasVatId: false },
      { countryCode: "AT" },
      ["blocked", "ku_foreign_service_no_vat_id"],
    ],
    [
      "row 4 KU, CH business service",
      { companyIsKleinunternehmer: true },
      { countryCode: "CH" },
      ["not_taxable_domestic", 4],
    ],
    [
      "row 5 KU, foreign business goods",
      { companyIsKleinunternehmer: true, lines: [good] },
      { countryCode: "AT" },
      ["kleinunternehmer", 5],
    ],
    [
      "row 6 CH property service",
      { lines: [{ ...service, placeOfSupplyRule: "property" }] },
      { countryCode: "CH" },
      ["domestic", 6],
    ],
    ["row 7 all exempt, German business", { lines: [{ ...service, vatRateKey: "exempt" }] }, {}, ["exempt_4", 7]],
    [
      "row 8 all §13b, German business",
      { lines: [{ ...service, reverseCharge13b: "construction" }] },
      {},
      ["reverse_charge_13b", 8],
    ],
    ["row 9 German consumer", {}, { isConsumer: true }, ["domestic", 9]],
    [
      "row 9 mixed §13b and normal lines",
      { lines: [service, { ...service, reverseCharge13b: "construction" }] },
      {},
      ["domestic", 9],
    ],
    [
      "row 10 EU business goods delivered to AT",
      { lines: [good] },
      { countryCode: "AT", vatId: "ATU12345678", vatIdStatus: valid },
      ["intra_community_supply", 10],
    ],
    [
      "row 11 EC-042 EU business goods delivered within DE",
      { lines: [good], deliveryCountry: "DE" },
      { countryCode: "AT", vatId: "ATU12345678", vatIdStatus: valid },
      ["domestic", 11],
    ],
    [
      "row 12 T-DOC-007 AT business service with verified VAT ID",
      {},
      { countryCode: "AT", vatId: "ATU12345678", vatIdStatus: valid },
      ["eu_b2b_service", 12],
    ],
    ["row 13 EU business without VAT ID", {}, { countryCode: "FR" }, ["domestic", 13]],
    [
      "row 13 EU business with invalid VAT ID",
      {},
      { countryCode: "FR", vatId: "FR00123456789", vatIdStatus: { status: "invalid", qualified: false } },
      ["domestic", 13],
    ],
    ["row 14 EU consumer service", {}, { countryCode: "FR", isConsumer: true }, ["domestic", 14]],
    ["row 14 EU consumer goods", { lines: [good] }, { countryCode: "FR", isConsumer: true }, ["domestic", 14]],
    ["row 15 export goods to CH", { lines: [good] }, { countryCode: "CH" }, ["export", 15]],
    ["row 15 export goods to US consumer", { lines: [good] }, { countryCode: "US", isConsumer: true }, ["export", 15]],
    ["row 15 GB goods", { lines: [good] }, { countryCode: "GB" }, ["export", 15]],
    ["row 16 non-EU business service", {}, { countryCode: "US" }, ["not_taxable_domestic", 16]],
    [
      "row 16 XI business service (goods-only VAT ID)",
      {},
      { countryCode: "XI", vatId: "XI123456789", vatIdStatus: valid },
      ["not_taxable_domestic", 16],
    ],
    [
      "row 17 non-EU consumer catalogue service",
      { lines: [{ ...service, placeOfSupplyRule: "catalogue_3a4" }] },
      { countryCode: "CH", isConsumer: true },
      ["not_taxable_domestic", 17],
    ],
    ["row 18 non-EU consumer other service", {}, { countryCode: "CH", isConsumer: true }, ["domestic", 18]],
    ["row 19 public authority like a German business", {}, { isPublicAuthority: true }, ["domestic", 19]],
    [
      "row 10 XI goods with goods-only VAT ID",
      { lines: [good] },
      { countryCode: "XI", vatId: "XI123456789", vatIdStatus: valid },
      ["intra_community_supply", 10],
    ],
  ] as const)("DOC-11 T-TAB-01 %s", (_label, patch, contact, expected) => {
    expect(caseOf(patch as Partial<TaxCaseInput>, contact as object)).toEqual(expected);
  });

  test("DOC-11 T-DOC-007 reason text for an EU B2B service names the country and the check", () => {
    const r = derive({}, { countryCode: "AT", vatId: "ATU12345678", vatIdStatus: valid });
    expect(r.kind === "ok" && r.reasons[0]).toContain("Österreich");
    expect(r.kind === "ok" && r.categoriesAllowed).toEqual(["AE"]);
  });

  test("DOC-11 a missing contact derives domestic (draft without customer)", () => {
    expect(deriveTaxCase({ ...base, contact: null })).toMatchObject({ kind: "ok", taxCase: "domestic" });
  });
});

describe("allowed categories per tax case (F04 App. C.3)", () => {
  const ALL: VatCategory[] = ["S", "Z", "E", "AE", "K", "G", "O", "KU"];
  test("DOC-12 T-TAB-02 every tax case × every category", () => {
    const expected: Record<string, VatCategory[]> = {
      domestic: ["S", "Z", "E", "AE"],
      kleinunternehmer: ["KU"],
      eu_b2b_service: ["AE"],
      intra_community_supply: ["K"],
      export: ["G"],
      not_taxable_domestic: ["O"],
      reverse_charge_13b: ["AE"],
      exempt_4: ["E"],
    };
    for (const [taxCase, cats] of Object.entries(CATEGORIES_BY_TAX_CASE)) {
      for (const cat of ALL) expect(cats.includes(cat), `${taxCase} ${cat}`).toBe(expected[taxCase]?.includes(cat));
    }
  });

  test("DOC-14 default category: §13b lines become AE line-wise in domestic documents for businesses only", () => {
    expect(defaultCategoryFor("domestic", { reverseCharge13b: "construction" }, "S", true)).toBe("AE");
    expect(defaultCategoryFor("domestic", { reverseCharge13b: "construction" }, "S", false)).toBe("S");
    expect(defaultCategoryFor("domestic", {}, "Z", true)).toBe("Z");
    expect(defaultCategoryFor("kleinunternehmer", {}, "S", true)).toBe("KU");
    expect(defaultCategoryFor("intra_community_supply", {}, "S", true)).toBe("K");
    expect(defaultCategoryFor("export", {}, "S", true)).toBe("G");
  });
});
