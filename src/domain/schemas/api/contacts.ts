import { z } from "zod";
import type {} from "zod-openapi";
import { decodeId, encodeId, encodeOptionalId } from "../../api/ids";
import { snakeCase } from "../../api/problems";
import { ADDRESS_TYPES } from "../../contacts/address";
import { CHANNEL_TYPES } from "../../contacts/channels";
import { CONTACT_KINDS, CONTACT_LANGUAGES, CONTACT_ROLES, SALUTATIONS } from "../../contacts/core";
import { EINVOICE_FORMATS, ELECTRONIC_ADDRESS_SCHEMES } from "../../contacts/tax";
import { formatBasisPoints } from "../../money/format";
import { TAX_CASES } from "../../tax/tax-case";
import {
  type ChannelFormValues,
  type ContactCreateFormValues,
  type ContactFormValues,
  emptyAddress,
  emptyContactForm,
  type PostalAddressFormValues,
} from "../contacts";
import { instant, isoDate, listEnvelope, listQuery, prefixedId, toInstant, toOptionalInstant } from "./common";

/**
 * Contacts on the wire (05 §4.1, F02 §7.1): snake_case, prefixed IDs, integers for days and basis points. The wire
 * shape maps 1:1 onto the contact form values (src/domain/schemas/contacts.ts), so REST, MCP and the UI run the same
 * zod validation and domain rules (CLAUDE.md rule 5). Validation issues come back with form paths
 * (`contact.dueDays`) and are mapped to wire fields (`payment_terms.due_days`) by `contactFieldMapper`.
 */

const str = (max: number, description?: string) =>
  z
    .string()
    .max(max)
    .meta(description ? { description } : {});

export const addressWire = z
  .object({
    name: str(160).optional(),
    name2: str(160).optional(),
    department: str(80).optional(),
    street: str(100).optional(),
    street2: str(100).optional(),
    postal_code: str(10).optional(),
    city: str(80).optional(),
    country_code: z.string().length(2).meta({ description: "ISO 3166-1 alpha-2", example: "DE" }).optional(),
    po_box: str(30).optional(),
  })
  .meta({ id: "PostalAddressInput" });

export const channelWire = z
  .object({
    type: z.enum(CHANNEL_TYPES),
    value: str(320),
    label: str(40).optional(),
    is_primary: z.boolean().optional(),
    is_invoice_email: z.boolean().optional(),
  })
  .meta({ id: "ChannelInput" });

const paymentTermsWire = z.object({
  due_days: z.number().int().min(0).max(365).meta({ description: "Zahlungsziel in Tagen", example: 14 }),
  skonto_percent_bp: z.number().int().min(0).max(10_000).optional().meta({ description: "Skonto in Basispunkten" }),
  skonto_days: z.number().int().min(0).max(365).optional(),
  text: str(500).optional(),
});

/** Every writable contact field (PATCH: all optional; POST adds `kind` as required plus address/channels). */
const contactFieldsWire = {
  parent_id: prefixedId("contacts", "Übergeordnete Organisation (nur Personen)").nullable().optional(),
  organization_name: str(160).optional(),
  organization_name2: str(160).optional(),
  salutation: z.enum([...SALUTATIONS, ""]).optional(),
  academic_title: str(40).optional(),
  first_name: str(80).optional(),
  last_name: str(80).optional(),
  position: str(80).optional(),
  birthday: z.union([isoDate, z.literal("")]).optional(),
  number: str(40, "Leer = aus dem Nummernkreis vergeben").optional(),
  roles: z.array(z.enum(CONTACT_ROLES)).optional(),
  status: z.enum(["lead", "active"]).optional(),
  is_consumer: z.boolean().optional(),
  is_public_authority: z.boolean().optional(),
  vat_id: str(20).optional().meta({ example: "DE123456789" }),
  tax_number: str(30).optional(),
  default_tax_case: z.enum(["", ...TAX_CASES]).optional(),
  buyer_reference: str(200).optional(),
  electronic_address: z
    .object({ scheme: z.enum(ELECTRONIC_ADDRESS_SCHEMES), value: str(320) })
    .nullable()
    .optional()
    .meta({ description: "E-Rechnungs-Adresse (BT-49)" }),
  preferred_format: z.enum(EINVOICE_FORMATS).optional(),
  language: z.enum(CONTACT_LANGUAGES).optional(),
  currency: z.string().length(3).optional().meta({ example: "EUR" }),
  payment_terms: paymentTermsWire.nullable().optional(),
  default_discount_bp: z.number().int().min(0).max(10_000).nullable().optional(),
  payment_method_id: prefixedId("paymentMethods").nullable().optional(),
  iban: str(34).optional(),
  bic: str(11).optional(),
  debtor_account: str(10).optional(),
  creditor_account: str(10).optional(),
  use_collective_debtor: z.boolean().optional(),
  tags: z.array(prefixedId("tags")).optional(),
  custom_fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  notes: str(10_000).optional(),
};

