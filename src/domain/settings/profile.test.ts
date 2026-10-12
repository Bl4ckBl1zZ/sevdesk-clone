import { describe, expect, test } from "vitest";
import { validateCompanyForDocuments } from "../company/validate";
import { type CompanyValues, companyDefaults, taxDefaults, taxSchema } from "../schemas/settings";
import { calendarDate } from "../time/calendar-date";
import {
  companyFormFromProfile,
  companyForValidation,
  companyPatchFromForm,
  newCompanyProfile,
  type ProfileData,
  taxFormFromProfile,
  taxPatchFromForm,
} from "./profile";

const today = calendarDate("2026-10-12");
const ctx = { today, now: 1_760_000_000_000 };

const gmbh: CompanyValues = {
  ...companyDefaults,
  legalForm: "gmbh",
  name: "Muster GmbH",
  street: "Hauptstraße 1",
  postalCode: "10115",
  city: "Berlin",
  seat: "Berlin",
  contactName: "Erika Musterfrau",
  phone: "+49 30 123456",
  email: "info@muster.de",
  registerCourt: "Amtsgericht Berlin-Charlottenburg",
  registerNumber: "12345 B",
  representatives: [{ name: "Max Mustermann" }],
};

describe("company profile mapping (F01 SET-010, 03 companyProfile)", () => {
  test("SET-003 a new profile starts with neutral defaults: nothing counts as entered", () => {
    const p = newCompanyProfile() as unknown as ProfileData;
    expect(companyFormFromProfile(p)).toBeUndefined();
    expect(taxFormFromProfile(p, today)).toBeUndefined();
  });

  test("SET-017 SET-019 new profiles get the 03 defaults; the electronic address defaults to EM + contact e-mail", () => {
    const p = { ...newCompanyProfile(), ...companyPatchFromForm(gmbh) };
    expect(p.electronicAddress).toEqual({ scheme: "EM", value: "info@muster.de" });
    expect(p.defaults).toMatchObject({ paymentTerms: { dueDays: 14 }, priceMode: "net", language: "de" });
    expect(p.fiscalYearStartMonth).toBe(1);
  });

  test("SET-010 company form → profile → form is lossless; the profile feeds validateCompanyForDocuments", () => {
    const profile = { ...newCompanyProfile(), ...companyPatchFromForm(gmbh) } as unknown as ProfileData;
    expect(profile.register).toEqual({ court: "Amtsgericht Berlin-Charlottenburg", type: "HRB", number: "12345 B" });
    expect(companyFormFromProfile(profile)).toEqual(gmbh);
    const v = validateCompanyForDocuments(companyForValidation(profile));
    expect(v.blocking.map((i) => i.code)).toEqual(["tax_id_missing"]);
  });

  test("SET-043 SET-033 CLAUDE.md §4: the prior-year turnover is parsed to integer cents with the money parser", () => {
    const form = taxSchema.parse({
      ...taxDefaults("gmbh"),
      taxNumberState: "BY",
      taxNumber: "181/815/08155",
      priorYearTurnover: "24.500,50",
    });
    const r = taxPatchFromForm(form, newCompanyProfile() as unknown as ProfileData, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.priorYearTotalTurnoverCents).toEqual([{ year: 2025, amountCents: 2_450_050 }]);
    expect(r.patch.taxNumber).toBe("9181081508155");
    expect(r.patch.taxationMethod).toEqual([{ validFrom: "2026-01-01", method: "soll" }]);
    const back = taxFormFromProfile(
      { ...(newCompanyProfile() as unknown as ProfileData), ...r.patch, legalForm: "gmbh" },
      today,
    );
    expect(back?.priorYearTurnover).toBe("24.500,50");
    expect(back?.taxNumber).toBe("181/815/08155");
  });

  test("SET-032 SET-038 entering the KU appends a date-effective entry instead of rewriting history", () => {
    const base = newCompanyProfile() as unknown as ProfileData;
    const ku = taxSchema.parse({
      ...taxDefaults("einzelunternehmen"),
      vatId: "DE123456788",
      isKleinunternehmer: "yes",
      kuValidFrom: "2026-01-01",
      priorYearTurnover: "20.000,00",
    });
    const first = taxPatchFromForm(ku, base, ctx);
    if (!first.ok) throw new Error("expected ok");
    expect(first.patch.kleinunternehmer).toEqual([{ validFrom: "2026-01-01", isKU: true }]);
    expect(first.patch.ustvaPeriod).toEqual([{ year: 2026, period: "annual_only", dauerfrist: false }]);
    // Saving the same status again keeps the history unchanged.
    const again = taxPatchFromForm(ku, { ...base, ...first.patch }, ctx);
    expect(again.ok && again.patch.kleinunternehmer).toEqual(first.patch.kleinunternehmer);
  });
});

describe("SET-013 live footer preview from the company form", () => {
  test("SET-013 the form values plus tax IDs produce the footer company of geschaeftsbriefFooter", async () => {
    const { footerCompanyFromForm } = await import("./profile");
    const { geschaeftsbriefFooter } = await import("../company/footer");
    const company = footerCompanyFromForm(
      { ...gmbh, representatives: [{ name: "Max Mustermann" }] },
      { taxNumber: "27/815/08155", taxNumberState: "BE", vatId: "DE123456788" },
    );
    const footer = geschaeftsbriefFooter(company, [{ iban: "DE89370400440532013000", accountHolder: "Muster GmbH" }]);
    expect(footer.columns[1]).toEqual([
      "Sitz: Berlin",
      "Registergericht: Amtsgericht Berlin-Charlottenburg",
      "HRB 12345 B",
      "Geschäftsführer: Max Mustermann",
      "Steuernummer: 27/815/08155",
      "USt-IdNr.: DE123456788",
    ]);
    expect(footer.columns[2]).toEqual(["IBAN: DE89 3704 0044 0532 0130 00"]);
    // Without tax data (wizard step 6 before step 7) the tax lines are simply missing.
    expect(geschaeftsbriefFooter(footerCompanyFromForm(gmbh), []).columns[1]).not.toContain("USt-IdNr.: DE123456788");
  });
});
