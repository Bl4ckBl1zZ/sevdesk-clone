/**
 * Settings schemas (F01 SET-143): the single zod definition of every settings form, shared by the setup wizard,
 * the settings pages, the Convex mutations (re-validated server-side), REST and MCP. Messages are the German
 * texts of F01 §5 and are shown verbatim.
 *
 * The values are the *form* shapes (strings for amounts/dates, as typed by the user). The mapping to the stored
 * `companyProfile` lives in src/domain/settings (amounts via src/domain/money, Steuernummer normalised to ELSTER).
 */
import { electronicFormatIBAN, isValidBIC, isValidIBAN } from "ibantools";
import { z } from "zod";
import { fieldsFor, LEGAL_FORMS } from "../company/legal-forms";
import { validateDatevKeys } from "../datev/keys";
import { parseCents } from "../money/parse";
import { MAX_START_VALUE, MIN_START_VALUE, RESET_POLICIES, SEEDED_RANGES, validateFormat } from "../numbering/format";
import { isEuEeaCountry } from "../rules/eu-eea";
import { checkKuStart } from "../tax/kleinunternehmer";
import { isBundesland, normalizeTaxNumber } from "../tax/tax-number";
import { validateVatId } from "../tax/vat-id";
import { isCalendarDate } from "../time/calendar-date";

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
    if (!isEuEeaCountry(v.countryCode) && !v.nonEuConfirmed) {
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

/** §5.1 `representatives[i].name`: two words, first given name not abbreviated, ≤ 100 chars. */
export function isWrittenOutName(name: string): boolean {
  const n = name.trim();
  return n.length <= 100 && NAME_TWO_WORDS.test(n) && !ABBREVIATED_FIRST_NAME.test(n);
}

export const REPRESENTATIVE_NAME_MESSAGE = "Bitte Vor- und Nachnamen ausschreiben (z. B. „Max Mustermann“).";

export const representativeSchema = z.object({
  name: trimmed().max(100, REPRESENTATIVE_NAME_MESSAGE).refine(isWrittenOutName, REPRESENTATIVE_NAME_MESSAGE),
  /** AG: Vorstandsvorsitz (§ 80 AktG). */
  chair: z.boolean().optional(),
});

export const REGISTER_NUMBER: Readonly<Record<string, RegExp>> = {
  HRA: /^\d+(\s?[A-Z])?$/,
  HRB: /^\d+(\s?[A-Z])?$/,
  PR: /^\d+$/,
  GsR: /^\d+$/,
};

export function isValidPostalCode(countryCode: string, postalCode: string): boolean {
  return countryCode === "DE" ? /^\d{5}$/.test(postalCode) : /^[A-Z0-9 -]{2,10}$/i.test(postalCode);
}

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
    /** OHG/KG: no natural person is liable without limitation → general partner data are mandatory. */
    noNaturalPersonLiable: z.boolean(),
    generalPartnerName: optionalText(160),
    generalPartnerSeat: optionalText(80),
    generalPartnerRegisterCourt: optionalText(80),
    generalPartnerRegisterNumber: optionalText(20),
    /** Managing directors of the general partner, comma-separated. */
    generalPartnerManagingDirectors: optionalText(300),
  })
  .superRefine((v, ctx) => {
    if (!v.street && !v.poBox) {
      ctx.addIssue({ code: "custom", path: ["street"], message: "Straße oder Postfach fehlt." });
    }
    if (!isValidPostalCode(v.countryCode, v.postalCode)) {
      ctx.addIssue({ code: "custom", path: ["postalCode"], message: "Die Postleitzahl ist ungültig." });
    }
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
  noNaturalPersonLiable: false,
  generalPartnerName: "",
  generalPartnerSeat: "",
  generalPartnerRegisterCourt: "",
  generalPartnerRegisterNumber: "",
  generalPartnerManagingDirectors: "",
};

// ── Step 7: Steuern (SET-030…043) ────────────────────────────────────────────────────────────────────────
export const USTVA_PERIODS = ["monthly", "quarterly", "annual_only"] as const;

/** "24.500,00" → cents via src/domain/money (CLAUDE.md §4); "" → undefined. */
export function parseTurnoverCents(input: string): number | undefined | null {
  const v = input.trim();
  if (v === "") return undefined;
  const r = parseCents(v);
  return r.ok && r.value >= 0 ? r.value : null;
}

export const taxSchema = z
  .object({
    /** Needed for the EÜR/fiscal-year rules; comes from the company step. */
    legalForm: z.enum(LEGAL_FORMS),
    taxNumberState: trimmed(),
    taxNumber: trimmed(),
    vatId: trimmed().transform((v) => v.replace(/\s+/g, "").toUpperCase()),
    isKleinunternehmer: z.enum(["yes", "no"]),
    kuValidFrom: trimmed(),
    /** KU-04 / SET-033: date the waiver (§ 19 Abs. 2 UStG) was declared to the Finanzamt (§ 19 Abs. 3 UStG since 2025, before: Abs. 2); empty = no waiver. */
    kuWaiverDate: trimmed()
      .refine((v) => v === "" || isCalendarDate(v), "Bitte ein gültiges Datum angeben.")
      .default(""),
    taxationMethod: z.enum(["soll", "ist"]),
    istConfirmed: z.boolean(),
    ustvaPeriod: z.enum(USTVA_PERIODS),
    dauerfrist: z.boolean(),
    profitMethod: z.enum(["euer", "bilanz"]),
    euerConfirmed: z.boolean(),
    chartOfAccounts: z.enum(["SKR03", "SKR04"]),
    fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
    foundedOn: trimmed().refine((v) => v === "" || isCalendarDate(v), "Bitte ein gültiges Datum angeben."),
    /** Raw German amount; converted to `priorYearTotalTurnoverCents` with src/domain/money on save. */
    priorYearTurnover: trimmed().refine((v) => parseTurnoverCents(v) !== null, {
      message: "Bitte einen Betrag wie 24.500,00 eingeben.",
    }),
    /** SET-044: DATEV keys (digits; empty = not set yet) and the account length (4–9). */
    datevConsultantNumber: trimmed().regex(/^\d*$/, "Beraternummer: 1001 bis 9999999.").default(""),
    datevClientNumber: trimmed().regex(/^\d*$/, "Mandantennummer: 1 bis 99999.").default(""),
    datevAccountLength: z.coerce.number("Sachkontenlänge: 4 bis 9 Stellen.").default(4),
    /** SET-034: reason for a retroactive Kleinunternehmer entry that touches finalised documents. */
    kuReason: optionalText(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.taxNumber && !v.vatId) {
      ctx.addIssue({
        code: "custom",
        path: ["taxNumber"],
        message: "Steuernummer oder USt-IdNr fehlt (Pflichtangabe auf Rechnungen).",
      });
    }
    if (v.taxNumber) {
      const digits = v.taxNumber.replace(/\D/g, "");
      if (!v.taxNumberState && digits.length !== 13) {
        ctx.addIssue({ code: "custom", path: ["taxNumberState"], message: "Bitte das Bundesland wählen." });
      } else if (!normalizeTaxNumber(v.taxNumber, isBundesland(v.taxNumberState) ? v.taxNumberState : undefined).ok) {
        ctx.addIssue({
          code: "custom",
          path: ["taxNumber"],
          message: "Die Steuernummer passt nicht zum Format des gewählten Bundeslandes.",
        });
      }
    }
    if (v.vatId) {
      const r = validateVatId(v.vatId);
      if (!r.ok || r.value.countryCode !== "DE") {
        ctx.addIssue({
          code: "custom",
          path: ["vatId"],
          message:
            r.ok || r.error.code !== "vat_id_checksum"
              ? "Die USt-IdNr ist ungültig (Format DE + 9 Ziffern)."
              : "Die USt-IdNr ist ungültig (Prüfziffer stimmt nicht).",
        });
      }
    }
    if (v.isKleinunternehmer === "yes") {
      if (!v.kuValidFrom) {
        ctx.addIssue({ code: "custom", path: ["kuValidFrom"], message: "Bitte das Datum angeben." });
      } else {
        const turnover = parseTurnoverCents(v.priorYearTurnover);
        const check = checkKuStart({
          validFrom: v.kuValidFrom,
          ...(v.foundedOn ? { foundedOn: v.foundedOn } : {}),
          // The entered figure is the prior year of the current year; it applies to a KU start in the current year.
          ...(typeof turnover === "number" ? { priorYearTurnoverCents: turnover } : {}),
        });
        for (const e of check.errors) {
          ctx.addIssue({
            code: "custom",
            path: [e.code === "ku_prior_year_exceeded" ? "priorYearTurnover" : "kuValidFrom"],
            message: e.message,
          });
        }
      }
    }
    for (const e of validateDatevKeys(datevKeysFromForm(v))) {
      const path =
        e.code === "DATEV_CONSULTANT_INVALID"
          ? "datevConsultantNumber"
          : e.code === "DATEV_CLIENT_INVALID"
            ? "datevClientNumber"
            : "datevAccountLength";
      ctx.addIssue({ code: "custom", path: [path], message: e.message });
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
  kuWaiverDate: "",
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
  datevConsultantNumber: "",
  datevClientNumber: "",
  datevAccountLength: 4,
});

/** SET-044: the DATEV keys of the tax form as numbers. */
export function datevKeysFromForm(v: {
  datevConsultantNumber?: string;
  datevClientNumber?: string;
  datevAccountLength?: number;
}) {
  return {
    consultantNumber: v.datevConsultantNumber ? Number(v.datevConsultantNumber) : undefined,
    clientNumber: v.datevClientNumber ? Number(v.datevClientNumber) : undefined,
    accountLength: v.datevAccountLength ?? 4,
  };
}

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

/** SET-050: a further invoice account (same rules plus a display name). */
export const bankAccountSchema = bankSchema.extend({
  name: trimmed().min(1, "Bitte einen Namen angeben.").max(60, "Höchstens 60 Zeichen."),
});
export type BankAccountFormValues = z.input<typeof bankAccountSchema>;
export type BankValues = z.output<typeof bankSchema>;

// ── Step 9: Layout (SET-071, SET-018) ────────────────────────────────────────────────────────────────────
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/svg+xml"] as const;
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_INVALID_MESSAGE = "Logo muss PNG, JPG oder SVG sein, höchstens 2 MB, mindestens 300 px breit.";

export const layoutSchema = z.object({
  template: z.enum(["classic", "modern", "minimal"]),
  accentColor: trimmed().regex(/^#[0-9a-fA-F]{6}$/, "Bitte eine Farbe im Format #RRGGBB angeben."),
});
export type LayoutValues = z.infer<typeof layoutSchema>;

/** SET-070/074: a further layout. */
export const layoutCreateSchema = z.object({
  name: trimmed().min(1, "Bitte einen Namen angeben.").max(60, "Höchstens 60 Zeichen."),
});

/** SET-018 type and size (the ≥ 300 px width of raster images is checked where the image is decoded). */
export function validateLogoFile(file: { type: string; size: number }): string | null {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type) || file.size > LOGO_MAX_BYTES || file.size === 0) {
    return LOGO_INVALID_MESSAGE;
  }
  return null;
}

// ── Step 10: Nummernkreise (SET-055…059) ─────────────────────────────────────────────────────────────────
const START_VALUE_MESSAGE = "Startwert muss zwischen 1 und 10.000.000.000 liegen.";

export const numberRangeSchema = z
  .object({
    key: z.string().min(1),
    name: z.string(),
    format: trimmed().min(1, "Das Format muss genau einen Zähler wie {####} enthalten."),
    resetPolicy: z.enum(RESET_POLICIES),
    next: z.coerce
      .number(START_VALUE_MESSAGE)
      .int(START_VALUE_MESSAGE)
      .min(MIN_START_VALUE, START_VALUE_MESSAGE)
      .max(MAX_START_VALUE, START_VALUE_MESSAGE),
  })
  .superRefine((r, ctx) => {
    const check = validateFormat(r.format, r.resetPolicy);
    if (!check.ok) ctx.addIssue({ code: "custom", path: ["format"], message: check.error.message });
  });
export const numberRangesSchema = z.object({
  ranges: z.array(numberRangeSchema),
  /** SET-059: mandatory when a next value skips numbers that were already reachable (gap report). */
  reason: optionalText(500).optional(),
});
export type NumberRangesFormValues = z.input<typeof numberRangesSchema>;
export type NumberRangesValues = z.output<typeof numberRangesSchema>;

/** SET-055: an additional range (not the default) for one or more numbered document types. */
export const NUMBERED_DOC_TYPES = [...new Set(SEEDED_RANGES.flatMap((r) => r.docTypes))] as [string, ...string[]];

export const numberRangeCreateSchema = z
  .object({
    name: trimmed().min(1, "Bitte einen Namen angeben.").max(60, "Höchstens 60 Zeichen."),
    docTypes: z.array(z.enum(NUMBERED_DOC_TYPES)).min(1, "Bitte mindestens eine Dokumentart wählen."),
    format: trimmed().min(1, "Das Format muss genau einen Zähler wie {####} enthalten."),
    resetPolicy: z.enum(RESET_POLICIES),
    startValue: z.coerce
      .number(START_VALUE_MESSAGE)
      .int(START_VALUE_MESSAGE)
      .min(MIN_START_VALUE, START_VALUE_MESSAGE)
      .max(MAX_START_VALUE, START_VALUE_MESSAGE),
  })
  .superRefine((r, ctx) => {
    const check = validateFormat(r.format, r.resetPolicy);
    if (!check.ok) ctx.addIssue({ code: "custom", path: ["format"], message: check.error.message });
  });
export type NumberRangeCreateFormValues = z.input<typeof numberRangeCreateSchema>;
export type NumberRangeCreateValues = z.output<typeof numberRangeCreateSchema>;
