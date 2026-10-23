import { describe, expect, test } from "vitest";
import { type CompanyValues, companyDefaults, type TaxValues, taxDefaults } from "../schemas/settings";
import { calendarDate } from "../time/calendar-date";
import {
  companyFormFromProfile,
  companyForValidation,
  companyPatchFromForm,
  footerCompanyFromForm,
  newCompanyProfile,
  type ProfileData,
  type TaxSettingsData,
  taxFormFromProfile,
  taxPatchFromForm,
} from "./profile";

const today = calendarDate("2026-10-12");
const ctx = { today, now: 1_760_000_000_000 };

const base: CompanyValues = {
  ...companyDefaults,
  name: "Muster",
  street: "Hauptstraße 1",
  postalCode: "10115",
  city: "Berlin",
  contactName: "Erika Musterfrau",
  phone: "+49 30 123456",
  email: "info@muster.de",
};
const tax = (over: Partial<TaxValues> = {}): TaxValues => ({
  ...taxDefaults("einzelunternehmen"),
  taxNumberState: "BY",
  taxNumber: "181/815/08155",
  ...over,
});
const emptyTax = newCompanyProfile() as unknown as TaxSettingsData;

describe("company form → profile (SET-011, SET-015, SET-017)", () => {
  test("SET-011 the register type follows the legal form; forms without a register store none", () => {
    const typeOf = (legalForm: CompanyValues["legalForm"]) =>
      companyPatchFromForm({ ...base, legalForm, registerCourt: "Amtsgericht München", registerNumber: "1" }).register
        ?.type;
    expect(typeOf("ek")).toBe("HRA");
    expect(typeOf("ohg")).toBe("HRA");
    expect(typeOf("kg")).toBe("HRA");
    expect(typeOf("gmbh_co_kg")).toBe("HRA");
    expect(typeOf("ug")).toBe("HRB");
    expect(typeOf("ag")).toBe("HRB");
    expect(typeOf("partg")).toBe("PR");
    expect(typeOf("egbr")).toBe("GsR");
    expect(typeOf("einzelunternehmen")).toBeUndefined();
    expect(typeOf("freiberufler")).toBeUndefined();
    // Only a register number entered so far still creates the register (completeness is checked by SET-012).
    expect(companyPatchFromForm({ ...base, legalForm: "gmbh", registerNumber: "HRB 1" }).register).toEqual({
      court: "",
      type: "HRB",
      number: "HRB 1",
    });
    expect(companyPatchFromForm({ ...base, legalForm: "gmbh" }).register).toBeUndefined();
  });

  test("SET-011 an OHG/KG without a liable natural person stores the general partner; managing directors are split", () => {
    const ohg: CompanyValues = {
      ...base,
      legalForm: "ohg",
      noNaturalPersonLiable: true,
      generalPartnerName: "Verwaltungs GmbH",
      generalPartnerSeat: "Köln",
      generalPartnerRegisterCourt: "Amtsgericht Köln",
      generalPartnerRegisterNumber: "HRB 99",
      generalPartnerManagingDirectors: " Anna Muster , ,Ben Beispiel",
    };
    const p = companyPatchFromForm(ohg);
    expect(p.generalPartner).toEqual({
      name: "Verwaltungs GmbH",
      seat: "Köln",
      registerCourt: "Amtsgericht Köln",
      registerNumber: "HRB 99",
      managingDirectors: ["Anna Muster", "Ben Beispiel"],
    });
    expect(p.noNaturalPersonLiable).toBe(true);
    // With a natural person liable the general partner fields are ignored.
    const liable = companyPatchFromForm({ ...ohg, legalForm: "kg", noNaturalPersonLiable: false });
    expect(liable.generalPartner).toBeUndefined();
    expect(liable.noNaturalPersonLiable).toBe(false);
    // A GmbH & Co. KG always needs it; a GmbH never has the flag.
    expect(
      companyPatchFromForm({ ...ohg, legalForm: "gmbh_co_kg", noNaturalPersonLiable: false }).generalPartner?.name,
    ).toBe("Verwaltungs GmbH");
    expect(
      companyPatchFromForm({ ...ohg, legalForm: "gmbh_co_kg", generalPartnerName: "" }).generalPartner,
    ).toBeUndefined();
    expect(companyPatchFromForm({ ...ohg, legalForm: "gmbh" }).noNaturalPersonLiable).toBeUndefined();
  });

  test("SET-011 only an AG marks the supervisory board chair among the representatives", () => {
    const reps = [{ name: "Vorstand A", chair: true }, { name: "Vorstand B" }];
    const ag = companyPatchFromForm({ ...base, legalForm: "ag", representatives: reps, hasSupervisoryBoard: true });
    expect(ag.representatives).toEqual([{ name: "Vorstand A", role: "chair" }, { name: "Vorstand B" }]);
    expect(companyPatchFromForm({ ...base, legalForm: "gmbh", representatives: reps }).representatives).toEqual([
      { name: "Vorstand A" },
      { name: "Vorstand B" },
    ]);
  });

  test("SET-017 a deliberately chosen 0204/9930 electronic address is kept; EM follows the contact e-mail", () => {
    const leitwegId = { scheme: "0204" as const, value: "991-12345-67" };
    expect(companyPatchFromForm(base, { electronicAddress: leitwegId }).electronicAddress).toEqual(leitwegId);
    expect(
      companyPatchFromForm(base, { electronicAddress: { scheme: "EM", value: "old@muster.de" } }).electronicAddress,
    ).toEqual({ scheme: "EM", value: "info@muster.de" });
  });

  test("SET-015 empty optional fields are not stored; the form shows them as empty strings again", () => {
    const p = companyPatchFromForm(base);
    expect(p.tradeName).toBeUndefined();
    expect(p.seat).toBeUndefined();
    expect(p.supervisoryBoardChair).toBeUndefined();
    expect(p.address).not.toHaveProperty("poBox");
    expect(p.contact).not.toHaveProperty("website");
    const full = companyPatchFromForm({ ...base, poBox: "12 34", website: "https://muster.de", tradeName: "M" });
    expect(full.address.poBox).toBe("12 34");
    expect(full.contact.website).toBe("https://muster.de");
    const profile = { ...newCompanyProfile(), ...p } as unknown as ProfileData;
    expect(companyFormFromProfile(profile)).toEqual(base);
  });

  test("SET-010 an AG with chair and supervisory board round-trips losslessly", () => {
    const ag: CompanyValues = {
      ...base,
      legalForm: "ag",
      name: "Muster AG",
      seat: "München",
      registerCourt: "Amtsgericht München",
      registerNumber: "HRB 1",
      representatives: [{ name: "Vorstand A", chair: true }, { name: "Vorstand B" }],
      hasSupervisoryBoard: true,
      supervisoryBoardChair: "Dr. Aufsicht",
    };
    const profile = { ...newCompanyProfile(), ...companyPatchFromForm(ag) } as unknown as ProfileData;
    expect(companyFormFromProfile(profile)).toEqual(ag);
  });
});

