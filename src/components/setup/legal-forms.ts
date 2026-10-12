/**
 * Which company fields the form SHOWS per legal form (F01 SET-011, §5.2) — presentation only.
 * The authoritative Geschäftsbrief matrix (blocking errors, warnings, name suffixes) is the pure domain function
 * `validateCompanyForDocuments` (F01 SET-012). TODO(domain): derive this table from src/domain once it exists.
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
}

const NONE: LegalFormFields = {
  seat: false,
  supervisoryBoard: false,
  generalPartner: false,
  hrRegistered: false,
  euerBlocked: false,
  euerNeedsConfirmation: false,
};

const partners = { label: "representativesPartners", required: false } as const;
const directors = { label: "representatives", required: true } as const;

export const LEGAL_FORM_FIELDS: Record<LegalForm, LegalFormFields> = {
  einzelunternehmen: NONE,
  freiberufler: NONE,
  ek: { ...NONE, register: "HRA", seat: true, hrRegistered: true, euerNeedsConfirmation: true },
  gbr: { ...NONE, representatives: partners },
  egbr: { ...NONE, register: "GsR", representatives: partners, seat: true },
  ohg: { ...NONE, register: "HRA", representatives: partners, seat: true, hrRegistered: true, euerBlocked: true },
  kg: { ...NONE, register: "HRA", representatives: partners, seat: true, hrRegistered: true, euerBlocked: true },
  gmbh_co_kg: { ...NONE, register: "HRA", seat: true, generalPartner: true, hrRegistered: true, euerBlocked: true },
  gmbh: {
    ...NONE,
    register: "HRB",
    representatives: directors,
    seat: true,
    supervisoryBoard: true,
    hrRegistered: true,
    euerBlocked: true,
  },
  ug: {
    ...NONE,
    register: "HRB",
    representatives: directors,
    seat: true,
    supervisoryBoard: true,
    hrRegistered: true,
    euerBlocked: true,
  },
  ag: {
    ...NONE,
    register: "HRB",
    representatives: { label: "representativesAg", required: true },
    seat: true,
    supervisoryBoard: true,
    hrRegistered: true,
    euerBlocked: true,
  },
  partg: { ...NONE, register: "PR", representatives: { label: "representativesPartg", required: false }, seat: true },
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
