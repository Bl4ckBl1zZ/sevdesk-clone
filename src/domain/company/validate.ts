/**
 * `validateCompanyForDocuments` (F01 SET-012, §5.1/§5.2 Geschäftsbrief matrix; MAIL-03, UST-03, UST-04, ER-10).
 * Pure: returns blocking errors and warnings for the company data printed on every Geschäftsbrief. The same
 * function feeds the wizard checklist (SET-004), the settings page and — from P1 — the finalisation guard.
 *
 * Every issue carries `params.field` (the form field that fixes it) so callers can link to it (04 §1.5).
 */
import { type Issue, issue } from "../result";
import { isValidPostalCode, isWrittenOutName, REGISTER_NUMBER } from "../schemas/settings";
import { fieldsFor, type LegalForm } from "./legal-forms";

export interface CompanyForValidation {
  legalForm: LegalForm;
  name: string;
  address: { street: string; postalCode: string; city: string; countryCode: string; poBox?: string };
  seat?: string;
  contact: { name: string; phone: string; email: string };
  register?: { court: string; type: string; number: string };
  representatives: readonly { name: string; role?: "chair" }[];
  generalPartner?: {
    name: string;
    seat: string;
    registerCourt: string;
    registerNumber: string;
    managingDirectors: readonly string[];
  };
  hasSupervisoryBoard?: boolean;
  supervisoryBoardChair?: string;
  noNaturalPersonLiable?: boolean;
  shareCapital?: { amountCents: number; outstandingCents?: number };
  taxNumber?: string;
  vatId?: string;
}