export const contactPatchWire = z.object(contactFieldsWire).strict().meta({ id: "ContactPatch" });
export type ContactPatchWire = z.infer<typeof contactPatchWire>;

export const contactCreateWire = z
  .object({
    kind: z.enum(CONTACT_KINDS),
    ...contactFieldsWire,
    billing_address: addressWire.optional(),
    channels: z.array(channelWire).max(20).optional(),
  })
  .strict()
  .meta({ id: "ContactCreate" });
export type ContactCreateWire = z.infer<typeof contactCreateWire>;

export const CONTACT_MATCH_KEYS = ["email", "vat_id", "number"] as const;
export type ContactMatchKey = (typeof CONTACT_MATCH_KEYS)[number];

/** `?match=vat_id,email` → the keys in order; null on an unknown key. */
export function parseMatch(value: string | undefined): ContactMatchKey[] | null {
  if (value === undefined || value.trim() === "") return [];
  const keys = value.split(",").map((s) => s.trim());
  if (!keys.every((k): k is ContactMatchKey => (CONTACT_MATCH_KEYS as readonly string[]).includes(k))) return null;
  return [...new Set(keys)];
}

// ── wire → form ──────────────────────────────────────────────────────────────────────────────────────
const raw = (table: Parameters<typeof decodeId>[0], v: string | null | undefined) =>
  v ? (decodeId(table, v) ?? "") : "";
const bp = (v: number | null | undefined) => (v === null || v === undefined ? "" : formatBasisPoints(v));

/** The form fields a (partial) wire contact sets; keys absent on the wire stay absent. */
export function contactPatchToForm(w: ContactPatchWire): Partial<ContactFormValues> {
  const out: Partial<ContactFormValues> = {};
  const has = <K extends keyof ContactPatchWire>(k: K) => w[k] !== undefined;
  if (has("parent_id")) out.parentId = raw("contacts", w.parent_id);
  if (has("organization_name")) out.organizationName = w.organization_name ?? "";
  if (has("organization_name2")) out.organizationName2 = w.organization_name2 ?? "";
  if (w.salutation !== undefined) out.salutation = w.salutation;
  if (has("academic_title")) out.academicTitle = w.academic_title ?? "";
  if (has("first_name")) out.firstName = w.first_name ?? "";
  if (has("last_name")) out.lastName = w.last_name ?? "";
  if (has("position")) out.position = w.position ?? "";
  if (has("birthday")) out.birthday = w.birthday ?? "";
  if (has("number")) out.number = w.number ?? "";
  if (w.roles !== undefined) out.roles = w.roles;
  if (w.status !== undefined) out.status = w.status;
  if (w.is_consumer !== undefined) out.isConsumer = w.is_consumer;
  if (w.is_public_authority !== undefined) out.isPublicAuthority = w.is_public_authority;
  if (has("vat_id")) out.vatId = w.vat_id ?? "";
  if (has("tax_number")) out.taxNumber = w.tax_number ?? "";
  if (w.default_tax_case !== undefined) out.defaultTaxCase = w.default_tax_case;
  if (has("buyer_reference")) out.buyerReference = w.buyer_reference ?? "";
  if (has("electronic_address")) {
    out.electronicAddressScheme = w.electronic_address?.scheme ?? "";
    out.electronicAddressValue = w.electronic_address?.value ?? "";
  }
  if (w.preferred_format !== undefined) out.preferredFormat = w.preferred_format;
  if (w.language !== undefined) out.language = w.language;
  if (has("currency")) out.currency = w.currency ?? "";
  if (has("payment_terms")) {
    const t = w.payment_terms;
    out.dueDays = t ? String(t.due_days) : "";
    out.skontoPercent = bp(t?.skonto_percent_bp);
    out.skontoDays = t?.skonto_days !== undefined ? String(t.skonto_days) : "";
    out.paymentTermsText = t?.text ?? "";
  }
  if (has("default_discount_bp")) out.defaultDiscount = bp(w.default_discount_bp);
  if (has("payment_method_id")) out.paymentMethodId = raw("paymentMethods", w.payment_method_id);
  if (has("iban")) out.iban = w.iban ?? "";
  if (has("bic")) out.bic = w.bic ?? "";
  if (has("debtor_account")) out.debtorAccount = w.debtor_account ?? "";
  if (has("creditor_account")) out.creditorAccount = w.creditor_account ?? "";
  if (w.use_collective_debtor !== undefined) out.useCollectiveDebtor = w.use_collective_debtor;
  if (w.tags !== undefined) out.tags = w.tags.map((t) => raw("tags", t));
  if (w.custom_fields !== undefined) out.customFields = w.custom_fields;
  if (has("notes")) out.notes = w.notes ?? "";
  return out;
}

