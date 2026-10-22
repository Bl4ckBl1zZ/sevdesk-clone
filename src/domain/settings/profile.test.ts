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

describe("SET-044 SET-034 tax form guards", () => {
  const base = () => newCompanyProfile() as unknown as ProfileData;
  const form = (over: Record<string, unknown>) =>
    taxSchema.parse({ ...taxDefaults("gmbh"), taxNumberState: "BE", taxNumber: "27/815/08155", ...over });

  test("SET-044 DATEV keys are validated in the form and stored as numbers; empty keys stay unset", () => {
    const r = taxPatchFromForm(
      form({ datevConsultantNumber: "12345", datevClientNumber: "42", datevAccountLength: "5" }),
      base(),
      ctx,
    );
    expect(r.ok && r.patch.datev).toEqual({
      accountLength: 5,
      personalAccounts: true,
      consultantNumber: 12345,
      clientNumber: 42,
    });
    const back = taxFormFromProfile({ ...base(), ...(r.ok ? r.patch : {}), legalForm: "gmbh" }, today);
    expect(back).toMatchObject({ datevConsultantNumber: "12345", datevClientNumber: "42", datevAccountLength: 5 });
    const invalid = taxSchema.safeParse({
      ...taxDefaults("gmbh"),
      taxNumberState: "BE",
      taxNumber: "27/815/08155",
      datevConsultantNumber: "999",
      datevAccountLength: 3,
    });
    expect(invalid.error?.issues.map((i) => [i.path[0], i.message])).toEqual([
      ["datevConsultantNumber", "Beraternummer: 1001 bis 9999999."],
      ["datevAccountLength", "Sachkontenlänge: 4 bis 9 Stellen."],
    ]);
  });

  test("SET-044 T-SET-088 after a DATEV export the account length is locked", () => {
    const stored = { ...base(), datev: { accountLength: 4, personalAccounts: true, consultantNumber: 12345 } };
    const r = taxPatchFromForm(form({ datevConsultantNumber: "12345", datevAccountLength: 5 }), stored, {
      ...ctx,
      datevExportCount: 1,
    });
    expect(r).toMatchObject({ ok: false, error: { code: "DATEV_ACCOUNT_LENGTH_LOCKED" } });
  });

  test("SET-041 ACC-007 E-ACC-09 the chart is locked once the fiscal year has journal entries", () => {
    const stored = { ...base(), chartOfAccounts: [{ validFromFiscalYear: 2026, chart: "SKR03" as const }] };
    const locked = taxPatchFromForm(form({ chartOfAccounts: "SKR04" }), stored, { ...ctx, journalFiscalYears: [2026] });
    expect(locked).toMatchObject({
      ok: false,
      error: {
        code: "CHART_LOCKED",
        message: "Der Kontenrahmen kann erst zum Beginn des nächsten Wirtschaftsjahres gewechselt werden.",
      },
    });
    expect(
      taxPatchFromForm(form({ chartOfAccounts: "SKR03" }), stored, { ...ctx, journalFiscalYears: [2026] }).ok,
    ).toBe(true);
    expect(
      taxPatchFromForm(form({ chartOfAccounts: "SKR04" }), stored, { ...ctx, journalFiscalYears: [2025] }).ok,
    ).toBe(true);
  });

  test("ACC-022 E-TAX-09 TST-ACC-17 EC-115 Soll/Ist cannot change for a year that already has postings (only from 1 January of a new year)", () => {
    const stored = { ...base(), taxationMethod: [{ validFrom: "2026-01-01", method: "soll" as const }] };
    const midYear = taxPatchFromForm(form({ taxationMethod: "ist", istConfirmed: true }), stored, {
      ...ctx,
      journalFiscalYears: [2026],
    });
    expect(midYear).toMatchObject({
      ok: false,
      error: {
        code: "TAXATION_METHOD_LOCKED",
        message:
          "Ein Wechsel der Versteuerungsart ist nur zum Jahresbeginn möglich – oder mit Genehmigung des Finanzamts (bitte Bescheid hinterlegen).",
      },
    });
    // unchanged method, or a year without postings yet (effective 1 January) → allowed
    expect(taxPatchFromForm(form({ taxationMethod: "soll" }), stored, { ...ctx, journalFiscalYears: [2026] }).ok).toBe(
      true,
    );
    const before = taxPatchFromForm(form({ taxationMethod: "ist", istConfirmed: true }), stored, {
      ...ctx,
      journalFiscalYears: [2025],
    });
    expect(before.ok && before.patch.taxationMethod).toEqual([{ validFrom: "2026-01-01", method: "ist" }]);
  });

  test("SET-042 the fiscal year start is locked after the first journal entry", () => {
    const stored = { ...base(), fiscalYearStartMonth: 1 };
    const r = taxPatchFromForm(form({ fiscalYearStartMonth: 7, profitMethod: "bilanz" }), stored, {
      ...ctx,
      journalFiscalYears: [2025],
    });
    expect(r).toMatchObject({ ok: false, error: { code: "FISCAL_YEAR_LOCKED" } });
  });

  test("SET-034 T-SET-016 a KU switch that rewrites an entry used by a finalised invoice is refused", () => {
    const stored = { ...base(), kleinunternehmer: [{ validFrom: "2026-01-01", isKU: true }] };
    const docs = [{ id: "d1", number: "RE-2026-0001", date: "2026-03-01" }];
    // Leaving the KU in 2026: the form writes a new entry from 1 Jan 2026 — replacing the used entry.
    const r = taxPatchFromForm(form({ isKleinunternehmer: "no" }), stored, { ...ctx, finalisedDocuments: docs });
    expect(r).toMatchObject({ ok: false, error: { code: "HISTORY_ENTRY_LOCKED" } });
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
