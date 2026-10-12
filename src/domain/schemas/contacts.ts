/**
 * Contact schemas (F02 §5): one zod definition per form/request shape, shared by the contact UI, the Convex mutations
 * (re-validated server-side), the CSV import (CON-142 "same zod schema") and later REST/MCP. Input values are the
 * form shapes (strings as typed); the output is parsed (integers for days, basis points for percentages). Rules that
 * need context (today, the company's own VAT ID, DATEV ranges, existing numbers, the parent) run in the Convex model
 * with the same domain functions.
 */
import { z } from "zod";
import { ADDRESS_TYPES, validateAddress } from "../contacts/address";
import { CHANNEL_TYPES, validateChannel } from "../contacts/channels";
import { CONSENT_SOURCES, validateConsent } from "../contacts/consent";
import {
  CONTACT_KINDS,
  CONTACT_LANGUAGES,
  CONTACT_ROLES,
  type FieldIssue,
  SALUTATIONS,
  validateCoreFields,
} from "../contacts/core";
import { EINVOICE_FORMATS, ELECTRONIC_ADDRESS_SCHEMES, validateTaxFields } from "../contacts/tax";
import { formatBasisPoints } from "../money/format";
import { parseBasisPoints } from "../money/parse";
import { type SelectableTaxCase, TAX_CASES } from "../tax/tax-case";
import { calendarDate, isCalendarDate } from "../time/calendar-date";

const trimmed = () => z.string().trim();
const text = (max: number) => trimmed().max(max, `Der Text ist zu lang (max. ${max} Zeichen).`);

function addIssues(ctx: z.RefinementCtx, issues: readonly FieldIssue[], prefix: (string | number)[] = []) {
  for (const i of issues)
    ctx.addIssue({
      code: "custom",
      path: [...prefix, ...(i.field ? [i.field] : [])],
      message: i.message,
      params: { code: i.code },
    });
}

/** "2,5" → 250 bp; "" → undefined; invalid → NaN (caught by the refinement). */
export function percentToBp(value: string): number | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  const r = parseBasisPoints(v);
  return r.ok ? r.value : Number.NaN;
}

const intOrUndefined = (value: string): number | undefined => {
  const v = value.trim();
  if (v === "") return undefined;
  return /^\d+$/.test(v) ? Number(v) : Number.NaN;
};

// ── address (CON-020…025) ──────────────────────────────────────────────────────────────────────────────
export const addressFields = {
  name: text(160),
  name2: text(160),
  department: text(80),
  street: text(100),
  street2: text(100),
  postalCode: text(10),
  city: text(80),
  countryCode: trimmed().toUpperCase(),
  poBox: text(30),
};

export const postalAddressSchema = z.object(addressFields).superRefine((a, ctx) => {
  addIssues(ctx, validateAddress(a).errors);
});
export type PostalAddressFormValues = z.input<typeof postalAddressSchema>;

export const addressSchema = z
  .object({ type: z.enum(ADDRESS_TYPES), isDefault: z.boolean(), ...addressFields })
  .superRefine((a, ctx) => addIssues(ctx, validateAddress(a).errors));
export type AddressFormValues = z.input<typeof addressSchema>;
export type AddressValues = z.output<typeof addressSchema>;

export const emptyAddress = (countryCode = "DE"): PostalAddressFormValues => ({
  name: "",
  name2: "",
  department: "",
  street: "",
  street2: "",
  postalCode: "",
  city: "",
  countryCode,
  poBox: "",
});

/** True when the inline billing address of the create form was left empty. */
export const isBlankAddress = (a: { street: string; postalCode: string; city: string; poBox?: string }) =>
  !a.street.trim() && !a.postalCode.trim() && !a.city.trim() && !(a.poBox ?? "").trim();

// ── channel (CON-030…033) ──────────────────────────────────────────────────────────────────────────────
export const channelSchema = z
  .object({
    type: z.enum(CHANNEL_TYPES),
    value: trimmed().min(1, "Bitte einen Wert angeben."),
    label: text(40),
    isPrimary: z.boolean(),
    isInvoiceEmail: z.boolean(),
  })
  .superRefine((c, ctx) => addIssues(ctx, validateChannel(c).errors));
