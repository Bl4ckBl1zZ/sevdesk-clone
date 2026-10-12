/**
 * Tax, e-invoice and payment fields of a contact (F02 §3.4, §3.7–3.9, §5.3–5.6): VAT ID rules on the contact
 * (CON-043/050, CON-E12), default tax case (CON-044), Leitweg-ID / buyer reference (CON-084, ER-20), electronic
 * address BT-49 (CON-083, ER-10), preferred format (CON-080), payment terms incl. the MAHN-04 warnings (CON-090/091),
 * discount (CON-092), IBAN/BIC (CON-093) and DATEV personal accounts (CON-100).
 */
import { isValidBIC } from "ibantools";
import { parseIban } from "../banking/iban";
import { personalAccountRanges } from "../datev/keys";
import { validateBuyerReference } from "../einvoice/buyer-reference";
import { validateLeitwegId } from "../einvoice/leitweg-id";
import { isEuVatPrefix } from "../rules/eu-vat-countries";
import type { TaxCase } from "../tax/tax-case";
import { validateVatId } from "../tax/vat-id";
import type { CalendarDate } from "../time/calendar-date";
import { isValidEmail } from "./channels";
import { type FieldIssue, fieldIssue, type Validation } from "./core";

export const EINVOICE_FORMATS = ["auto", "zugferd", "xrechnung_cii", "xrechnung_ubl", "pdf"] as const;
export type PreferredFormat = (typeof EINVOICE_FORMATS)[number];

export const EINVOICE_FORMAT_LABELS: Readonly<Record<PreferredFormat, string>> = {
  auto: "Automatisch",
  zugferd: "ZUGFeRD",
  xrechnung_cii: "XRechnung (CII)",
  xrechnung_ubl: "XRechnung (UBL)",
  pdf: "Nur PDF",
};

/**
 * CON-080: contact preference → `salesDocuments.einvoice.format`. `auto` is derived by the document (ER-03: XRechnung
 * UBL for B2G, ZUGFeRD otherwise); `pdf` maps to `none` only when ER-03 allows it (document check).
 */
export function documentFormatFor(
  pref: PreferredFormat,
  isPublicAuthority: boolean,
): "zugferd_en16931" | "xrechnung_cii" | "xrechnung_ubl" | "none" {
  switch (pref) {
    case "zugferd":
      return "zugferd_en16931";
    case "xrechnung_cii":
    case "xrechnung_ubl":
      return pref;
    case "pdf":
      return "none";
    default:
      return isPublicAuthority ? "xrechnung_ubl" : "zugferd_en16931";
  }
}

export const ELECTRONIC_ADDRESS_SCHEMES = ["EM", "0204", "9930"] as const;
export type ElectronicAddressScheme = (typeof ELECTRONIC_ADDRESS_SCHEMES)[number];

export interface ElectronicAddress {
  readonly scheme: ElectronicAddressScheme;
  readonly value: string;
}

// ── VAT ID on the contact ──────────────────────────────────────────────────────────────────────────────
export interface VatIdContext {
  /** Check date for EU membership (CON-E12). */
  readonly today: CalendarDate;
  /** The company's own USt-IdNr (VAT_ID_OWN). */
  readonly ownVatId?: string | undefined;
}

/**
 * CON-043/050: normalised EU VAT ID or a field error (`VAT_ID_FORMAT_INVALID`, `VAT_ID_CHECKSUM`, `VAT_ID_NOT_EU`,
 * `VAT_ID_OWN`). Greek `GR…` input is converted to `EL…` with a hint (§5.4).
 */
export function normalizeContactVatId(
  input: string,
  ctx?: VatIdContext,
): { vatId?: string; error?: FieldIssue; warning?: FieldIssue } {
  const raw = input.trim();
  if (raw === "") return {};
  const r = validateVatId(raw);
  if (!r.ok) return { error: fieldIssue("vatId", r.error.code.toUpperCase(), r.error.message, r.error.params) };
  const { vatId, countryCode } = r.value;
  if (ctx && !isEuVatPrefix(countryCode, ctx.today)) {
    return {
      error: fieldIssue(
        "vatId",
        "VAT_ID_NOT_EU",
        "Nur EU-USt-IdNrs können hier eingetragen werden. Ausländische Steuernummern bitte im Feld „Steuernummer“ erfassen.",
        { country: countryCode },
      ),
    };
  }
  if (ctx?.ownVatId && ctx.ownVatId.replace(/\s/g, "").toUpperCase() === vatId) {
    return { error: fieldIssue("vatId", "VAT_ID_OWN", "Das ist Ihre eigene USt-IdNr.") };
  }
  const warning =
    r.value.hint === "gr_converted_to_el"
      ? fieldIssue(
          "vatId",
          "VAT_ID_GR_CONVERTED",
          "Griechische USt-IdNrs beginnen mit EL; die Eingabe wurde umgestellt.",
        )
      : undefined;
  return warning ? { vatId, warning } : { vatId };
}

