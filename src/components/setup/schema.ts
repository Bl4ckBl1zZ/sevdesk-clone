/**
 * Form schemas for the setup wizard and the company settings pages (F01 §5).
 *
 * TODO(domain): F01 SET-143 requires these to live in `src/domain/schemas/settings.ts`, shared by UI, Convex,
 * REST and MCP. They are kept here until the domain agent owns that module; then import from there and delete
 * this file. Messages are the German texts of F01 §5 (shown verbatim). Checks that need rule logic
 * (VAT-ID check digit, Steuernummer per Bundesland, IBAN country rules beyond mod-97, KU history, Geschäftsbrief
 * matrix) are NOT done here — they belong to src/domain and run on save.
 */
import { electronicFormatIBAN, isValidBIC, isValidIBAN } from "ibantools";
import { z } from "zod";
import { EU_EEA } from "./countries";
import { fieldsFor, LEGAL_FORMS } from "./legal-forms";
import { checkFormat } from "./number-format";

const trimmed = () => z.string().trim();
const optionalText = (max: number, message?: string) => trimmed().max(max, message);

// ── Step 2: Adressen & Zugriff (SET-007, SET-046) ──────────────────────────────────────────────────────────
export const accessSchema = z
  .object({
    countryCode: trimmed().regex(/^[A-Z]{2}$/, "Bitte ein Land auswählen."),
    provider: trimmed().min(2, "Bitte Anbieter oder Ort des Servers angeben.").max(120),
    nonEuConfirmed: z.boolean(),
    tailnetName: optionalText(120),
    tailnetOnlyConfirmed: z
      .boolean()
      .refine((v) => v, "Bitte bestätigen, dass die Anwendung nur im Tailnet erreichbar ist."),
  })
  .superRefine((v, ctx) => {
    if (!(EU_EEA as readonly string[]).includes(v.countryCode) && !v.nonEuConfirmed) {
      ctx.addIssue({
        code: "custom",
        path: ["nonEuConfirmed"],
        message:
          "Ohne Genehmigung des Finanzamts dürfen Bücher nicht außerhalb der EU geführt werden (§ 146 Abs. 2b AO).",
      });
    }
  });
export type AccessValues = z.infer<typeof accessSchema>;

// ── Step 3: E-Mail-Versand (SET-009a) ────────────────────────────────────────────────────────────────────
export const emailStepSchema = z.object({
  notificationEmail: trimmed().max(254).pipe(z.email("Die E-Mail-Adresse ist ungültig.")),
});
export type EmailStepValues = z.infer<typeof emailStepSchema>;

// ── Step 6: Unternehmen (SET-011, SET-015, SET-016, §5.1) ────────────────────────────────────────────────
const NAME_TWO_WORDS = /^\S+\s+\S+/;
const ABBREVIATED_FIRST_NAME = /^\p{L}\.\s/u;

export const representativeSchema = z.object({
  name: trimmed()
    .max(100, "Bitte Vor- und Nachnamen ausschreiben (z. B. „Max Mustermann“).")
    .refine(
      (n) => NAME_TWO_WORDS.test(n) && !ABBREVIATED_FIRST_NAME.test(n),
      "Bitte Vor- und Nachnamen ausschreiben (z. B. „Max Mustermann“).",
    ),
});

const REGISTER_NUMBER: Record<string, RegExp> = {
  HRA: /^\d+(\s?[A-Z])?$/,
  HRB: /^\d+(\s?[A-Z])?$/,
  PR: /^\d+$/,
  GsR: /^\d+$/,
};