export type ChannelFormValues = z.input<typeof channelSchema>;
export type ChannelValues = z.output<typeof channelSchema>;

// ── core contact (CON-001…112, §5.1/5.3/5.5) ───────────────────────────────────────────────────────────
const contactObject = z.object({
  kind: z.enum(CONTACT_KINDS),
  parentId: trimmed(),
  organizationName: trimmed(),
  organizationName2: trimmed(),
  salutation: z.enum([...SALUTATIONS, ""]),
  academicTitle: trimmed(),
  firstName: trimmed(),
  lastName: trimmed(),
  position: trimmed(),
  birthday: trimmed().refine((v) => v === "" || isCalendarDate(v), "Ungültiges Datum."),
  /** Empty = assign from the number range (CON-003). */
  number: trimmed(),
  roles: z.array(z.enum(CONTACT_ROLES)),
  status: z.enum(["lead", "active"]),
  isConsumer: z.boolean(),
  isPublicAuthority: z.boolean(),
  vatId: trimmed(),
  taxNumber: trimmed(),
  defaultTaxCase: z.enum(["", ...TAX_CASES]),
  buyerReference: trimmed(),
  electronicAddressScheme: z.enum([...ELECTRONIC_ADDRESS_SCHEMES, ""]),
  electronicAddressValue: trimmed(),
  preferredFormat: z.enum(EINVOICE_FORMATS),
  language: z.enum(CONTACT_LANGUAGES),
  currency: trimmed().toUpperCase(),
  /** "" = company default (CON-090). */
  dueDays: trimmed(),
  skontoPercent: trimmed(),
  skontoDays: trimmed(),
  paymentTermsText: trimmed(),
  defaultDiscount: trimmed(),
  paymentMethodId: trimmed(),
  iban: trimmed(),
  bic: trimmed(),
  debtorAccount: trimmed(),
  creditorAccount: trimmed(),
  useCollectiveDebtor: z.boolean(),
  tags: z.array(z.string()),
  customFields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  notes: text(10_000),
});

type ContactObject = z.output<typeof contactObject>;

/** Parsed contact input (output of the schema). */
export interface ContactInput {
  kind: ContactObject["kind"];
  parentId?: string;
  organizationName?: string;
  organizationName2?: string;
  salutation?: (typeof SALUTATIONS)[number];
  academicTitle?: string;
  firstName?: string;
  lastName?: string;
  position?: string;
  birthday?: string;
  number?: string;
  roles: ContactObject["roles"];
  status: ContactObject["status"];
  isConsumer: boolean;
  isPublicAuthority: boolean;
  vatId?: string;
  taxNumber?: string;
  defaultTaxCase?: SelectableTaxCase | "unknown_imported";
  buyerReference?: string;
  electronicAddress?: { scheme: (typeof ELECTRONIC_ADDRESS_SCHEMES)[number]; value: string };
  preferredFormat: ContactObject["preferredFormat"];
  language: ContactObject["language"];
  currency: string;
  paymentTerms?: { dueDays: number; skontoPercentBp?: number; skontoDays?: number; text?: string };
  defaultDiscountBp?: number;
  paymentMethodId?: string;
  iban?: string;
  bic?: string;
  debtorAccount?: string;
  creditorAccount?: string;
  useCollectiveDebtor: boolean;
  tags: string[];
  customFields: Record<string, string | number | boolean>;
  notes?: string;
}

const opt = <T>(v: T | "" | undefined): T | undefined => (v === "" || v === undefined ? undefined : v);