// ── combined tax / e-invoice / payment validation ─────────────────────────────────────────────────────
export interface TaxFields {
  readonly isConsumer: boolean;
  readonly isPublicAuthority: boolean;
  readonly vatId?: string | undefined;
  readonly taxNumber?: string | undefined;
  readonly defaultTaxCase?: TaxCase | undefined;
  readonly buyerReference?: string | undefined;
  readonly electronicAddress?: ElectronicAddress | undefined;
  readonly preferredFormat: PreferredFormat;
  /** Any PDF consent currently valid (CON-081) — for the `pdf` preference warning. */
  readonly hasValidPdfConsent?: boolean;
  readonly paymentTerms?: { dueDays: number; skontoPercentBp?: number; skontoDays?: number; text?: string };
  readonly defaultDiscountBp?: number | undefined;
  readonly iban?: string | undefined;
  readonly bic?: string | undefined;
  readonly debtorAccount?: string | undefined;
  readonly creditorAccount?: string | undefined;
}

export interface TaxContext extends Partial<VatIdContext> {
  /** DATEV `accountLength` (4–9) for the personal-account ranges (CON-100). */
  readonly accountLength?: number;
}

export interface NormalizedTaxFields {
  readonly vatId?: string | undefined;
  readonly buyerReference?: string | undefined;
  readonly iban?: string | undefined;
  readonly bic?: string | undefined;
}

const isForeignEuVatId = (vatId: string | undefined) => !!vatId && !vatId.startsWith("DE");