export interface CompanyValidation {
  blocking: Issue[];
  warnings: Issue[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Abbreviations are delimited tokens and case-sensitive; spelled-out forms are case-insensitive. */
export function hasLegalFormSuffix(name: string, legalForm: LegalForm): boolean {
  const suffix = fieldsFor(legalForm).nameSuffix;
  if (!suffix) return true;
  const abbr = suffix.abbreviations.some((a) => new RegExp(`(^|[\\s,(])${escapeRegExp(a)}($|[\\s,)])`).test(name));
  const spelled = suffix.spelled.some((s) => name.toLocaleLowerCase("de").includes(s.toLocaleLowerCase("de")));
  return abbr || spelled;
}

const REPRESENTATIVES_MESSAGE: Partial<Record<LegalForm, string>> = {
  gmbh: "Mindestens ein Geschäftsführer muss angegeben werden (§ 35a GmbHG).",
  ug: "Mindestens ein Geschäftsführer muss angegeben werden (§ 35a GmbHG).",
  ag: "Mindestens ein Vorstandsmitglied muss angegeben werden (§ 80 AktG).",
};

const PARTNER_WARNING: Partial<Record<LegalForm, string>> = {
  gbr: "Gesellschafter fehlen — sie sollten auf Geschäftsbriefen genannt werden.",
  egbr: "Gesellschafter fehlen — sie sollten auf Geschäftsbriefen genannt werden.",
  ohg: "Gesellschafter fehlen — sie sollten auf Geschäftsbriefen genannt werden.",
  kg: "Persönlich haftende Gesellschafter fehlen — sie sollten auf Geschäftsbriefen genannt werden.",
  partg: "Partner fehlen — sie sollten auf Geschäftsbriefen genannt werden.",
};

export function validateCompanyForDocuments(c: CompanyForValidation): CompanyValidation {
  const blocking: Issue[] = [];
  const warnings: Issue[] = [];
  const block = (code: string, message: string, field: string, extra: Record<string, string> = {}) =>
    blocking.push(issue(code, message, { field, ...extra }));
  const warn = (code: string, message: string, field: string) => warnings.push(issue(code, message, { field }));
  const f = fieldsFor(c.legalForm);
  const name = c.name.trim();

  // §5.1 base data (SET-015/016)
  if (name.length < 2) block("required", "Bitte den Namen des Unternehmens angeben.", "name");
  if (!c.address.street.trim() && !c.address.poBox?.trim()) {
    block("address_incomplete", "Straße oder Postfach fehlt.", "street");
  }
  if (!c.address.city.trim()) block("address_incomplete", "Bitte den Ort angeben.", "city");
  if (!isValidPostalCode(c.address.countryCode, c.address.postalCode.trim())) {
    block("postal_code_invalid", "Die Postleitzahl ist ungültig.", "postalCode");
  }
  if (!c.contact.name.trim() || !c.contact.phone.trim() || !c.contact.email.trim()) {
    block(
      "contact_missing",
      "Ansprechpartner, Telefon und E-Mail des Unternehmens fehlen (Pflicht für E-Rechnungen, BT-41/42/43).",
      c.contact.name.trim() ? (c.contact.phone.trim() ? "email" : "phone") : "contactName",
    );
  }
  if (!c.taxNumber?.trim() && !c.vatId?.trim()) {
    block("tax_id_missing", "Steuernummer oder USt-IdNr fehlt (Pflichtangabe auf Rechnungen).", "taxNumber");
  }
  if (name.length < 2) return { blocking, warnings };

  // §5.2 Rechtsformzusatz
  if (f.nameSuffix && !hasLegalFormSuffix(name, c.legalForm)) {
    const suffix = f.nameSuffix.abbreviations[0] ?? f.nameSuffix.spelled[0] ?? "";
    block("legal_form_suffix_missing", `Die Firma muss den Rechtsformzusatz „${suffix}“ enthalten.`, "name", {
      suffix,
    });
  }
  if ((c.legalForm === "einzelunternehmen" || c.legalForm === "freiberufler") && !/^\S+\s+\S+/.test(name)) {
    warn(
      "owner_name_incomplete",
      "Bei Einzelunternehmen muss der vollständige Vor- und Nachname der Inhaberin bzw. des Inhabers angegeben werden; eine Geschäftsbezeichnung gehört in das Feld „Geschäftsbezeichnung“.",
      "name",
    );
  }

  // Register (§5.2 "Register")
  if (f.register) {
    const r = c.register;
    if (!r?.court.trim() || !r.number.trim() || r.type !== f.register) {
      block(
        "register_missing",
        `Registergericht und ${f.register}-Nummer fehlen (Pflichtangabe auf Geschäftsbriefen).`,
        r?.court.trim() ? "registerNumber" : "registerCourt",
        { type: f.register },
      );
    } else if (!(REGISTER_NUMBER[f.register]?.test(r.number.trim()) ?? true)) {
      block("register_number_invalid", "Die Registernummer ist ungültig.", "registerNumber");
    }
  }
  if (f.seat && !(c.seat?.trim() || c.address.city.trim())) {
    block("seat_missing", "Der Sitz der Gesellschaft fehlt (Pflichtangabe auf Geschäftsbriefen).", "seat");
  }

  // Representatives
  const reps = c.representatives.filter((r) => r.name.trim() !== "");
  if (f.representatives?.required && reps.length === 0) {
    block(
      "representatives_missing",
      REPRESENTATIVES_MESSAGE[c.legalForm] ?? "Vertretungsberechtigte fehlen.",
      "representatives",
    );
  }
  if (!f.representatives?.required && f.representatives && reps.length === 0) {
    const message = PARTNER_WARNING[c.legalForm];
    if (message) warn("partners_missing", message, "representatives");
  }
  for (const r of reps) {
    if (!isWrittenOutName(r.name)) {
      block(
        "representative_name_invalid",
        "Bitte Vor- und Nachnamen ausschreiben (z. B. „Max Mustermann“).",
        "representatives",
      );
      break;
    }
  }
  if (c.legalForm === "ag" && reps.length > 1 && !reps.some((r) => r.role === "chair")) {
    block(
      "board_chair_missing",
      "Bei mehreren Vorstandsmitgliedern muss der Vorsitzende gekennzeichnet werden (§ 80 AktG).",
      "representatives",
    );
  }

  // Supervisory board (GmbH/UG optional, AG mandatory)
  if (f.supervisoryBoard && (c.legalForm === "ag" || c.hasSupervisoryBoard) && !c.supervisoryBoardChair?.trim()) {
    block(
      "supervisory_chair_missing",
      "Der Vorsitzende des Aufsichtsrats fehlt (Pflichtangabe auf Geschäftsbriefen).",
      "supervisoryBoardChair",
    );
  }

  // General partner (GmbH & Co. KG always; OHG/KG without a liable natural person)
  if (f.generalPartner || (f.generalPartnerIfNoNaturalPerson && c.noNaturalPersonLiable)) {
    const gp = c.generalPartner;
    const complete =
      gp?.name.trim() &&
      gp.seat.trim() &&
      gp.registerCourt.trim() &&
      gp.registerNumber.trim() &&
      gp.managingDirectors.some((m) => m.trim() !== "");
    if (!complete) {
      block(
        "general_partner_incomplete",
        "Angaben zur persönlich haftenden Gesellschafterin fehlen: Firma, Sitz, Registergericht, Registernummer und mindestens ein Geschäftsführer (§ 125a, § 177a HGB).",
        "generalPartnerName",
      );
    }
  }

  if (c.shareCapital?.outstandingCents !== undefined && c.shareCapital.outstandingCents > c.shareCapital.amountCents) {
    block("capital_invalid", "Ausstehende Einlagen können nicht höher als das Stammkapital sein.", "shareCapital");
  }

  if (c.legalForm === "other") {
    warn(
      "legal_form_unchecked",
      "Für diese Rechtsform prüft die Software die Pflichtangaben nicht automatisch.",
      "legalForm",
    );
  }
  return { blocking, warnings };
}