/** Form values → parsed input (no validation; the refinement runs first). */
export function toContactInput(v: ContactObject): ContactInput {
  const isOrg = v.kind === "organization";
  const dueDays = intOrUndefined(v.dueDays);
  const skontoPercentBp = percentToBp(v.skontoPercent);
  const skontoDays = intOrUndefined(v.skontoDays);
  const out: ContactInput = {
    kind: v.kind,
    roles: [...new Set(v.roles)],
    status: v.status,
    isConsumer: v.isConsumer,
    isPublicAuthority: v.isPublicAuthority,
    preferredFormat: v.preferredFormat,
    language: v.language,
    currency: v.currency,
    useCollectiveDebtor: v.useCollectiveDebtor,
    tags: [...new Set(v.tags)],
    customFields: v.customFields,
  };
  const set = <K extends keyof ContactInput>(k: K, value: ContactInput[K] | "" | undefined) => {
    const x = opt(value);
    if (x !== undefined) out[k] = x as ContactInput[K];
  };
  set("parentId", isOrg ? "" : v.parentId);
  set("organizationName", isOrg ? v.organizationName : "");
  set("organizationName2", isOrg ? v.organizationName2 : "");
  set("salutation", isOrg ? "" : (v.salutation as ContactInput["salutation"] | ""));
  set("academicTitle", isOrg ? "" : v.academicTitle);
  set("firstName", isOrg ? "" : v.firstName);
  set("lastName", isOrg ? "" : v.lastName);
  set("position", isOrg ? "" : v.position);
  set("birthday", isOrg ? "" : v.birthday);
  set("number", v.number);
  set("vatId", v.vatId.toUpperCase().replace(/[\s.-]/g, ""));
  set("taxNumber", v.taxNumber);
  set("defaultTaxCase", v.defaultTaxCase as ContactInput["defaultTaxCase"] | "");
  set("buyerReference", v.buyerReference);
  if (v.electronicAddressScheme && v.electronicAddressValue) {
    out.electronicAddress = { scheme: v.electronicAddressScheme, value: v.electronicAddressValue };
  }
  if (dueDays !== undefined) {
    out.paymentTerms = {
      dueDays,
      ...(skontoPercentBp !== undefined ? { skontoPercentBp } : {}),
      ...(skontoDays !== undefined ? { skontoDays } : {}),
      ...(v.paymentTermsText ? { text: v.paymentTermsText } : {}),
    };
  }
  set("defaultDiscountBp", percentToBp(v.defaultDiscount));
  set("paymentMethodId", v.paymentMethodId);
  set("iban", v.iban);
  set("bic", v.bic);
  set("debtorAccount", v.debtorAccount);
  set("creditorAccount", v.creditorAccount);
  set("notes", v.notes);
  return out;
}

/** Context-free validation of the whole contact (§5.1, §5.3, §5.5) with the domain functions. */
export function refineContact(v: ContactObject, ctx: z.RefinementCtx, prefix: (string | number)[] = []): void {
  const input = toContactInput(v);
  addIssues(ctx, validateCoreFields({ ...input, number: v.number, roles: v.roles }).errors, prefix);
  if (v.dueDays === "" && (v.skontoPercent !== "" || v.skontoDays !== "")) {
    ctx.addIssue({
      code: "custom",
      path: [...prefix, "dueDays"],
      message: "Für Skonto bitte ein Zahlungsziel angeben.",
    });
  }
  if (Number.isNaN(input.paymentTerms?.skontoPercentBp)) {
    ctx.addIssue({
      code: "custom",
      path: [...prefix, "skontoPercent"],
      message: "Skonto muss zwischen 0,01 % und 10 % liegen.",
    });
  }
  if (Number.isNaN(input.paymentTerms?.skontoDays)) {
    ctx.addIssue({
      code: "custom",
      path: [...prefix, "skontoDays"],
      message: "Die Skontofrist muss kürzer als das Zahlungsziel sein.",
    });
  }
  if (Number.isNaN(input.defaultDiscountBp)) {
    ctx.addIssue({
      code: "custom",
      path: [...prefix, "defaultDiscount"],
      message: "Rabatt kann höchstens 100 % betragen.",
    });
  }
  if (v.electronicAddressScheme !== "" && v.electronicAddressValue === "") {
    ctx.addIssue({
      code: "custom",
      path: [...prefix, "electronicAddressValue"],
      message: "Bitte die elektronische Adresse angeben.",
    });
  }
  // Without context: VAT ID format only, no DATEV ranges; the consent check runs on the server.
  addIssues(ctx, validateTaxFields({ ...input, hasValidPdfConsent: true }).errors, prefix);
}

export const contactSchema = contactObject.superRefine((v, ctx) => refineContact(v, ctx)).transform(toContactInput);
export type ContactFormValues = z.input<typeof contactSchema>;