export function validateTaxFields(
  f: TaxFields,
  ctx: TaxContext = {},
): Validation & { normalized: NormalizedTaxFields } {
  const errors: FieldIssue[] = [];
  const warnings: FieldIssue[] = [];
  const normalized: { -readonly [K in keyof NormalizedTaxFields]: NormalizedTaxFields[K] } = {};

  // VAT ID (CON-043/050)
  const vat = normalizeContactVatId(
    f.vatId ?? "",
    ctx.today ? { today: ctx.today, ownVatId: ctx.ownVatId } : undefined,
  );
  if (vat.error) errors.push(vat.error);
  if (vat.warning) warnings.push(vat.warning);
  normalized.vatId = vat.vatId;
  if ((f.taxNumber ?? "").trim().length > 50) {
    errors.push(fieldIssue("taxNumber", "TOO_LONG", "Der Text ist zu lang (max. 50 Zeichen)."));
  }
  if (f.isConsumer && vat.vatId) {
    warnings.push(
      fieldIssue(
        "vatId",
        "CONSUMER_WITH_VAT_ID",
        "Privatkunden haben in der Regel keine USt-IdNr. Bitte prüfen, ob es sich um ein Unternehmen handelt.",
      ),
    );
  }

  // default tax case (§5.3)
  if (f.defaultTaxCase === "kleinunternehmer") {
    errors.push(
      fieldIssue(
        "defaultTaxCase",
        "TAX_CASE_NOT_ALLOWED",
        "Die Kleinunternehmerregelung ist eine Einstellung Ihres Unternehmens, nicht des Kunden.",
      ),
    );
  } else if (f.defaultTaxCase === "unknown_imported") {
    errors.push(
      fieldIssue("defaultTaxCase", "TAX_CASE_NOT_ALLOWED", "Dieser Steuerfall kann nicht als Standard gewählt werden."),
    );
  } else if (f.defaultTaxCase === "reverse_charge_13b" && f.isConsumer) {
    errors.push(
      fieldIssue("defaultTaxCase", "TAX_CASE_CONFLICT", "§ 13b gilt nur für unternehmerische Leistungsempfänger."),
    );
  } else if (
    (f.defaultTaxCase === "eu_b2b_service" || f.defaultTaxCase === "intra_community_supply") &&
    !isForeignEuVatId(vat.vatId)
  ) {
    warnings.push(
      fieldIssue(
        "defaultTaxCase",
        "TAX_CASE_NEEDS_VAT_ID",
        "Für diesen Steuerfall wird eine ausländische EU-USt-IdNr benötigt.",
      ),
    );
  }

  // buyer reference / Leitweg-ID (CON-041, CON-084, §5.5)
  const br = validateBuyerReference({ value: f.buyerReference, isPublicAuthority: f.isPublicAuthority });
  if (!br.ok) {
    const code =
      { leitweg_id_missing: "LEITWEG_ID_REQUIRED", leitweg_id_invalid: "LEITWEG_ID_FORMAT" }[br.error.code as string] ??
      br.error.code.toUpperCase();
    errors.push(fieldIssue("buyerReference", code, br.error.message));
  } else if (br.value !== null) {
    normalized.buyerReference = br.value;
  }

  // electronic address BT-49 (CON-083, §5.5)
  if (f.electronicAddress) {
    const e = checkElectronicAddress(f.electronicAddress);
    if (e) errors.push(e);
  }

  // preferred format (CON-080, §5.6)
  if (f.preferredFormat === "pdf" && f.isPublicAuthority) {
    errors.push(
      fieldIssue(
        "preferredFormat",
        "FORMAT_NOT_ALLOWED",
        "Öffentliche Auftraggeber erhalten Rechnungen als XRechnung.",
      ),
    );
  } else if (f.preferredFormat === "pdf" && !f.isConsumer && !f.hasValidPdfConsent) {
    warnings.push(
      fieldIssue(
        "preferredFormat",
        "PDF_WITHOUT_CONSENT",
        "Ohne Zustimmung dürfen Rechnungen an Unternehmen nicht als reines PDF versendet werden (ab 2027/2028 E-Rechnungspflicht).",
      ),
    );
  }

  // payment terms (CON-090/091, §5.3)
  if (f.paymentTerms) {
    const { dueDays, skontoPercentBp, skontoDays } = f.paymentTerms;
    if (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365) {
      errors.push(fieldIssue("dueDays", "OUT_OF_RANGE", "Zahlungsziel muss zwischen 0 und 365 Tagen liegen."));
    } else {
      warnings.push(...paymentTermWarnings(dueDays, f));
    }
    if (skontoPercentBp !== undefined && (skontoPercentBp < 1 || skontoPercentBp > 1000)) {
      errors.push(fieldIssue("skontoPercent", "OUT_OF_RANGE", "Skonto muss zwischen 0,01 % und 10 % liegen."));
    }
    if (skontoDays !== undefined && skontoDays >= dueDays) {
      errors.push(fieldIssue("skontoDays", "SKONTO_INVALID", "Die Skontofrist muss kürzer als das Zahlungsziel sein."));
    }
    if ((skontoPercentBp === undefined) !== (skontoDays === undefined)) {
      errors.push(
        fieldIssue(
          skontoDays === undefined ? "skontoDays" : "skontoPercent",
          "SKONTO_INCOMPLETE",
          "Für Skonto bitte Prozentsatz und Frist angeben.",
        ),
      );
    }
    if ((f.paymentTerms.text ?? "").length > 500) {
      errors.push(fieldIssue("paymentTermsText", "TOO_LONG", "Der Text ist zu lang (max. 500 Zeichen)."));
    }
  }

  // discount (CON-092)
  if (f.defaultDiscountBp !== undefined) {
    if (f.defaultDiscountBp < 0 || f.defaultDiscountBp > 10000) {
      errors.push(fieldIssue("defaultDiscount", "OUT_OF_RANGE", "Rabatt kann höchstens 100 % betragen."));
    } else if (f.defaultDiscountBp > 5000) {
      warnings.push(fieldIssue("defaultDiscount", "DISCOUNT_HIGH", "Der Rabatt liegt über 50 %."));
    }
  }

  // IBAN / BIC (CON-093)
  if ((f.iban ?? "").trim()) {
    const iban = parseIban(f.iban ?? "");
    if (iban.ok) normalized.iban = iban.value.iban;
    else errors.push(fieldIssue("iban", "IBAN_INVALID", "Die IBAN ist ungültig."));
  }
  if ((f.bic ?? "").trim()) {
    const bic = (f.bic ?? "").replace(/\s/g, "").toUpperCase();
    if (isValidBIC(bic)) normalized.bic = bic;
    else errors.push(fieldIssue("bic", "BIC_INVALID", "Die BIC ist ungültig."));
  }

  // DATEV personal accounts (CON-100)
  if (ctx.accountLength !== undefined) {
    const r = personalAccountRanges(ctx.accountLength);
    const check = (field: "debtorAccount" | "creditorAccount", range: { from: number; to: number }) => {
      const value = (f[field] ?? "").trim();
      if (!value) return;
      const n = Number(value);
      if (!/^\d+$/.test(value) || n < range.from || n > range.to) {
        errors.push(
          fieldIssue(
            field,
            field === "debtorAccount" ? "DEBTOR_ACCOUNT_RANGE" : "CREDITOR_ACCOUNT_RANGE",
            `${field === "debtorAccount" ? "Debitorenkonten" : "Kreditorenkonten"} liegen zwischen ${range.from} und ${range.to}.`,
            { min: range.from, max: range.to },
          ),
        );
      }
    };
    check("debtorAccount", r.debtors);
    check("creditorAccount", r.creditors);
  }
  return { errors, warnings, normalized };
}