describe("company profile → validation and footer (SET-012, SET-013)", () => {
  test("SET-012 register, general partner, supervisory board and liability flags reach validateCompanyForDocuments", () => {
    const kg: CompanyValues = {
      ...base,
      legalForm: "kg",
      name: "Muster KG",
      registerCourt: "Amtsgericht Köln",
      registerNumber: "HRA 7",
      noNaturalPersonLiable: true,
      generalPartnerName: "Verwaltungs GmbH",
      generalPartnerManagingDirectors: "Anna Muster",
    };
    const profile = {
      ...newCompanyProfile(),
      ...companyPatchFromForm(kg),
      hasSupervisoryBoard: false,
      vatId: "DE136695976",
    } as unknown as ProfileData;
    const v = companyForValidation(profile);
    expect(v).toMatchObject({
      register: { court: "Amtsgericht Köln", type: "HRA", number: "HRA 7" },
      generalPartner: { name: "Verwaltungs GmbH", managingDirectors: ["Anna Muster"] },
      hasSupervisoryBoard: false,
      noNaturalPersonLiable: true,
      vatId: "DE136695976",
    });
    expect(v).not.toHaveProperty("taxNumber");
    expect(v).not.toHaveProperty("seat");
    const bare = companyForValidation({
      ...newCompanyProfile(),
      ...companyPatchFromForm(base),
    } as unknown as ProfileData);
    expect(bare).not.toHaveProperty("register");
    expect(bare).not.toHaveProperty("generalPartner");
    expect(bare).not.toHaveProperty("noNaturalPersonLiable");
  });

  test("SET-013 the footer preview carries trade name, seat, register, general partner and chair when entered", () => {
    const f = footerCompanyFromForm(
      {
        ...base,
        legalForm: "gmbh_co_kg",
        name: "Muster GmbH & Co. KG",
        tradeName: "Muster",
        seat: "Köln",
        registerCourt: "Amtsgericht Köln",
        registerNumber: "HRA 7",
        generalPartnerName: "Verwaltungs GmbH",
        supervisoryBoardChair: "Dr. Aufsicht",
      },
      { vatId: "DE136695976" },
    );
    expect(f).toMatchObject({
      tradeName: "Muster",
      seat: "Köln",
      register: { type: "HRA", number: "HRA 7" },
      generalPartner: { name: "Verwaltungs GmbH" },
      supervisoryBoardChair: "Dr. Aufsicht",
      vatId: "DE136695976",
    });
    expect(f).not.toHaveProperty("taxNumber");
    const plain = footerCompanyFromForm(base);
    for (const k of ["tradeName", "seat", "register", "generalPartner", "supervisoryBoardChair", "vatId"]) {
      expect(plain).not.toHaveProperty(k);
    }
  });
});