/** Create form: core + inline billing address + channels (F02 §6.4). */
export const contactCreateSchema = z
  .object({
    contact: contactObject,
    billingAddress: z.object(addressFields),
    channels: z.array(
      z.object({
        type: z.enum(CHANNEL_TYPES),
        value: trimmed(),
        label: text(40),
        isPrimary: z.boolean(),
        isInvoiceEmail: z.boolean(),
      }),
    ),
  })
  .superRefine((v, ctx) => {
    refineContact(v.contact, ctx, ["contact"]);
    if (!isBlankAddress(v.billingAddress)) addIssues(ctx, validateAddress(v.billingAddress).errors, ["billingAddress"]);
    v.channels.forEach((c, i) => {
      if (c.value === "") return;
      const others = v.channels.slice(0, i).filter((o) => o.value !== "");
      addIssues(ctx, validateChannel(c, others).errors, ["channels", i]);
    });
  })
  .transform((v) => ({
    contact: toContactInput(v.contact),
    billingAddress: isBlankAddress(v.billingAddress) ? undefined : v.billingAddress,
    channels: v.channels.filter((c) => c.value !== ""),
  }));
export type ContactCreateFormValues = z.input<typeof contactCreateSchema>;
export type ContactCreateValues = z.output<typeof contactCreateSchema>;

export const emptyContactForm = (defaults: { language?: "de" | "en"; currency?: string } = {}): ContactFormValues => ({
  kind: "organization",
  parentId: "",
  organizationName: "",
  organizationName2: "",
  salutation: "",
  academicTitle: "",
  firstName: "",
  lastName: "",
  position: "",
  birthday: "",
  number: "",
  roles: ["customer"],
  status: "active",
  isConsumer: false,
  isPublicAuthority: false,
  vatId: "",
  taxNumber: "",
  defaultTaxCase: "",
  buyerReference: "",
  electronicAddressScheme: "",
  electronicAddressValue: "",
  preferredFormat: "auto",
  language: defaults.language ?? "de",
  currency: defaults.currency ?? "EUR",
  dueDays: "",
  skontoPercent: "",
  skontoDays: "",
  paymentTermsText: "",
  defaultDiscount: "",
  paymentMethodId: "",
  iban: "",
  bic: "",
  debtorAccount: "",
  creditorAccount: "",
  useCollectiveDebtor: false,
  tags: [],
  customFields: {},
  notes: "",
});

/** The stored contact fields the edit form needs (structural: Convex `Doc<"contacts">` satisfies it). */
export interface ContactRecord {
  kind: ContactFormValues["kind"];
  parentId?: string | undefined;
  organizationName?: string | undefined;
  organizationName2?: string | undefined;
  salutation?: (typeof SALUTATIONS)[number] | undefined;
  academicTitle?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
  position?: string | undefined;
  birthday?: string | undefined;
  number: string;
  roles: ContactFormValues["roles"];
  status: "lead" | "active" | "archived";
  isConsumer: boolean;
  isPublicAuthority: boolean;
  vatId?: string | undefined;
  taxNumber?: string | undefined;
  defaultTaxCase?: string | undefined;
  buyerReference?: string | undefined;
  electronicAddress?: { scheme: (typeof ELECTRONIC_ADDRESS_SCHEMES)[number]; value: string } | undefined;
  einvoice: { preferredFormat: ContactFormValues["preferredFormat"] };
  language: ContactFormValues["language"];
  currency: string;
  paymentTerms?: { dueDays: number; skontoPercentBp?: number; skontoDays?: number; text?: string } | undefined;
  defaultDiscountBp?: number | undefined;
  paymentMethodId?: string | undefined;
  iban?: string | undefined;
  bic?: string | undefined;
  debtorAccount?: string | undefined;
  creditorAccount?: string | undefined;
  useCollectiveDebtor?: boolean | undefined;
  tags: string[];
  customFields: Record<string, unknown>;
  notes?: string | undefined;
}

