/**
 * Legal forms and the company fields each one needs (F01 SET-011, §5.2 Geschäftsbrief matrix, MAIL-03).
 * Shared by the company form (which fields to show and mark as mandatory) and the authoritative check
 * `validateCompanyForDocuments` (./validate.ts, SET-012).
 */
export const LEGAL_FORMS = [
  "einzelunternehmen",
  "freiberufler",
  "ek",
  "gbr",
  "egbr",
  "ohg",
  "kg",
  "gmbh_co_kg",
  "gmbh",
  "ug",
  "ag",
  "partg",
  "other",
] as const;

export type LegalForm = (typeof LEGAL_FORMS)[number];
export type RegisterType = "HRA" | "HRB" | "PR" | "GsR";
export type RepresentativeLabel =
  | "representatives"
  | "representativesAg"
  | "representativesPartners"
  | "representativesPartg";

export interface LegalFormFields {
  register?: RegisterType;
  representatives?: { label: RepresentativeLabel; required: boolean };
  seat: boolean;
  supervisoryBoard: boolean;
  generalPartner: boolean;
  /** Registered in the Handelsregister: an abweichendes Wirtschaftsjahr is possible with Bilanz (SET-042). */
  hrRegistered: boolean;
  /** EÜR not allowed (SET-039). */
  euerBlocked: boolean;
  /** EÜR only with the §241a HGB confirmation (SET-039). */
  euerNeedsConfirmation: boolean;
  /** OHG/KG: if no natural person is liable without limitation, the general partner's data are mandatory. */
  generalPartnerIfNoNaturalPerson: boolean;
  /**
   * Rechtsformzusatz the Firma must contain (§5.2 "Name must contain"): abbreviations are matched case-sensitively,
   * spelled-out forms case-insensitively. The first entry is quoted in the error message.
   */
  nameSuffix?: { abbreviations: readonly string[]; spelled: readonly string[] };
}

const NONE: LegalFormFields = {
  seat: false,
  supervisoryBoard: false,
  generalPartner: false,
  hrRegistered: false,
  euerBlocked: false,
  euerNeedsConfirmation: false,
  generalPartnerIfNoNaturalPerson: false,
};

const partners = { label: "representativesPartners", required: false } as const;
const directors = { label: "representatives", required: true } as const;

export const LEGAL_FORM_FIELDS: Record<LegalForm, LegalFormFields> = {
  einzelunternehmen: NONE,
  freiberufler: NONE,
  ek: {
    ...NONE,
    register: "HRA",
    seat: true,
    hrRegistered: true,
    euerNeedsConfirmation: true,
    nameSuffix: {
      abbreviations: ["e.K.", "e.Kfm.", "e.Kfr."],
      spelled: ["eingetragener Kaufmann", "eingetragene Kauffrau"],
    },
  },
  gbr: { ...NONE, representatives: partners },
  // LEGAL-OPEN: MAIL-03 (01-compliance open items) — eGbR register data treated as blocking (README A15).
  egbr: {
    ...NONE,
    register: "GsR",
    representatives: partners,
    seat: true,
    nameSuffix: { abbreviations: ["eGbR"], spelled: [] },
  },
  ohg: {
    ...NONE,
    register: "HRA",
    representatives: partners,
    seat: true,
    hrRegistered: true,
    euerBlocked: true,
    generalPartnerIfNoNaturalPerson: true,
    nameSuffix: { abbreviations: ["OHG"], spelled: ["offene Handelsgesellschaft"] },
  },
  kg: {
    ...NONE,
    register: "HRA",
    representatives: partners,
    seat: true,
    hrRegistered: true,
    euerBlocked: true,
    generalPartnerIfNoNaturalPerson: true,
    nameSuffix: { abbreviations: ["KG"], spelled: ["Kommanditgesellschaft"] },
  },
  gmbh_co_kg: {
    ...NONE,
    register: "HRA",
    seat: true,
    generalPartner: true,
    hrRegistered: true,
    euerBlocked: true,
    nameSuffix: { abbreviations: ["GmbH & Co. KG"], spelled: [] },
  },
  gmbh: {
    ...NONE,
    register: "HRB",
    representatives: directors,
    seat: true,
    supervisoryBoard: true,
    hrRegistered: true,
    euerBlocked: true,
    nameSuffix: { abbreviations: ["GmbH"], spelled: ["Gesellschaft mit beschränkter Haftung"] },
  },
  ug: {
    ...NONE,
    register: "HRB",
    representatives: directors,
    seat: true,
    supervisoryBoard: true,
    hrRegistered: true,
    euerBlocked: true,
    nameSuffix: {
      abbreviations: ["UG (haftungsbeschränkt)"],
      spelled: ["Unternehmergesellschaft (haftungsbeschränkt)"],
    },
  },
  ag: {
    ...NONE,
    register: "HRB",
    representatives: { label: "representativesAg", required: true },
    seat: true,
    supervisoryBoard: true,
    hrRegistered: true,
    euerBlocked: true,
    nameSuffix: { abbreviations: ["AG"], spelled: ["Aktiengesellschaft"] },
  },
  partg: {
    ...NONE,
    register: "PR",
    representatives: { label: "representativesPartg", required: false },
    seat: true,
    nameSuffix: { abbreviations: ["& Partner"], spelled: ["Partnerschaft", "und Partner"] },
  },
  other: NONE,
};

export function fieldsFor(legalForm: string | undefined): LegalFormFields {
  return LEGAL_FORM_FIELDS[(legalForm ?? "") as LegalForm] ?? NONE;
}

/** Footer items a legal form adds ("Pflichtangaben im Fußtext: + Registergericht, + HRB, …", SET-013). */
export function footerItems(legalForm: string | undefined): string[] {
  const f = fieldsFor(legalForm);
  const items: string[] = [];
  if (f.seat) items.push("Sitz");
  if (f.register) items.push("Registergericht", f.register);
  if (f.representatives?.required) {
    items.push(f.representatives.label === "representativesAg" ? "Vorstand" : "Geschäftsführer");
  }
  if (f.generalPartner) items.push("Komplementär");
  return items;
}

export function footerDelta(from: string | undefined, to: string | undefined): string[] {
  const before = new Set(footerItems(from));
  return footerItems(to).filter((i) => !before.has(i));
}