export function addressToForm(
  a: z.infer<typeof addressWire> | undefined,
  countryCode: string,
): PostalAddressFormValues {
  const base = emptyAddress(countryCode);
  if (!a) return base;
  return {
    name: a.name ?? base.name,
    name2: a.name2 ?? base.name2,
    department: a.department ?? base.department,
    street: a.street ?? base.street,
    street2: a.street2 ?? base.street2,
    postalCode: a.postal_code ?? base.postalCode,
    city: a.city ?? base.city,
    countryCode: a.country_code ?? base.countryCode,
    poBox: a.po_box ?? base.poBox,
  };
}

export function channelToForm(c: z.infer<typeof channelWire>): ChannelFormValues {
  return {
    type: c.type,
    value: c.value,
    label: c.label ?? "",
    isPrimary: c.is_primary ?? false,
    isInvoiceEmail: c.is_invoice_email ?? false,
  };
}

/** POST body → the create form of the UI (defaults of a new contact for every absent field). */
export function contactCreateToForm(
  w: ContactCreateWire,
  defaults: { language?: "de" | "en"; currency?: string } = {},
): ContactCreateFormValues {
  const { kind, billing_address, channels, ...rest } = w;
  const contact = { ...emptyContactForm(defaults), kind, ...contactPatchToForm(rest) };
  return {
    contact,
    billingAddress: addressToForm(billing_address, "DE"),
    channels: (channels ?? []).map(channelToForm),
  };
}

/** The values a `?match=` upsert looks up (first e-mail channel, VAT ID, number). */
export function matchValues(w: ContactCreateWire): Partial<Record<ContactMatchKey, string>> {
  const email = w.channels
    ?.find((c) => c.type === "email")
    ?.value.trim()
    .toLowerCase();
  const vatId = w.vat_id?.toUpperCase().replace(/[\s.-]/g, "");
  const number = w.number?.trim();
  return {
    ...(email ? { email } : {}),
    ...(vatId ? { vat_id: vatId } : {}),
    ...(number ? { number } : {}),
  };
}

// ── form paths → wire fields (problem+json `errors[].field`) ────────────────────────────────────────
const FORM_TO_WIRE: Readonly<Record<string, string>> = {
  dueDays: "payment_terms.due_days",
  skontoPercent: "payment_terms.skonto_percent_bp",
  skontoDays: "payment_terms.skonto_days",
  paymentTermsText: "payment_terms.text",
  defaultDiscount: "default_discount_bp",
  electronicAddressScheme: "electronic_address.scheme",
  electronicAddressValue: "electronic_address.value",
  billingAddress: "billing_address",
};