export const companySchema = z
  .object({
    legalForm: z.enum(LEGAL_FORMS, "Bitte eine Rechtsform wählen."),
    name: trimmed().min(2, "Bitte den Namen des Unternehmens angeben.").max(160, "Höchstens 160 Zeichen."),
    tradeName: optionalText(160),
    street: optionalText(100),
    poBox: optionalText(30),
    postalCode: trimmed(),
    city: trimmed().min(1, "Bitte den Ort angeben.").max(80),
    countryCode: trimmed().regex(/^[A-Z]{2}$/, "Bitte ein Land auswählen."),
    seat: optionalText(80),
    contactName: trimmed().min(2, "Bitte einen Ansprechpartner angeben (Pflicht für E-Rechnungen).").max(100),
    phone: trimmed().regex(/^[0-9 +/()-]{6,30}$/, "Die Telefonnummer ist ungültig."),
    email: trimmed().max(254).pipe(z.email("Die E-Mail-Adresse ist ungültig.")),
    website: trimmed().refine((v) => v === "" || /^https?:\/\/\S+\.\S+/.test(v), {
      message: "Bitte eine vollständige Adresse mit https:// angeben.",
    }),
    registerCourt: optionalText(80),
    registerNumber: optionalText(20),
    representatives: z.array(representativeSchema).max(20),
    hasSupervisoryBoard: z.boolean(),
    supervisoryBoardChair: optionalText(100),
    generalPartnerName: optionalText(160),
  })
  .superRefine((v, ctx) => {
    if (!v.street && !v.poBox) {
      ctx.addIssue({ code: "custom", path: ["street"], message: "Straße oder Postfach fehlt." });
    }
    const postalOk = v.countryCode === "DE" ? /^\d{5}$/.test(v.postalCode) : /^[A-Z0-9 -]{2,10}$/i.test(v.postalCode);
    if (!postalOk) ctx.addIssue({ code: "custom", path: ["postalCode"], message: "Die Postleitzahl ist ungültig." });
    const register = fieldsFor(v.legalForm).register;
    if (register && v.registerNumber) {
      const re = REGISTER_NUMBER[register];
      if (re && !re.test(v.registerNumber)) {
        ctx.addIssue({ code: "custom", path: ["registerNumber"], message: "Die Registernummer ist ungültig." });
      }
    }
  });
export type CompanyValues = z.infer<typeof companySchema>;

export const companyDefaults: CompanyValues = {
  legalForm: "einzelunternehmen",
  name: "",
  tradeName: "",
  street: "",
  poBox: "",
  postalCode: "",
  city: "",
  countryCode: "DE",
  seat: "",
  contactName: "",
  phone: "",
  email: "",
  website: "",
  registerCourt: "",
  registerNumber: "",
  representatives: [],
  hasSupervisoryBoard: false,
  supervisoryBoardChair: "",
  generalPartnerName: "",
};

// ── Step 7: Steuern (SET-030…043) ────────────────────────────────────────────────────────────────────────
export const USTVA_PERIODS = ["monthly", "quarterly", "annual_only"] as const;

