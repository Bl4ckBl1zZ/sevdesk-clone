/**
 * Communication channels (F02 §3.3, §5.2; 03 §2 `contactChannels`): normalisation of e-mails, phone numbers and URLs,
 * one primary per type, any number of invoice e-mails (CON-030…033).
 */
import { type FieldIssue, fieldIssue, type Validation } from "./core";

export const CHANNEL_TYPES = ["email", "phone", "mobile", "fax", "web"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_TYPE_LABELS: Readonly<Record<ChannelType, string>> = {
  email: "E-Mail",
  phone: "Telefon",
  mobile: "Mobil",
  fax: "Fax",
  web: "Web",
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** CON-032: trim, lower-case domain (the local part stays as entered). */
export function normalizeEmail(value: string): string {
  const v = value.trim();
  const at = v.lastIndexOf("@");
  return at < 0 ? v : `${v.slice(0, at)}@${v.slice(at + 1).toLowerCase()}`;
}

export const isValidEmail = (value: string): boolean => value.length <= 254 && EMAIL.test(value);

/**
 * CON-032: E.164 form when parseable, default region DE. Handles +CC…, 00CC… and national numbers with a leading 0;
 * returns undefined for anything else (the raw value is kept and shown).
 */
export function toE164(raw: string, defaultCountryCallingCode = "49"): string | undefined {
  const cleaned = raw.trim().replace(/\(0\)/g, "");
  if (!/^[+\d][\d\s/().-]*$/.test(cleaned)) return undefined;
  const d = cleaned.replace(/\D/g, "");
  let international: string;
  if (cleaned.startsWith("+")) international = d;
  else if (d.startsWith("00")) international = d.slice(2);
  else if (d.startsWith("0")) international = `${defaultCountryCallingCode}${d.slice(1)}`;
  else return undefined;
  // E.164: country code + subscriber number, at most 15 digits, no leading zero.
  if (international.length < 7 || international.length > 15 || international.startsWith("0")) return undefined;
  return `+${international}`;
}

/** URL without scheme → `https://` prefixed (§5.2). */
export function normalizeUrl(value: string): string {
  const v = value.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
}

export interface ChannelInput {
  readonly type: ChannelType;
  readonly value: string;
  readonly label?: string | undefined;
  readonly isPrimary: boolean;
  readonly isInvoiceEmail: boolean;
}

export interface NormalizedChannel extends ChannelInput {
  /** E.164 for phone/mobile/fax when parseable (for `tel:` links and search). */
  readonly e164?: string | undefined;
}

/** Normalises one channel and validates it (§5.2). `existing` = the contact's other channels (duplicates). */
export function validateChannel(
  input: ChannelInput,
  existing: readonly { type: ChannelType; value: string }[] = [],
): Validation & { value?: NormalizedChannel } {
  const errors: FieldIssue[] = [];
  let value = input.value.trim();
  let e164: string | undefined;
  if (input.type === "email") {
    value = normalizeEmail(value);
    if (!isValidEmail(value)) {
      errors.push(fieldIssue("value", "EMAIL_INVALID", `Die E-Mail-Adresse „${input.value.trim()}“ ist ungültig.`));
    }
  } else if (input.type === "web") {
    value = normalizeUrl(value);
  } else {
    e164 = toE164(value);
  }
  if (value === "" || value === "https://") errors.push(fieldIssue("value", "REQUIRED", "Bitte einen Wert angeben."));
  if (value.length > 254) errors.push(fieldIssue("value", "TOO_LONG", "Der Text ist zu lang (max. 254 Zeichen)."));
  if ((input.label ?? "").trim().length > 40)
    errors.push(fieldIssue("label", "TOO_LONG", "Der Text ist zu lang (max. 40 Zeichen)."));
  if (input.isInvoiceEmail && input.type !== "email") {
    errors.push(
      fieldIssue(
        "isInvoiceEmail",
        "INVOICE_EMAIL_TYPE",
        "Nur E-Mail-Adressen können als Rechnungsempfänger markiert werden.",
      ),
    );
  }
  const key = (t: ChannelType, v: string) => `${t}|${t === "email" ? v.toLowerCase() : v.replace(/\s/g, "")}`;
  if (existing.some((c) => key(c.type, c.value) === key(input.type, value))) {
    errors.push(fieldIssue("value", "CHANNEL_DUPLICATE", "Dieser Eintrag ist bereits vorhanden."));
  }
  if (errors.length > 0) return { errors, warnings: [] };
  const label = input.label?.trim();
  return {
    errors,
    warnings: [],
    value: { ...input, value, ...(label ? { label } : { label: undefined }), ...(e164 ? { e164 } : {}) },
  };
}

/** The `tel:` target of a phone channel (E.164 when parseable, else the digits). */
export function telHref(value: string): string {
  return `tel:${toE164(value) ?? value.replace(/[^\d+]/g, "")}`;
}

export interface ChannelRow {
  readonly type: ChannelType;
  readonly value: string;
  readonly isInvoiceEmail: boolean;
  readonly isPrimary: boolean;
}

/**
 * CON-031: invoice recipients of the addressed contact; a person under an organisation without own invoice e-mail
 * inherits the organisation's invoice e-mails.
 */
export function invoiceRecipients(own: readonly ChannelRow[], parent: readonly ChannelRow[] | null): string[] {
  const pick = (rows: readonly ChannelRow[]) => rows.filter((c) => c.type === "email" && c.isInvoiceEmail);
  const mine = pick(own);
  const rows = mine.length > 0 || !parent ? mine : pick(parent);
  return rows.map((c) => c.value);
}

/** The primary channel of a type (or the first one). */
export function primaryOf(rows: readonly ChannelRow[], type: ChannelType): string | undefined {
  const ofType = rows.filter((c) => c.type === type);
  return (ofType.find((c) => c.isPrimary) ?? ofType[0])?.value;
}