/** MAHN-04 (CON-091): > 30 days for public authorities, > 60 days for businesses. */
export function paymentTermWarnings(
  dueDays: number,
  f: { isConsumer: boolean; isPublicAuthority: boolean },
): FieldIssue[] {
  if (f.isPublicAuthority && dueDays > 30) {
    return [
      fieldIssue(
        "dueDays",
        "DUE_DAYS_PUBLIC_AUTHORITY",
        "Öffentliche Auftraggeber dürfen höchstens 30 Tage Zahlungsziel vereinbaren (§ 271a Abs. 2 BGB).",
      ),
    ];
  }
  if (!f.isConsumer && !f.isPublicAuthority && dueDays > 60) {
    return [
      fieldIssue(
        "dueDays",
        "DUE_DAYS_B2B",
        "Zahlungsziele über 60 Tage sind im B2B-Verkehr nur eingeschränkt zulässig (§ 271a BGB).",
      ),
    ];
  }
  return [];
}

/** §5.5 electronic address rules per scheme. */
export function checkElectronicAddress(e: ElectronicAddress): FieldIssue | null {
  const value = e.value.trim();
  const invalid = (message: string) => fieldIssue("electronicAddressValue", "ELECTRONIC_ADDRESS_INVALID", message);
  if (e.scheme === "0204" && !validateLeitwegId(value).ok) {
    return invalid("Für das Schema 0204 muss eine gültige Leitweg-ID angegeben werden.");
  }
  if (e.scheme === "EM" && !isValidEmail(value)) {
    return invalid("Die elektronische Adresse muss eine gültige E-Mail-Adresse sein.");
  }
  if (e.scheme === "9930") {
    const r = validateVatId(value);
    if (!r.ok || r.value.countryCode !== "DE")
      return invalid("Für das Schema 9930 wird eine deutsche USt-IdNr erwartet.");
  }
  return null;
}

/**
 * CON-083 (T-CON-041): BT-49 default — B2G: scheme 0204 with the Leitweg-ID; otherwise EM with the first invoice
 * e-mail. An explicitly stored address wins. Undefined = missing (warning on the contact, blocking for XRechnung).
 */
export function effectiveElectronicAddress(c: {
  electronicAddress?: ElectronicAddress | undefined;
  isPublicAuthority: boolean;
  buyerReference?: string | undefined;
  invoiceEmails: readonly string[];
}): ElectronicAddress | undefined {
  if (c.electronicAddress) return c.electronicAddress;
  if (c.isPublicAuthority) {
    const lw = validateLeitwegId(c.buyerReference);
    return lw.ok ? { scheme: "0204", value: lw.value } : undefined;
  }
  const email = c.invoiceEmails[0];
  return email ? { scheme: "EM", value: email } : undefined;
}

/** CON-101: next free personal account = max used + 1 within the range; null when the range is exhausted. */
export function nextFreeAccount(used: readonly string[], range: { from: number; to: number }): string | null {
  let max = range.from - 1;
  for (const u of used) {
    const n = Number(u);
    if (Number.isInteger(n) && n >= range.from && n <= range.to && n > max) max = n;
  }
  return max + 1 <= range.to ? String(max + 1) : null;
}

export const datevAccountTaken = (account: string, contact: string): FieldIssue =>
  fieldIssue(
    "debtorAccount",
    "DATEV_ACCOUNT_TAKEN",
    `Das Personenkonto ${account} ist bereits ${contact} zugeordnet.`,
    {
      account,
      contact,
    },
  );