/** Form values of a stored contact (the Stammdaten tab, REST PATCH and MCP upsert edit these). */
export function contactFormFromRecord(c: ContactRecord): ContactFormValues {
  const s = (v: string | undefined) => v ?? "";
  const pct = (bp: number | undefined) => (bp === undefined ? "" : formatBasisPoints(bp));
  return {
    ...emptyContactForm(),
    kind: c.kind,
    parentId: s(c.parentId),
    organizationName: s(c.organizationName),
    organizationName2: s(c.organizationName2),
    salutation: c.salutation ?? "",
    academicTitle: s(c.academicTitle),
    firstName: s(c.firstName),
    lastName: s(c.lastName),
    position: s(c.position),
    birthday: s(c.birthday),
    number: c.number,
    roles: c.roles,
    status: c.status === "lead" ? "lead" : "active",
    isConsumer: c.isConsumer,
    isPublicAuthority: c.isPublicAuthority,
    vatId: s(c.vatId),
    taxNumber: s(c.taxNumber),
    defaultTaxCase: (c.defaultTaxCase ?? "") as ContactFormValues["defaultTaxCase"],
    buyerReference: s(c.buyerReference),
    electronicAddressScheme: c.electronicAddress?.scheme ?? "",
    electronicAddressValue: s(c.electronicAddress?.value),
    preferredFormat: c.einvoice.preferredFormat,
    language: c.language,
    currency: c.currency,
    dueDays: c.paymentTerms ? String(c.paymentTerms.dueDays) : "",
    skontoPercent: pct(c.paymentTerms?.skontoPercentBp),
    skontoDays: c.paymentTerms?.skontoDays !== undefined ? String(c.paymentTerms.skontoDays) : "",
    paymentTermsText: s(c.paymentTerms?.text),
    defaultDiscount: pct(c.defaultDiscountBp),
    paymentMethodId: s(c.paymentMethodId),
    iban: s(c.iban),
    bic: s(c.bic),
    debtorAccount: s(c.debtorAccount),
    creditorAccount: s(c.creditorAccount),
    useCollectiveDebtor: c.useCollectiveDebtor ?? false,
    tags: c.tags,
    customFields: c.customFields as ContactFormValues["customFields"],
    notes: s(c.notes),
  };
}

// ── consent, certificate, activities, merge ───────────────────────────────────────────────────────────
export const pdfConsentSchema = z
  .object({
    givenAt: trimmed().refine(isCalendarDate, "Ungültiges Datum."),
    source: z.enum(CONSENT_SOURCES),
    note: text(1000),
  })
  // The future-date check needs `today` and runs on the server (validateConsent with the Berlin date).
  .superRefine((c, ctx) => addIssues(ctx, validateConsent(c, calendarDate("9999-12-31")).errors));
export type PdfConsentFormValues = z.input<typeof pdfConsentSchema>;

export const certificateSchema = z.object({
  validUntil: trimmed().refine(isCalendarDate, "Ungültiges Datum."),
});

export const ACTIVITY_KINDS = ["note", "call", "meeting", "task"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_KIND_LABELS: Readonly<Record<ActivityKind, string>> = {
  note: "Notiz",
  call: "Anruf",
  meeting: "Termin",
  task: "Aufgabe",
};

export const activitySchema = z
  .object({
    kind: z.enum(ACTIVITY_KINDS),
    text: trimmed().min(1, "Bitte einen Text eingeben.").max(10_000, "Der Text ist zu lang (max. 10.000 Zeichen)."),
    /** Tasks: due date "YYYY-MM-DD" (CON-122). */
    dueOn: trimmed(),
  })
  .superRefine((a, ctx) => {
    if (a.kind === "task" && !isCalendarDate(a.dueOn)) {
      ctx.addIssue({ code: "custom", path: ["dueOn"], message: "Bitte ein Fälligkeitsdatum angeben." });
    }
  });
export type ActivityFormValues = z.input<typeof activitySchema>;

export const mergeSchema = z.object({
  winnerId: trimmed().min(1),
  loserIds: z.array(z.string()).min(1, "Bitte mindestens einen Kontakt zum Zusammenführen wählen."),
  fieldChoices: z.record(z.string(), z.string()),
  confirmVatConflict: z.boolean(),
});
export type MergeValues = z.output<typeof mergeSchema>;