describe("tax form → profile (SET-030 ff.)", () => {
  test("SET-030 an invalid tax number is refused even if the form validation was bypassed (API/MCP)", () => {
    const r = taxPatchFromForm(tax({ taxNumber: "12/34" }), emptyTax, ctx);
    expect(r.ok ? null : r.error.code).toBe("tax_number_invalid");
    // The 13-digit ELSTER format works without a Land (the Land comes from the prefix).
    const elster = taxPatchFromForm(tax({ taxNumberState: "", taxNumber: "9181081508155" }), emptyTax, ctx);
    expect(elster.ok && elster.patch).toMatchObject({ taxNumber: "9181081508155", taxNumberState: "BY" });
  });

  test("SET-043 an unparseable prior-year turnover is refused", () => {
    const r = taxPatchFromForm(tax({ priorYearTurnover: "viel" }), emptyTax, ctx);
    expect(r.ok ? null : r.error).toEqual({
      code: "amount_invalid",
      message: "Bitte einen Betrag wie 24.500,00 eingeben.",
    });
  });

  test("SET-033 KU-04 leaving the KU with a waiver appends a regular entry carrying the waiver date", () => {
    const current: TaxSettingsData = { ...emptyTax, kleinunternehmer: [{ validFrom: "2025-01-01", isKU: true }] };
    const r = taxPatchFromForm(tax({ isKleinunternehmer: "no", kuWaiverDate: "2025-12-15" }), current, ctx);
    expect(r.ok && r.patch.kleinunternehmer).toEqual([
      { validFrom: "2025-01-01", isKU: true },
      { validFrom: "2026-01-01", isKU: false, waiverDate: "2025-12-15" },
    ]);
    // Saving the same waiver again changes nothing; a different waiver date replaces the entry of the same day.
    const again = taxPatchFromForm(
      tax({ isKleinunternehmer: "no", kuWaiverDate: "2025-12-15" }),
      { ...current, kleinunternehmer: r.ok ? r.patch.kleinunternehmer : [] },
      ctx,
    );
    expect(again.ok && again.patch.kleinunternehmer).toHaveLength(2);
    const changed = taxPatchFromForm(
      tax({ isKleinunternehmer: "no", kuWaiverDate: "2025-12-20" }),
      { ...current, kleinunternehmer: r.ok ? r.patch.kleinunternehmer : [] },
      ctx,
    );
    expect(changed.ok && changed.patch.kleinunternehmer.at(-1)).toEqual({
      validFrom: "2026-01-01",
      isKU: false,
      waiverDate: "2025-12-20",
    });
  });

  test("SET-039 the EÜR exemption confirmation keeps its first timestamp; founded-on and creditor ID are stored", () => {
    const first = taxPatchFromForm(
      tax({ euerConfirmed: true, foundedOn: "2024-03-01", creditorId: "DE98ZZZ09999999999", vatId: "DE136695976" }),
      { ...emptyTax, datev: undefined },
      ctx,
    );
    expect(first.ok && first.patch).toMatchObject({
      euerExemptionConfirmedAt: ctx.now,
      foundedOn: "2024-03-01",
      creditorId: "DE98ZZZ09999999999",
      vatId: "DE136695976",
      datev: { accountLength: 4, personalAccounts: true },
    });
    const kept = taxPatchFromForm(tax({ euerConfirmed: true }), { ...emptyTax, euerExemptionConfirmedAt: 42 }, ctx);
    expect(kept.ok && kept.patch.euerExemptionConfirmedAt).toBe(42);
    const bilanz = taxPatchFromForm(tax({ euerConfirmed: true, profitMethod: "bilanz" }), emptyTax, ctx);
    expect(bilanz.ok && bilanz.patch).not.toHaveProperty("euerExemptionConfirmedAt");
  });
});

