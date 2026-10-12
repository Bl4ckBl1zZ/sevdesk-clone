import { describe, expect, test } from "vitest";
import { fieldsFor, LEGAL_FORMS, type LegalForm } from "./legal-forms";
import { type CompanyForValidation, hasLegalFormSuffix, validateCompanyForDocuments } from "./validate";

const NAMES: Record<LegalForm, string> = {
  einzelunternehmen: "Erika Musterfrau",
  freiberufler: "Erika Musterfrau",
  ek: "Muster Handel e.K.",
  gbr: "Muster GbR",
  egbr: "Muster eGbR",
  ohg: "Muster OHG",
  kg: "Muster KG",
  gmbh_co_kg: "Muster GmbH & Co. KG",
  gmbh: "Muster GmbH",
  ug: "Muster UG (haftungsbeschränkt)",
  ag: "Muster AG",
  partg: "Muster & Partner",
  other: "Muster eG",
};

/** Data that satisfies §5.2 for every legal form. */
function complete(legalForm: LegalForm): CompanyForValidation {
  const f = fieldsFor(legalForm);
  return {
    legalForm,
    name: NAMES[legalForm],
    address: { street: "Hauptstraße 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
    seat: "Berlin",
    contact: { name: "Erika Musterfrau", phone: "+49 30 123456", email: "info@muster.de" },
    ...(f.register
      ? { register: { court: "Amtsgericht Berlin-Charlottenburg", type: f.register, number: "12345" } }
      : {}),
    representatives: f.representatives ? [{ name: "Max Mustermann" }] : [],
    ...(f.generalPartner
      ? {
          generalPartner: {
            name: "Muster Verwaltungs GmbH",
            seat: "Berlin",
            registerCourt: "Amtsgericht Berlin-Charlottenburg",
            registerNumber: "HRB 54321",
            managingDirectors: ["Max Mustermann"],
          },
        }
      : {}),
    ...(legalForm === "ag" ? { supervisoryBoardChair: "Erika Musterfrau" } : {}),
    taxNumber: "9181081508155",
  };
}

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("validateCompanyForDocuments (F01 §5.2, MAIL-03)", () => {
  test("SET-004 a GmbH without managing directors is blocked with the § 35a GmbHG text (T-SET-004)", () => {
    const r = validateCompanyForDocuments({ ...complete("gmbh"), representatives: [] });
    expect(r.blocking).toEqual([
      expect.objectContaining({
        code: "representatives_missing",
        message: "Mindestens ein Geschäftsführer muss angegeben werden (§ 35a GmbHG).",
        params: { field: "representatives" },
      }),
    ]);
  });

  test.each(LEGAL_FORMS)("SET-012 complete data for „%s“ has no blocking issue (T-SET-006)", (legalForm) => {
    const r = validateCompanyForDocuments(complete(legalForm));
    expect(r.blocking).toEqual([]);
    expect(codes(r.warnings)).toEqual(legalForm === "other" ? ["legal_form_unchecked"] : []);
  });

  test("SET-011 missing register data blocks exactly the forms with a register; partners only warn (T-SET-006)", () => {
    for (const legalForm of LEGAL_FORMS) {
      const f = fieldsFor(legalForm);
      const { register: _r, ...withoutRegister } = complete(legalForm);
      const r = validateCompanyForDocuments({ ...withoutRegister, representatives: [] });
      const expected = [
        ...(f.register ? ["register_missing"] : []),
        ...(f.representatives?.required ? ["representatives_missing"] : []),
      ];
      expect(codes(r.blocking), legalForm).toEqual(expected);
      if (f.representatives && !f.representatives.required) {
        expect(codes(r.warnings), legalForm).toContain("partners_missing");
      }
    }
  });

  test("SET-015 base data: name, address, contact (BT-41/42/43) and a tax ID are mandatory (T-SET-006)", () => {
    const r = validateCompanyForDocuments({
      ...complete("einzelunternehmen"),
      address: { street: "", postalCode: "1011", city: "", countryCode: "DE" },
      contact: { name: "Erika Musterfrau", phone: "", email: "" },
      taxNumber: "",
    });
    expect(codes(r.blocking)).toEqual([
      "address_incomplete",
      "address_incomplete",
      "postal_code_invalid",
      "contact_missing",
      "tax_id_missing",
    ]);
    expect(r.blocking.find((i) => i.code === "contact_missing")?.params).toEqual({ field: "phone" });
  });

  test("SET-012 „Muster UG“ lacks the Rechtsformzusatz; „Muster UG (haftungsbeschränkt)“ is fine (T-SET-007)", () => {
    const missing = validateCompanyForDocuments({ ...complete("ug"), name: "Muster UG" });
    expect(missing.blocking).toEqual([
      expect.objectContaining({
        code: "legal_form_suffix_missing",
        message: "Die Firma muss den Rechtsformzusatz „UG (haftungsbeschränkt)“ enthalten.",
      }),
    ]);
    expect(validateCompanyForDocuments(complete("ug")).blocking).toEqual([]);
    expect(hasLegalFormSuffix("Muster Gesellschaft mit beschränkter Haftung", "gmbh")).toBe(true);
    expect(hasLegalFormSuffix("Mustergmbh", "gmbh")).toBe(false);
  });

  test("SET-012 an abbreviated first name of a representative is refused (T-SET-008)", () => {
    const r = validateCompanyForDocuments({ ...complete("gmbh"), representatives: [{ name: "M. Mustermann" }] });
    expect(codes(r.blocking)).toEqual(["representative_name_invalid"]);
  });

  test("SET-012 a GmbH & Co. KG needs the complete Komplementär incl. its managing director (T-SET-009)", () => {
    const base = complete("gmbh_co_kg");
    const r = validateCompanyForDocuments({
      ...base,
      generalPartner: {
        ...(base.generalPartner as NonNullable<CompanyForValidation["generalPartner"]>),
        managingDirectors: [""],
      },
    });
    expect(codes(r.blocking)).toEqual(["general_partner_incomplete"]);
    // OHG/KG only when no natural person is liable without limitation.
    expect(codes(validateCompanyForDocuments({ ...complete("kg"), noNaturalPersonLiable: true }).blocking)).toEqual([
      "general_partner_incomplete",
    ]);
  });

  test("SET-012 AG: board chair with several members, supervisory board chair; capital plausibility", () => {
    const ag = complete("ag");
    const r = validateCompanyForDocuments({
      ...ag,
      representatives: [{ name: "Max Mustermann" }, { name: "Erika Musterfrau" }],
      supervisoryBoardChair: "",
      shareCapital: { amountCents: 5_000_000, outstandingCents: 6_000_000 },
    });
    expect(codes(r.blocking)).toEqual(["board_chair_missing", "supervisory_chair_missing", "capital_invalid"]);
  });

  test("SET-012 an Einzelunternehmen named with a trade name only gets the full-name warning", () => {
    const r = validateCompanyForDocuments({ ...complete("einzelunternehmen"), name: "Musterladen" });
    expect(r.blocking).toEqual([]);
    expect(codes(r.warnings)).toEqual(["owner_name_incomplete"]);
  });
});