/** `contact.dueDays` → `payment_terms.due_days`; `channels.0.value` → `channels[0].value` (05 §3.1). */
export function contactFieldMapper(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(".").filter((p) => p !== "contact" && p !== "values");
  if (parts.length === 0) return undefined;
  return parts
    .map((p) => FORM_TO_WIRE[p] ?? (/^\d+$/.test(p) ? `[${p}]` : snakeCase(p)))
    .join(".")
    .replace(/\.\[/g, "[");
}

// ── record → wire ────────────────────────────────────────────────────────────────────────────────────
export const CONTACT_EXPANDS = ["addresses", "channels", "persons", "stats", "vat_status"] as const;

const addressOut = z
  .object({
    id: prefixedId("contactAddresses"),
    type: z.enum(ADDRESS_TYPES),
    is_default: z.boolean(),
    name: z.string().nullable(),
    name2: z.string().nullable(),
    department: z.string().nullable(),
    street: z.string().nullable(),
    street2: z.string().nullable(),
    postal_code: z.string().nullable(),
    city: z.string().nullable(),
    country_code: z.string(),
    po_box: z.string().nullable(),
  })
  .meta({ id: "ContactAddress" });

const channelOut = z
  .object({
    id: prefixedId("contactChannels"),
    type: z.enum(CHANNEL_TYPES),
    value: z.string(),
    label: z.string().nullable(),
    is_primary: z.boolean(),
    is_invoice_email: z.boolean(),
  })
  .meta({ id: "ContactChannel" });

const vatStatusOut = z
  .object({
    status: z.enum(["unchecked", "valid", "invalid", "unavailable"]),
    qualified: z.boolean(),
    checked_at: instant.nullable(),
    check_id: prefixedId("vatIdChecks").nullable(),
  })
  .meta({ id: "VatStatus" });

export const contactOut = z
  .object({
    id: prefixedId("contacts"),
    object: z.literal("contact"),
    number: z.string(),
    kind: z.enum(CONTACT_KINDS),
    display_name: z.string(),
    status: z.enum(["lead", "active", "archived"]),
    merged_into: prefixedId("contacts").nullable(),
    parent_id: prefixedId("contacts").nullable(),
    organization_name: z.string().nullable(),
    organization_name2: z.string().nullable(),
    salutation: z.string().nullable(),
    academic_title: z.string().nullable(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    position: z.string().nullable(),
    roles: z.array(z.enum(CONTACT_ROLES)),
    is_consumer: z.boolean(),
    is_public_authority: z.boolean(),
    vat_id: z.string().nullable(),
    tax_number: z.string().nullable(),
    default_tax_case: z.string().nullable(),
    buyer_reference: z.string().nullable(),
    electronic_address: z.object({ scheme: z.string(), value: z.string() }).nullable(),
    preferred_format: z.enum(EINVOICE_FORMATS),
    language: z.enum(CONTACT_LANGUAGES),
    currency: z.string(),
    payment_terms: z
      .object({
        due_days: z.number().int(),
        skonto_percent_bp: z.number().int().nullable(),
        skonto_days: z.number().int().nullable(),
        text: z.string().nullable(),
      })
      .nullable(),
    default_discount_bp: z.number().int().nullable(),
    payment_method_id: prefixedId("paymentMethods").nullable(),
    iban: z.string().nullable(),
    bic: z.string().nullable(),
    debtor_account: z.string().nullable(),
    creditor_account: z.string().nullable(),
    use_collective_debtor: z.boolean(),
    tags: z.array(prefixedId("tags")),
    custom_fields: z.record(z.string(), z.unknown()),
    notes: z.string().nullable(),
    version: z.number().int().meta({ description: "Für PATCH (`If-Match` oder Feld `version`)" }),
    created_at: instant,
    updated_at: instant,
    addresses: z.array(addressOut).optional(),
    channels: z.array(channelOut).optional(),
    persons: z.array(z.object({ id: prefixedId("contacts"), number: z.string(), display_name: z.string() })).optional(),
    stats: z.record(z.string(), z.unknown()).optional(),
    vat_status: vatStatusOut.optional(),
  })
  .meta({ id: "Contact" });
export type ContactOut = z.infer<typeof contactOut>;
export const contactList = listEnvelope(contactOut, "ContactList");

export const contactListQuery = listQuery.extend({
  q: z.string().max(200).optional().meta({ description: "Volltextsuche (Name, Nummer, Ort, E-Mail)" }),
  role: z.enum(CONTACT_ROLES).optional(),
  status: z.enum(["lead", "active", "archived", "all"]).optional().meta({ description: "Standard: nicht archiviert" }),
  vat_id: z.string().max(20).optional(),
  email: z.string().max(320).optional(),
  number: z.string().max(40).optional(),
  tag: prefixedId("tags").optional(),
  include_merged: z.enum(["true", "false"]).optional(),
});

/** The stored contact as returned by `contacts.apiGet`/`apiList` (structural subset of `Doc<"contacts">`). */
export interface ContactWireRecord {
  _id: string;
  _creationTime: number;
  kind: (typeof CONTACT_KINDS)[number];
  number: string;
  displayName: string;
  status: "lead" | "active" | "archived";
  mergedIntoId?: string | undefined;
  parentId?: string | undefined;
  organizationName?: string | undefined;
  organizationName2?: string | undefined;
  salutation?: string | undefined;
  academicTitle?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
  position?: string | undefined;
  roles: (typeof CONTACT_ROLES)[number][];
  isConsumer: boolean;
  isPublicAuthority: boolean;
  vatId?: string | undefined;
  vatIdStatus?: { lastCheckId: string; status: string; qualified: boolean; checkedAt: number } | undefined;
  taxNumber?: string | undefined;
  defaultTaxCase?: string | undefined;
  buyerReference?: string | undefined;
  electronicAddress?: { scheme: string; value: string } | undefined;
  einvoice: { preferredFormat: (typeof EINVOICE_FORMATS)[number] };
  language: (typeof CONTACT_LANGUAGES)[number];
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
  version: number;
  updatedAt?: number | undefined;
}

export interface ContactWireExtras {
  addresses?: {
    _id: string;
    type: (typeof ADDRESS_TYPES)[number];
    isDefault: boolean;
    address: {
      name?: string;
      name2?: string;
      department?: string;
      street?: string;
      street2?: string;
      postalCode?: string;
      city?: string;
      countryCode: string;
      poBox?: string;
    };
  }[];
  channels?: {
    _id: string;
    type: (typeof CHANNEL_TYPES)[number];
    value: string;
    label?: string;
    isPrimary: boolean;
    isInvoiceEmail: boolean;
  }[];
  persons?: { _id: string; number: string; displayName: string }[];
  stats?: Record<string, unknown>;
}

const n = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

export function serializeContact(c: ContactWireRecord, extras: ContactWireExtras = {}, expand = new Set<string>()) {
  const out: ContactOut = {
    id: encodeId("contacts", c._id),
    object: "contact",
    number: c.number,
    kind: c.kind,
    display_name: c.displayName,
    status: c.status,
    merged_into: encodeOptionalId("contacts", c.mergedIntoId),
    parent_id: encodeOptionalId("contacts", c.parentId),
    organization_name: n(c.organizationName),
    organization_name2: n(c.organizationName2),
    salutation: n(c.salutation),
    academic_title: n(c.academicTitle),
    first_name: n(c.firstName),
    last_name: n(c.lastName),
    position: n(c.position),
    roles: c.roles,
    is_consumer: c.isConsumer,
    is_public_authority: c.isPublicAuthority,
    vat_id: n(c.vatId),
    tax_number: n(c.taxNumber),
    default_tax_case: n(c.defaultTaxCase),
    buyer_reference: n(c.buyerReference),
    electronic_address: c.electronicAddress ?? null,
    preferred_format: c.einvoice.preferredFormat,
    language: c.language,
    currency: c.currency,
    payment_terms: c.paymentTerms
      ? {
          due_days: c.paymentTerms.dueDays,
          skonto_percent_bp: n(c.paymentTerms.skontoPercentBp),
          skonto_days: n(c.paymentTerms.skontoDays),
          text: n(c.paymentTerms.text),
        }
      : null,
    default_discount_bp: n(c.defaultDiscountBp),
    payment_method_id: encodeOptionalId("paymentMethods", c.paymentMethodId),
    iban: n(c.iban),
    bic: n(c.bic),
    debtor_account: n(c.debtorAccount),
    creditor_account: n(c.creditorAccount),
    use_collective_debtor: c.useCollectiveDebtor ?? false,
    tags: c.tags.map((t) => encodeId("tags", t)),
    custom_fields: c.customFields,
    notes: n(c.notes),
    version: c.version,
    created_at: toInstant(c._creationTime),
    updated_at: toInstant(c.updatedAt ?? c._creationTime),
  };
  if (expand.has("addresses") && extras.addresses) {
    out.addresses = extras.addresses.map((a) => ({
      id: encodeId("contactAddresses", a._id),
      type: a.type,
      is_default: a.isDefault,
      name: n(a.address.name),
      name2: n(a.address.name2),
      department: n(a.address.department),
      street: n(a.address.street),
      street2: n(a.address.street2),
      postal_code: n(a.address.postalCode),
      city: n(a.address.city),
      country_code: a.address.countryCode,
      po_box: n(a.address.poBox),
    }));
  }
  if (expand.has("channels") && extras.channels) {
    out.channels = extras.channels.map((ch) => ({
      id: encodeId("contactChannels", ch._id),
      type: ch.type,
      value: ch.value,
      label: n(ch.label),
      is_primary: ch.isPrimary,
      is_invoice_email: ch.isInvoiceEmail,
    }));
  }
  if (expand.has("persons") && extras.persons) {
    out.persons = extras.persons.map((p) => ({
      id: encodeId("contacts", p._id),
      number: p.number,
      display_name: p.displayName,
    }));
  }
  if (expand.has("stats")) out.stats = extras.stats ?? {};
  if (expand.has("vat_status")) {
    const s = c.vatIdStatus;
    out.vat_status = {
      status: (s?.status ?? "unchecked") as "unchecked" | "valid" | "invalid" | "unavailable",
      qualified: s?.qualified ?? false,
      checked_at: toOptionalInstant(s?.checkedAt),
      check_id: encodeOptionalId("vatIdChecks", s?.lastCheckId),
    };
  }
  return out;
}

/** Compact search row for MCP `contact_search` (F02 §7.2). */
export function contactSearchRow(c: ContactWireRecord, extra: { city?: string | null; email?: string | null } = {}) {
  return {
    id: encodeId("contacts", c._id),
    number: c.number,
    name: c.displayName,
    kind: c.kind,
    status: c.status,
    city: extra.city ?? null,
    email: extra.email ?? null,
    vat_id: c.vatId ?? null,
    vat_status: c.vatIdStatus?.status ?? (c.vatId ? "unchecked" : null),
  };
}

// ── merge (⚠ contact_merge, 06 §3.2) ──────────────────────────────────────────────────────────────────
export const contactMergeWire = z
  .object({
    winner_id: prefixedId("contacts", "Der Kontakt, der bleibt"),
    loser_ids: z.array(prefixedId("contacts")).min(1).max(10),
    field_choices: z
      .record(z.string(), prefixedId("contacts"))
      .optional()
      .meta({ description: "Feld → Kontakt, dessen Wert übernommen wird (Standard: der bleibende Kontakt)" }),
    confirm_vat_conflict: z.boolean().optional(),
  })
  .strict();
export type ContactMergeWire = z.infer<typeof contactMergeWire>;

export type ContactMergeArgs = {
  values: { winnerId: string; loserIds: string[]; fieldChoices: Record<string, string>; confirmVatConflict: boolean };
};

/**
 * Wire → the exact arguments of `contacts.merge` (without `confirmToken`). preview_action and contact_merge both use
 * this mapping, so the confirm token's params hash is computed over identical, fully defaulted arguments.
 */
export function contactMergeArgs(w: ContactMergeWire): ContactMergeArgs | null {
  const winnerId = decodeId("contacts", w.winner_id);
  const loserIds = w.loser_ids.map((id) => decodeId("contacts", id));
  const choices = Object.entries(w.field_choices ?? {}).map(([k, id]) => [k, decodeId("contacts", id)] as const);
  if (!winnerId || loserIds.some((x) => !x) || choices.some(([, x]) => !x)) return null;
  return {
    values: {
      winnerId,
      loserIds: loserIds as string[],
      fieldChoices: Object.fromEntries(choices) as Record<string, string>,
      confirmVatConflict: w.confirm_vat_conflict ?? false,
    },
  };
}