export const taxSchema = z
  .object({
    /** Needed for the EÜR/fiscal-year rules; comes from the company step. */
    legalForm: z.enum(LEGAL_FORMS),
    taxNumberState: trimmed(),
    taxNumber: trimmed().refine((v) => v === "" || /^[0-9 /]{10,16}$/.test(v), {
      message: "Die Steuernummer passt nicht zum Format des gewählten Bundeslandes.",
    }),
    vatId: trimmed()
      .transform((v) => v.replace(/\s+/g, "").toUpperCase())
      .refine((v) => v === "" || /^DE\d{9}$/.test(v), {
        message: "Die USt-IdNr ist ungültig (Format DE + 9 Ziffern).",
      }),
    isKleinunternehmer: z.enum(["yes", "no"]),
    kuValidFrom: trimmed(),
    taxationMethod: z.enum(["soll", "ist"]),
    istConfirmed: z.boolean(),
    ustvaPeriod: z.enum(USTVA_PERIODS),
    dauerfrist: z.boolean(),
    profitMethod: z.enum(["euer", "bilanz"]),
    euerConfirmed: z.boolean(),
    chartOfAccounts: z.enum(["SKR03", "SKR04"]),
    fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
    foundedOn: trimmed(),
    /** Raw German amount; parsed to cents by src/domain/money (TODO) before saving. */
    priorYearTurnover: trimmed().refine(
      (v) => v === "" || /^\d{1,3}(\.?\d{3})*(,\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(v),
      {
        message: "Bitte einen Betrag wie 24.500,00 eingeben.",
      },
    ),
  })
  .superRefine((v, ctx) => {
    if (!v.taxNumber && !v.vatId) {
      ctx.addIssue({
        code: "custom",
        path: ["taxNumber"],
        message: "Steuernummer oder USt-IdNr fehlt (Pflichtangabe auf Rechnungen).",
      });
    }
    if (v.taxNumber && !v.taxNumberState && v.taxNumber.replace(/\D/g, "").length !== 13) {
      ctx.addIssue({ code: "custom", path: ["taxNumberState"], message: "Bitte das Bundesland wählen." });
    }
    if (v.isKleinunternehmer === "yes" && !v.kuValidFrom) {
      ctx.addIssue({ code: "custom", path: ["kuValidFrom"], message: "Bitte das Datum angeben." });
    }
    if (v.taxationMethod === "ist" && !v.istConfirmed) {
      ctx.addIssue({
        code: "custom",
        path: ["istConfirmed"],
        message: "Ist-Versteuerung nur mit Genehmigung des Finanzamts — bitte bestätigen.",
      });
    }
    const f = fieldsFor(v.legalForm);
    if (v.profitMethod === "euer" && f.euerBlocked) {
      ctx.addIssue({
        code: "custom",
        path: ["profitMethod"],
        message:
          "Für diese Rechtsform ist die Bilanzierung Pflicht; eine Einnahmenüberschussrechnung ist nicht zulässig.",
      });
    }
    if (v.profitMethod === "euer" && f.euerNeedsConfirmation && !v.euerConfirmed) {
      ctx.addIssue({
        code: "custom",
        path: ["euerConfirmed"],
        message:
          "Bitte bestätigen, dass die Befreiung nach § 241a HGB vorliegt (Umsatz ≤ 800.000 €, Gewinn ≤ 80.000 €).",
      });
    }
    if (v.fiscalYearStartMonth !== 1 && !(f.hrRegistered && v.profitMethod === "bilanz")) {
      ctx.addIssue({
        code: "custom",
        path: ["fiscalYearStartMonth"],
        message:
          "Ein abweichendes Wirtschaftsjahr ist nur für im Handelsregister eingetragene, bilanzierende Unternehmen möglich.",
      });
    }
  });
export type TaxFormValues = z.input<typeof taxSchema>;
export type TaxValues = z.output<typeof taxSchema>;

export const taxDefaults = (legalForm: CompanyValues["legalForm"]): TaxFormValues => ({
  legalForm,
  taxNumberState: "",
  taxNumber: "",
  vatId: "",
  isKleinunternehmer: "no",
  kuValidFrom: "",
  taxationMethod: "soll",
  istConfirmed: false,
  ustvaPeriod: "quarterly",
  dauerfrist: false,
  profitMethod: fieldsFor(legalForm).euerBlocked ? "bilanz" : "euer",
  euerConfirmed: false,
  // F01 SET-041: SKR03 is the default and preselected.
  chartOfAccounts: "SKR03",
  fiscalYearStartMonth: 1,
  foundedOn: "",
  priorYearTurnover: "",
});

// ── Step 8: Bank (SET-050…052, §5.4) ─────────────────────────────────────────────────────────────────────
export const bankSchema = z.object({
  iban: trimmed()
    .transform((v) => electronicFormatIBAN(v) ?? "")
    .refine((v) => isValidIBAN(v), "Die IBAN ist ungültig."),
  bic: trimmed()
    .transform((v) => v.replace(/\s+/g, "").toUpperCase())
    .refine((v) => v === "" || isValidBIC(v), "Die BIC ist ungültig."),
  accountHolder: trimmed()
    .min(1, "Kontoinhaber fehlt oder ist länger als 70 Zeichen.")
    .max(70, "Kontoinhaber fehlt oder ist länger als 70 Zeichen."),
  currency: z.literal("EUR"),
});
export type BankFormValues = z.input<typeof bankSchema>;
export type BankValues = z.output<typeof bankSchema>;

// ── Step 9: Layout (SET-071, SET-018) ────────────────────────────────────────────────────────────────────
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/svg+xml"] as const;
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

export const layoutSchema = z.object({
  template: z.enum(["classic", "modern", "minimal"]),
  accentColor: trimmed().regex(/^#[0-9a-fA-F]{6}$/, "Bitte eine Farbe im Format #RRGGBB angeben."),
});
export type LayoutValues = z.infer<typeof layoutSchema>;

export function validateLogo(file: File): string | null {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type) || file.size > LOGO_MAX_BYTES) {
    return "Logo muss PNG, JPG oder SVG sein, höchstens 2 MB, mindestens 300 px breit.";
  }
  return null;
}

// ── Step 10: Nummernkreise (SET-055…058) ─────────────────────────────────────────────────────────────────
export const numberRangeSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    format: trimmed().min(1, "Das Format muss genau einen Zähler wie {####} enthalten."),
    resetPolicy: z.enum(["never", "yearly", "monthly"]),
    next: z.coerce
      .number("Startwert muss zwischen 1 und 10.000.000.000 liegen.")
      .int("Startwert muss zwischen 1 und 10.000.000.000 liegen.")
      .min(1, "Startwert muss zwischen 1 und 10.000.000.000 liegen.")
      .max(10_000_000_000, "Startwert muss zwischen 1 und 10.000.000.000 liegen."),
  })
  .superRefine((r, ctx) => {
    const check = checkFormat(r.format, r.resetPolicy);
    if (!check.ok) ctx.addIssue({ code: "custom", path: ["format"], message: check.message ?? "" });
  });
export const numberRangesSchema = z.object({ ranges: z.array(numberRangeSchema) });
export type NumberRangesFormValues = z.input<typeof numberRangesSchema>;
export type NumberRangesValues = z.output<typeof numberRangesSchema>;