describe("profile → tax form (SET-032, SET-037, SET-038)", () => {
  const profile = (over: Partial<TaxSettingsData>) =>
    ({ ...emptyTax, legalForm: "einzelunternehmen", ...over }) as TaxSettingsData & { legalForm: "einzelunternehmen" };

  test("SET-032 the status valid today is the latest entry up to today, whatever the stored order", () => {
    const f = taxFormFromProfile(
      profile({
        vatId: "DE136695976",
        kleinunternehmer: [
          { validFrom: "2026-01-01", isKU: false, waiverDate: "2025-12-15" },
          { validFrom: "2024-01-01", isKU: true },
          { validFrom: "2027-01-01", isKU: true },
        ],
        taxationMethod: [
          { validFrom: "2026-01-01", method: "ist" },
          { validFrom: "2025-01-01", method: "soll" },
        ],
        profitMethod: [{ validFromFiscalYear: 2026, method: "bilanz" }],
        chartOfAccounts: [
          { validFromFiscalYear: 2026, chart: "SKR04" },
          { validFromFiscalYear: 2024, chart: "SKR03" },
        ],
        ustvaPeriod: [{ year: 2026, period: "monthly", dauerfrist: true }],
      }),
      today,
    );
    expect(f).toMatchObject({
      isKleinunternehmer: "no",
      kuValidFrom: "",
      kuWaiverDate: "2025-12-15",
      taxationMethod: "ist",
      istConfirmed: true,
      profitMethod: "bilanz",
      chartOfAccounts: "SKR04",
      ustvaPeriod: "monthly",
      dauerfrist: true,
      taxNumber: "",
      taxNumberState: "",
    });
  });

  test("SET-037 SET-038 SET-044 without history rows the form shows the defaults (Soll, quarterly, EÜR, SKR03, 4 digits)", () => {
    const f = taxFormFromProfile(profile({ taxNumber: "9181081508155", datev: undefined }), today);
    expect(f).toMatchObject({
      taxNumber: "9181081508155",
      isKleinunternehmer: "no",
      kuWaiverDate: "",
      taxationMethod: "soll",
      ustvaPeriod: "quarterly",
      dauerfrist: false,
      profitMethod: "euer",
      chartOfAccounts: "SKR03",
      datevAccountLength: 4,
      datevConsultantNumber: "",
      creditorId: "",
    });
    // A KU entry valid today shows its start date.
    const ku = taxFormFromProfile(
      profile({ vatId: "DE136695976", kleinunternehmer: [{ validFrom: "2026-01-01", isKU: true }] }),
      today,
    );
    expect(ku).toMatchObject({ isKleinunternehmer: "yes", kuValidFrom: "2026-01-01" });
  });
});
