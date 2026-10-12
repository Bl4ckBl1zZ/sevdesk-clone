import { type AddressType, nextDefaultAfterRemoval, validateAddress } from "../../src/domain/contacts/address";
import { type ChannelType, validateChannel } from "../../src/domain/contacts/channels";
import { revocationTarget, validateCertificate, validateConsent } from "../../src/domain/contacts/consent";
import {
  buildSearchText,
  checkKindChange,
  checkParent,
  contactNumberTaken,
  displayName,
  type FieldIssue,
  normalizeContactNumber,
  validateCoreFields,
} from "../../src/domain/contacts/core";
import {
  type DuplicateCandidate,
  findDuplicateHints,
  findDuplicatePairs,
  pairKey,
} from "../../src/domain/contacts/duplicates";
import {
  checkUndo,
  type FieldChoices,
  MERGE_FIELDS,
  type MergeContact,
  type MergeField,
  mergedValues,
  validateMerge,
} from "../../src/domain/contacts/merge";
import {
  datevAccountTaken,
  nextFreeAccount,
  paymentTermWarnings,
  validateTaxFields,
} from "../../src/domain/contacts/tax";
import { personalAccountRanges } from "../../src/domain/datev/keys";
import { validateCustomFieldValue } from "../../src/domain/lookups/custom-fields";
import type {
  ActivityFormValues,
  AddressValues,
  ChannelValues,
  ContactCreateValues,
  ContactInput,
  PdfConsentFormValues,
} from "../../src/domain/schemas/contacts";
import { berlinCalendarDate, berlinEndOfDay } from "../../src/domain/time/berlin";
import { type CalendarDate, calendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedDelete, auditedInsert, auditedPatch } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import { assignCounterNumber } from "./numberRanges";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Contacts (F02, 03 §2). The only writer of `contacts`, `contactAddresses`, `contactChannels`, `contactActivities`,
 * `dismissedDuplicates` and `contactMerges`. Every write is audited; personal fields are encrypted in the diffs by
 * the audit writer (PERSONAL_FIELDS, F02 §5.12). Validation runs the same domain functions as the zod schemas, plus
 * the rules that need context: today (Berlin), the company's own USt-IdNr, DATEV ranges, existing numbers/accounts,
 * the parent organisation, tags and custom-field definitions.
 */

export type ContactDoc = Doc<"contacts">;

// ── errors ────────────────────────────────────────────────────────────────────────────────────────────
export function fail(issue: FieldIssue): never {
  throw appError("invalid_input", issue.message, {
    reason: issue.code,
    ...(issue.field ? { field: issue.field } : {}),
  });
}

function versionConflict(): never {
  throw appError("version_conflict", "Der Kontakt wurde zwischenzeitlich geändert. Bitte neu laden.", {
    reason: "VERSION_CONFLICT",
  });
}

// ── company context ───────────────────────────────────────────────────────────────────────────────────
export interface CompanyContext {
  today: CalendarDate;
  ownVatId?: string;
  accountLength: number;
  kleinunternehmer: boolean;
  language: "de" | "en";
  collectiveDebtorAccount?: string;
}

export async function companyContext(ctx: ReadCtx, now: number): Promise<CompanyContext> {
  const profile = await getCompanyProfile(ctx);
  const today = berlinCalendarDate(now);
  const ku = [...(profile?.kleinunternehmer ?? [])]
    .filter((k) => k.validFrom <= today)
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom))
    .at(-1);
  return {
    today,
    ...(profile?.vatId ? { ownVatId: profile.vatId } : {}),
    accountLength: profile?.datev.accountLength ?? 5,
    kleinunternehmer: ku?.isKU ?? false,
    language: profile?.defaults.language ?? "de",
    ...(profile?.datev.collectiveDebtorAccount
      ? { collectiveDebtorAccount: profile.datev.collectiveDebtorAccount }
      : {}),
  };
}

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────────
export async function getContact(ctx: ReadCtx, id: Id<"contacts">): Promise<ContactDoc> {
  const c = await ctx.db.get(id);
  if (!c) throw appError("not_found", "Kontakt nicht gefunden.");
  return c;
}

export async function contactAddresses(ctx: ReadCtx, contactId: Id<"contacts">) {
  return ctx.db
    .query("contactAddresses")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
}

export async function contactChannels(ctx: ReadCtx, contactId: Id<"contacts">) {
  return ctx.db
    .query("contactChannels")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
}

export async function contactActivities(ctx: ReadCtx, contactId: Id<"contacts">) {
  return ctx.db
    .query("contactActivities")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .collect();
}

export async function childPersons(ctx: ReadCtx, contactId: Id<"contacts">) {
  return ctx.db
    .query("contacts")
    .withIndex("by_parent", (q) => q.eq("parentId", contactId))
    .collect();
}

export const defaultAddressOf = (rows: readonly Doc<"contactAddresses">[], type: AddressType) =>
  rows.find((a) => a.type === type && a.isDefault && a.archivedAt === undefined);

/** CON-133: follows `mergedIntoId` to the final winner. */
export async function resolveContactAlias(ctx: ReadCtx, id: Id<"contacts">): Promise<ContactDoc> {
  let c = await getContact(ctx, id);
  for (let i = 0; i < 10 && c.mergedIntoId; i++) c = await getContact(ctx, c.mergedIntoId);
  return c;
}

// ── denormalised search text (CON-172) ──────────────────────────────────────────────────────────────────
async function computeSearchText(
  ctx: ReadCtx,
  c: Pick<ContactDoc, "displayName" | "organizationName2" | "number" | "vatId" | "tags">,
  contactId?: Id<"contacts">,
): Promise<string> {
  const channels = contactId ? await contactChannels(ctx, contactId) : [];
  const addresses = contactId ? await contactAddresses(ctx, contactId) : [];
  const billing = defaultAddressOf(addresses, "billing");
  const tagNames: string[] = [];
  for (const t of c.tags) {
    const tag = await ctx.db.get(t);
    if (tag) tagNames.push(tag.name);
  }
  return buildSearchText({
    displayName: c.displayName,
    organizationName2: c.organizationName2,
    number: c.number,
    emails: channels.filter((ch) => ch.type === "email").map((ch) => ch.value),
    phones: channels
      .filter((ch) => ch.type === "phone" || ch.type === "mobile" || ch.type === "fax")
      .map((ch) => ch.e164 ?? ch.value),
    vatId: c.vatId,
    city: billing?.address.city,
    tags: tagNames,
  });
}

/** Recomputes `searchText` after a channel/address/tag change (audited with the caller's action). */
export async function refreshSearchText(ctx: ModelCtx, contactId: Id<"contacts">, action: string): Promise<void> {
  const c = await getContact(ctx, contactId);
  const searchText = await computeSearchText(ctx, c, contactId);
  if (searchText !== c.searchText) {
    await auditedPatch(ctx, "contacts", contactId, { searchText }, { action, label: c.number });
  }
}

// ── validation with context ───────────────────────────────────────────────────────────────────────────
async function numberTaken(ctx: ReadCtx, number: string, self?: Id<"contacts">): Promise<boolean> {
  const hit = await ctx.db
    .query("contacts")
    .withIndex("by_number", (q) => q.eq("numberNormalized", normalizeContactNumber(number)))
    .first();
  return hit !== null && hit._id !== self;
}

async function assertAccountFree(
  ctx: ReadCtx,
  field: "debtorAccount" | "creditorAccount",
  account: string | undefined,
  self?: Id<"contacts">,
) {
  if (!account) return;
  const index = field === "debtorAccount" ? "by_debtorAccount" : "by_creditorAccount";
  const hit = await ctx.db
    .query("contacts")
    .withIndex(index, (q) => q.eq(field, account))
    .first();
  if (hit && hit._id !== self) fail({ ...datevAccountTaken(account, hit.displayName), field });
}

async function assertCustomFields(ctx: ReadCtx, entity: "contact" | "product", values: Record<string, unknown>) {
  const defs = (await ctx.db.query("customFieldDefs").collect()).filter((d) => d.entity === entity && !d.archivedAt);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const [key, value] of Object.entries(values)) {
    const def = byKey.get(key);
    if (!def)
      fail({ code: "CUSTOM_FIELD_UNKNOWN", message: `Unbekanntes Feld „${key}“.`, field: `customFields.${key}` });
    const r = validateCustomFieldValue(def, value);
    if (!r.ok) fail({ code: r.error.code, message: r.error.message, field: `customFields.${key}` });
  }
  for (const def of defs) {
    if (def.required && (values[def.key] === undefined || values[def.key] === "")) {
      fail({
        code: "CUSTOM_FIELD_VALUE_INVALID",
        message: `„${def.label}“: ungültiger Wert.`,
        field: `customFields.${def.key}`,
      });
    }
  }
}

export { assertCustomFields };

async function assertTags(ctx: ReadCtx, tags: readonly string[]): Promise<Id<"tags">[]> {
  const out: Id<"tags">[] = [];
  for (const t of tags) {
    const id = ctx.db.normalizeId("tags", t);
    if (!id || !(await ctx.db.get(id))) fail({ code: "TAG_UNKNOWN", message: "Unbekanntes Tag.", field: "tags" });
    out.push(id);
  }
  return out;
}

export { assertTags };

interface Validated {
  fields: Omit<
    ContactDoc,
    | "_id"
    | "_creationTime"
    | "number"
    | "numberNormalized"
    | "searchText"
    | "version"
    | "reverseCharge13bCertificates"
    | "einvoice"
    | "status"
    | "vatIdStatus"
    | "mergedIntoId"
    | "dsgvo"
  >;
  preferredFormat: ContactDoc["einvoice"]["preferredFormat"];
  warnings: FieldIssue[];
}

/** Context rules on top of the schema (§5.1, §5.3–§5.6); returns the fields to store and the warnings. */
async function validateWithContext(
  ctx: ReadCtx,
  input: ContactInput,
  cc: CompanyContext,
  existing?: ContactDoc,
): Promise<Validated> {
  const core = validateCoreFields({ ...input, roles: input.roles }, cc.today);
  if (core.errors[0]) fail(core.errors[0]);
  let parentId: Id<"contacts"> | undefined;
  if (input.kind === "person" && input.parentId) {
    parentId = ctx.db.normalizeId("contacts", input.parentId) ?? undefined;
    const parent = parentId ? await ctx.db.get(parentId) : null;
    const issue = checkParent(
      existing?._id,
      parent ? { id: parent._id, kind: parent.kind, status: parent.status, mergedIntoId: parent.mergedIntoId } : null,
    );
    if (issue) fail(issue);
  }
  if (existing) {
    const kindIssue = checkKindChange(existing.kind, input.kind, (await childPersons(ctx, existing._id)).length);
    if (kindIssue) fail(kindIssue);
  }
  const consents = existing?.einvoice.pdfConsents ?? [];
  const tax = validateTaxFields(
    {
      ...input,
      defaultTaxCase: input.defaultTaxCase,
      hasValidPdfConsent: consents.some((c) => !c.revokedAt),
    },
    { today: cc.today, ownVatId: cc.ownVatId, accountLength: cc.accountLength },
  );
  if (tax.errors[0]) fail(tax.errors[0]);
  await assertAccountFree(ctx, "debtorAccount", input.debtorAccount, existing?._id);
  await assertAccountFree(ctx, "creditorAccount", input.creditorAccount, existing?._id);
  let paymentMethodId: Id<"paymentMethods"> | undefined;
  if (input.paymentMethodId) {
    paymentMethodId = ctx.db.normalizeId("paymentMethods", input.paymentMethodId) ?? undefined;
    if (!paymentMethodId || !(await ctx.db.get(paymentMethodId))) {
      fail({ code: "PAYMENT_METHOD_UNKNOWN", message: "Unbekannte Zahlungsart.", field: "paymentMethodId" });
    }
  }
  const tags = await assertTags(ctx, input.tags);
  await assertCustomFields(ctx, "contact", input.customFields);
  const warnings = [
    ...core.warnings,
    ...tax.warnings,
    ...(input.paymentTerms ? paymentTermWarnings(input.paymentTerms.dueDays, input) : []),
  ];
  const n = tax.normalized;
  const name = displayName(input);
  return {
    fields: {
      kind: input.kind,
      ...(parentId ? { parentId } : {}),
      roles: input.roles,
      ...(input.organizationName ? { organizationName: input.organizationName } : {}),
      ...(input.organizationName2 ? { organizationName2: input.organizationName2 } : {}),
      ...(input.salutation ? { salutation: input.salutation } : {}),
      ...(input.academicTitle ? { academicTitle: input.academicTitle } : {}),
      ...(input.firstName ? { firstName: input.firstName } : {}),
      ...(input.lastName ? { lastName: input.lastName } : {}),
      ...(input.position ? { position: input.position } : {}),
      ...(input.birthday ? { birthday: input.birthday } : {}),
      displayName: name,
      isConsumer: input.isConsumer,
      isPublicAuthority: input.isPublicAuthority,
      ...(n.vatId ? { vatId: n.vatId } : {}),
      ...(input.taxNumber ? { taxNumber: input.taxNumber } : {}),
      ...((n.buyerReference ?? input.buyerReference)
        ? { buyerReference: n.buyerReference ?? input.buyerReference }
        : {}),
      ...(input.electronicAddress ? { electronicAddress: input.electronicAddress } : {}),
      ...(input.defaultTaxCase ? { defaultTaxCase: input.defaultTaxCase } : {}),
      language: input.language,
      currency: input.currency,
      ...(input.paymentTerms ? { paymentTerms: input.paymentTerms } : {}),
      ...(input.defaultDiscountBp !== undefined ? { defaultDiscountBp: input.defaultDiscountBp } : {}),
      ...(paymentMethodId ? { paymentMethodId } : {}),
      ...(input.debtorAccount ? { debtorAccount: input.debtorAccount } : {}),
      ...(input.creditorAccount ? { creditorAccount: input.creditorAccount } : {}),
      ...(input.useCollectiveDebtor ? { useCollectiveDebtor: true } : {}),
      ...((n.iban ?? input.iban) ? { iban: n.iban ?? input.iban } : {}),
      ...((n.bic ?? input.bic) ? { bic: n.bic ?? input.bic } : {}),
      tags,
      customFields: input.customFields,
      ...(input.notes ? { notes: input.notes } : {}),
    },
    preferredFormat: input.preferredFormat,
    warnings,
  };
}

// ── number assignment (CON-003, SET-064) ────────────────────────────────────────────────────────────────
async function assignContactNumber(ctx: ModelCtx, today: CalendarDate): Promise<string> {
  const date = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
  // Numbers taken manually are skipped (the range still advances, so they are never issued twice).
  for (let attempt = 0; attempt < 100; attempt++) {
    const { number } = await assignCounterNumber(ctx, { docType: "contact", date, action: "contact.create" });
    if (!(await numberTaken(ctx, number))) return number;
  }
  throw appError("conflict", "Es konnte keine freie Kontaktnummer vergeben werden. Bitte den Nummernkreis prüfen.", {
    reason: "NUMBER_COLLISION",
  });
}

// ── duplicate hints (CON-130) ─────────────────────────────────────────────────────────────────────────
async function candidateOf(ctx: ReadCtx, c: ContactDoc): Promise<DuplicateCandidate> {
  const channels = await contactChannels(ctx, c._id);
  const billing = defaultAddressOf(await contactAddresses(ctx, c._id), "billing");
  return {
    id: c._id,
    displayName: c.displayName,
    number: c.number,
    vatId: c.vatId,
    invoiceEmails: channels.filter((ch) => ch.isInvoiceEmail).map((ch) => ch.value),
    iban: c.iban,
    postalCode: billing?.address.postalCode,
  };
}

export async function duplicateHintsFor(
  ctx: ReadCtx,
  subject: Omit<DuplicateCandidate, "id"> & { id?: string },
): Promise<{ id: Id<"contacts">; displayName: string; number: string; reasons: string[]; score: number }[]> {
  const candidates = new Map<string, ContactDoc>();
  const add = (c: ContactDoc | null) => {
    if (c && c._id !== subject.id && !c.mergedIntoId) candidates.set(c._id, c);
  };
  if (subject.vatId) {
    for (const c of await ctx.db
      .query("contacts")
      .withIndex("by_vatId", (q) => q.eq("vatId", subject.vatId))
      .take(20))
      add(c);
  }
  if (subject.iban) {
    for (const c of await ctx.db
      .query("contacts")
      .withIndex("by_iban", (q) => q.eq("iban", subject.iban))
      .take(20))
      add(c);
  }
  for (const e of subject.invoiceEmails) {
    for (const ch of await ctx.db
      .query("contactChannels")
      .withIndex("by_type_value", (q) => q.eq("type", "email").eq("value", e))
      .take(20))
      add(await ctx.db.get(ch.contactId));
  }
  if (subject.postalCode) {
    const words = subject.displayName.split(/\s+/).filter((w) => w.length > 2);
    for (const w of words.slice(0, 3)) {
      for (const c of await ctx.db
        .query("contacts")
        .withSearchIndex("search", (q) => q.search("searchText", w.toLowerCase()))
        .take(20))
        add(c);
    }
  }
  const others = await Promise.all([...candidates.values()].map((c) => candidateOf(ctx, c)));
  const hints = findDuplicateHints({ ...subject, id: subject.id ?? "__new__" }, others);
  return hints.map((h) => {
    const c = candidates.get(h.id) as ContactDoc;
    return { id: c._id, displayName: c.displayName, number: c.number, reasons: h.reasons, score: h.score };
  });
}

// ── create / update ───────────────────────────────────────────────────────────────────────────────────
export async function createContact(
  ctx: ModelCtx,
  values: ContactCreateValues,
): Promise<{ id: Id<"contacts">; number: string; warnings: FieldIssue[] }> {
  const cc = await companyContext(ctx, ctx.now());
  const v = await validateWithContext(ctx, values.contact, cc);
  let number: string;
  if (values.contact.number) {
    if (await numberTaken(ctx, values.contact.number)) fail(contactNumberTaken(values.contact.number));
    number = values.contact.number.trim();
  } else {
    number = await assignContactNumber(ctx, cc.today);
  }
  const base = {
    ...v.fields,
    number,
    numberNormalized: normalizeContactNumber(number),
    status: values.contact.status,
    reverseCharge13bCertificates: [],
    einvoice: { preferredFormat: v.preferredFormat, pdfConsents: [] },
    version: 1,
  };
  const searchText = await computeSearchText(ctx, base);
  const id = await auditedInsert(ctx, "contacts", { ...base, searchText }, { action: "contact.create", label: number });
  if (values.billingAddress) {
    const a = validateAddress(values.billingAddress);
    if (a.errors[0]) fail({ ...a.errors[0], field: `billingAddress.${a.errors[0].field ?? ""}` });
    await auditedInsert(
      ctx,
      "contactAddresses",
      {
        contactId: id,
        type: "billing",
        address: addressValue({ ...values.billingAddress, name: values.billingAddress.name || v.fields.displayName }),
        isDefault: true,
      },
      { action: "contact.address.create", label: number },
    );
  }
  const stored: ChannelValues[] = [];
  for (const ch of values.channels) {
    const r = validateChannel(ch, stored);
    if (r.errors[0]) fail(r.errors[0]);
    const value = r.value as NonNullable<typeof r.value>;
    const isPrimary =
      !stored.some((s) => s.type === ch.type && s.isPrimary) &&
      (ch.isPrimary || !stored.some((s) => s.type === ch.type));
    await auditedInsert(ctx, "contactChannels", channelValue(id, { ...value, isPrimary }), {
      action: "contact.channel.create",
      label: number,
    });
    stored.push({ ...ch, value: value.value, isPrimary });
  }
  await refreshSearchText(ctx, id, "contact.create");
  return { id, number, warnings: v.warnings };
}

function addressValue(a: AddressValues | (ContactCreateValues["billingAddress"] & object)) {
  const opt = (k: string, x: string | undefined) => (x ? { [k]: x } : {});
  return {
    name: a.name,
    ...opt("name2", a.name2),
    ...opt("department", a.department),
    street: a.street,
    ...opt("street2", a.street2),
    postalCode: a.postalCode,
    city: a.city,
    countryCode: a.countryCode,
    ...opt("poBox", a.poBox),
  };
}

function channelValue(
  contactId: Id<"contacts">,
  c: {
    type: ChannelType;
    value: string;
    e164?: string | undefined;
    label?: string | undefined;
    isPrimary: boolean;
    isInvoiceEmail: boolean;
  },
) {
  return {
    contactId,
    type: c.type,
    value: c.value,
    ...(c.e164 ? { e164: c.e164 } : {}),
    ...(c.label ? { label: c.label } : {}),
    isPrimary: c.isPrimary,
    isInvoiceEmail: c.type === "email" && c.isInvoiceEmail,
  };
}

const REMOVABLE: readonly (keyof ContactDoc)[] = [
  "parentId",
  "organizationName",
  "organizationName2",
  "salutation",
  "academicTitle",
  "firstName",
  "lastName",
  "position",
  "birthday",
  "vatId",
  "taxNumber",
  "buyerReference",
  "electronicAddress",
  "defaultTaxCase",
  "paymentTerms",
  "defaultDiscountBp",
  "paymentMethodId",
  "debtorAccount",
  "creditorAccount",
  "useCollectiveDebtor",
  "iban",
  "bic",
  "notes",
];

/** CON-007 optimistic concurrency; CON-060 a changed VAT ID resets the status (old checks stay as evidence). */
export async function updateContact(
  ctx: ModelCtx,
  id: Id<"contacts">,
  expectedVersion: number,
  input: ContactInput,
  opts: { reason?: string } = {},
): Promise<{ warnings: FieldIssue[]; vatIdChanged: boolean }> {
  const existing = await getContact(ctx, id);
  if (existing.version !== expectedVersion) versionConflict();
  if (existing.mergedIntoId) {
    throw appError("invalid_input", "Der Kontakt wurde zusammengeführt und kann nicht mehr bearbeitet werden.", {
      reason: "CONTACT_MERGED",
    });
  }
  const cc = await companyContext(ctx, ctx.now());
  const v = await validateWithContext(ctx, input, cc, existing);
  let number = existing.number;
  if (input.number && normalizeContactNumber(input.number) !== existing.numberNormalized) {
    if (await numberTaken(ctx, input.number, id)) fail(contactNumberTaken(input.number));
    number = input.number.trim();
  }
  const vatIdChanged = (v.fields.vatId ?? "") !== (existing.vatId ?? "");
  const cleared = Object.fromEntries(REMOVABLE.filter((k) => !(k in v.fields)).map((k) => [k, undefined]));
  const status =
    existing.status === "archived"
      ? "archived"
      : input.status === "lead" && existing.status === "active"
        ? "active"
        : input.status;
  const next = {
    ...cleared,
    ...v.fields,
    number,
    numberNormalized: normalizeContactNumber(number),
    status,
    einvoice: { ...existing.einvoice, preferredFormat: v.preferredFormat },
    ...(vatIdChanged ? { vatIdStatus: undefined } : {}),
    version: existing.version + 1,
  };
  const searchText = await computeSearchText(ctx, { ...existing, ...next } as ContactDoc, id);
  await auditedPatch(ctx, "contacts", id, { ...next, searchText } as Partial<ContactDoc>, {
    action: "contact.update",
    label: number,
    ...(opts.reason ? { reason: opts.reason } : {}),
  });
  return { warnings: v.warnings, vatIdChanged };
}

// ── archive / delete (CON-170/171) ──────────────────────────────────────────────────────────────────────
export async function setArchived(ctx: ModelCtx, id: Id<"contacts">, archived: boolean): Promise<void> {
  const c = await getContact(ctx, id);
  if (c.mergedIntoId && !archived) {
    throw appError("invalid_input", "Zusammengeführte Kontakte können nicht wiederhergestellt werden.", {
      reason: "CONTACT_MERGED",
    });
  }
  const status = archived ? "archived" : "active";
  if (c.status === status) return;
  await auditedPatch(
    ctx,
    "contacts",
    id,
    { status, version: c.version + 1 },
    { action: archived ? "contact.archive" : "contact.unarchive", label: c.number },
  );
}

/**
 * CON-170 references that block a hard delete. Finalised documents, payments, vouchers, journal entries, bank
 * matches, time entries, recurring templates and SEPA mandates arrive with later features (each extends this list).
 */
export async function blockingReferences(ctx: ReadCtx, id: Id<"contacts">): Promise<string[]> {
  const out: string[] = [];
  const children = await childPersons(ctx, id);
  if (children.length > 0) out.push(`${children.length} Ansprechpartner`);
  const merges = await ctx.db
    .query("contactMerges")
    .withIndex("by_winner", (q) => q.eq("winnerId", id))
    .first();
  if (merges) out.push("Zusammenführungen");
  const asLoser = await ctx.db
    .query("contactMerges")
    .withIndex("by_loser", (q) => q.eq("loserId", id))
    .first();
  if (asLoser) out.push("Zusammenführungen");
  const checks = await ctx.db
    .query("vatIdChecks")
    .withIndex("by_contact", (q) => q.eq("contactId", id))
    .first();
  if (checks) out.push("USt-IdNr-Prüfnachweise");
  return [...new Set(out)];
}

export async function deleteContact(ctx: ModelCtx, id: Id<"contacts">): Promise<void> {
  const c = await getContact(ctx, id);
  const refs = await blockingReferences(ctx, id);
  if (refs.length > 0) {
    throw appError(
      "invalid_input",
      `Der Kontakt wird noch verwendet (${refs.join(", ")}) und kann nur archiviert werden.`,
      { reason: "CONTACT_IN_USE", references: refs },
    );
  }
  for (const a of await contactAddresses(ctx, id)) {
    await auditedDelete(ctx, "contactAddresses", a._id, { action: "contact.address.delete", label: c.number });
  }
  for (const ch of await contactChannels(ctx, id)) {
    await auditedDelete(ctx, "contactChannels", ch._id, { action: "contact.channel.delete", label: c.number });
  }
  for (const act of await contactActivities(ctx, id)) {
    await auditedDelete(ctx, "contactActivities", act._id, { action: "contact.activity.delete", label: c.number });
  }
  for (const p of await ctx.db
    .query("customerPrices")
    .withIndex("by_contact", (q) => q.eq("contactId", id))
    .collect()) {
    await auditedDelete(ctx, "customerPrices", p._id, { action: "product.customer_price.delete", label: c.number });
  }
  for (const d of await ctx.db.query("dismissedDuplicates").collect()) {
    if (d.a === id || d.b === id) {
      await auditedDelete(ctx, "dismissedDuplicates", d._id, { action: "contact.duplicate.delete", label: c.number });
    }
  }
  await auditedDelete(ctx, "contacts", id, { action: "contact.delete", label: c.number });
}

// ── addresses (CON-020…024) ─────────────────────────────────────────────────────────────────────────────
export async function saveAddress(
  ctx: ModelCtx,
  contactId: Id<"contacts">,
  values: AddressValues,
  addressId?: Id<"contactAddresses">,
): Promise<Id<"contactAddresses">> {
  const c = await getContact(ctx, contactId);
  const rows = (await contactAddresses(ctx, contactId)).filter((a) => a.archivedAt === undefined);
  const address = addressValue({ ...values, name: values.name || c.displayName });
  const sameType = rows.filter((a) => a.type === values.type && a._id !== addressId);
  // Exactly one default per type: the first address of a type becomes the default.
  const isDefault = values.isDefault || !sameType.some((a) => a.isDefault);
  if (isDefault) {
    for (const a of sameType.filter((a) => a.isDefault)) {
      await auditedPatch(
        ctx,
        "contactAddresses",
        a._id,
        { isDefault: false },
        { action: "contact.address.update", label: c.number },
      );
    }
  }
  let id: Id<"contactAddresses">;
  if (addressId) {
    const row = rows.find((a) => a._id === addressId);
    if (!row) throw appError("not_found", "Adresse nicht gefunden.");
    await auditedPatch(
      ctx,
      "contactAddresses",
      addressId,
      { type: values.type, address, isDefault },
      { action: "contact.address.update", label: c.number },
    );
    id = addressId;
    if (row.isDefault && row.type !== values.type) await promoteDefault(ctx, c, row.type, addressId);
  } else {
    id = await auditedInsert(
      ctx,
      "contactAddresses",
      { contactId, type: values.type, address, isDefault },
      { action: "contact.address.create", label: c.number },
    );
  }
  await refreshSearchText(ctx, contactId, "contact.address.update");
  return id;
}

async function promoteDefault(ctx: ModelCtx, c: ContactDoc, type: AddressType, removedId: Id<"contactAddresses">) {
  const rows = (await contactAddresses(ctx, c._id)).filter((a) => a.archivedAt === undefined && a._id !== removedId);
  const next = nextDefaultAfterRemoval(
    rows.map((a) => ({ id: a._id, type: a.type, isDefault: a.isDefault })),
    { id: removedId, type },
  );
  if (next) {
    await auditedPatch(
      ctx,
      "contactAddresses",
      next as Id<"contactAddresses">,
      { isDefault: true },
      {
        action: "contact.address.update",
        label: c.number,
      },
    );
  }
}

/**
 * CON-024: an address referenced by a document is archived instead of deleted. Document references arrive with
 * F04 (`salesDocuments.addressId`); until then every address can be deleted.
 */
export async function removeAddress(ctx: ModelCtx, addressId: Id<"contactAddresses">): Promise<void> {
  const row = await ctx.db.get(addressId);
  if (!row) throw appError("not_found", "Adresse nicht gefunden.");
  const c = await getContact(ctx, row.contactId);
  await auditedDelete(ctx, "contactAddresses", addressId, { action: "contact.address.delete", label: c.number });
  if (row.isDefault) await promoteDefault(ctx, c, row.type, addressId);
  await refreshSearchText(ctx, c._id, "contact.address.delete");
}

// ── channels (CON-030…032) ──────────────────────────────────────────────────────────────────────────────
export async function saveChannel(
  ctx: ModelCtx,
  contactId: Id<"contacts">,
  values: ChannelValues,
  channelId?: Id<"contactChannels">,
): Promise<Id<"contactChannels">> {
  const c = await getContact(ctx, contactId);
  const rows = await contactChannels(ctx, contactId);
  const others = rows.filter((r) => r._id !== channelId);
  const r = validateChannel(values, others);
  if (r.errors[0]) fail(r.errors[0]);
  const value = r.value as NonNullable<typeof r.value>;
  const sameType = others.filter((o) => o.type === values.type);
  const isPrimary = values.isPrimary || !sameType.some((o) => o.isPrimary);
  if (isPrimary) {
    for (const o of sameType.filter((o) => o.isPrimary)) {
      await auditedPatch(
        ctx,
        "contactChannels",
        o._id,
        { isPrimary: false },
        { action: "contact.channel.update", label: c.number },
      );
    }
  }
  const doc = channelValue(contactId, { ...value, isPrimary });
  let id: Id<"contactChannels">;
  if (channelId) {
    if (!rows.some((x) => x._id === channelId)) throw appError("not_found", "Eintrag nicht gefunden.");
    await auditedPatch(
      ctx,
      "contactChannels",
      channelId,
      { ...doc, e164: doc.e164, label: doc.label },
      { action: "contact.channel.update", label: c.number },
    );
    id = channelId;
  } else {
    id = await auditedInsert(ctx, "contactChannels", doc, { action: "contact.channel.create", label: c.number });
  }
  await refreshSearchText(ctx, contactId, "contact.channel.update");
  return id;
}

export async function removeChannel(ctx: ModelCtx, channelId: Id<"contactChannels">): Promise<void> {
  const row = await ctx.db.get(channelId);
  if (!row) throw appError("not_found", "Eintrag nicht gefunden.");
  const c = await getContact(ctx, row.contactId);
  await auditedDelete(ctx, "contactChannels", channelId, { action: "contact.channel.delete", label: c.number });
  if (row.isPrimary) {
    const next = (await contactChannels(ctx, c._id)).find((x) => x.type === row.type);
    if (next) {
      await auditedPatch(
        ctx,
        "contactChannels",
        next._id,
        { isPrimary: true },
        { action: "contact.channel.update", label: c.number },
      );
    }
  }
  await refreshSearchText(ctx, c._id, "contact.channel.delete");
}

// ── activities (CON-120…123) ────────────────────────────────────────────────────────────────────────────
function activityFields(values: ActivityFormValues & { text: string }) {
  return {
    kind: values.kind,
    text: values.text,
    ...(values.kind === "task" && values.dueOn ? { dueAt: berlinEndOfDay(calendarDate(values.dueOn)) } : {}),
  };
}

export async function addActivity(
  ctx: ModelCtx,
  contactId: Id<"contacts">,
  values: ActivityFormValues,
): Promise<Id<"contactActivities">> {
  const c = await getContact(ctx, contactId);
  return auditedInsert(
    ctx,
    "contactActivities",
    { contactId, ...activityFields(values), attachments: [], actor: ctx.actor },
    { action: "contact.activity.create", label: c.number },
  );
}

export async function updateActivity(
  ctx: ModelCtx,
  activityId: Id<"contactActivities">,
  values: ActivityFormValues,
): Promise<void> {
  const row = await ctx.db.get(activityId);
  if (!row) throw appError("not_found", "Eintrag nicht gefunden.");
  const c = await getContact(ctx, row.contactId);
  const f = activityFields(values);
  await auditedPatch(
    ctx,
    "contactActivities",
    activityId,
    { ...f, dueAt: "dueAt" in f ? f.dueAt : undefined, editedAt: ctx.now() },
    { action: "contact.activity.update", label: c.number },
  );
}

export async function setTaskDone(ctx: ModelCtx, activityId: Id<"contactActivities">, done: boolean): Promise<void> {
  const row = await ctx.db.get(activityId);
  if (row?.kind !== "task") throw appError("not_found", "Aufgabe nicht gefunden.");
  const c = await getContact(ctx, row.contactId);
  await auditedPatch(
    ctx,
    "contactActivities",
    activityId,
    { doneAt: done ? ctx.now() : undefined },
    { action: done ? "contact.task.done" : "contact.task.reopen", label: c.number },
  );
}

export async function removeActivity(ctx: ModelCtx, activityId: Id<"contactActivities">): Promise<void> {
  const row = await ctx.db.get(activityId);
  if (!row) throw appError("not_found", "Eintrag nicht gefunden.");
  const c = await getContact(ctx, row.contactId);
  await auditedDelete(ctx, "contactActivities", activityId, { action: "contact.activity.delete", label: c.number });
}

// ── PDF consent (CON-081) and §13b certificates (CON-070/072) ─────────────────────────────────────────────
export async function addPdfConsent(
  ctx: ModelCtx,
  contactId: Id<"contacts">,
  values: PdfConsentFormValues,
): Promise<void> {
  const c = await getContact(ctx, contactId);
  const today = berlinCalendarDate(ctx.now());
  const r = validateConsent(values, today);
  if (r.errors[0]) fail(r.errors[0]);
  const consent = {
    givenAt: values.givenAt,
    source: values.source,
    ...(values.note?.trim() ? { note: values.note.trim() } : {}),
    recordedAt: ctx.now(),
  };
  await auditedPatch(
    ctx,
    "contacts",
    contactId,
    { einvoice: { ...c.einvoice, pdfConsents: [...c.einvoice.pdfConsents, consent] }, version: c.version + 1 },
    { action: "contact.consent.record", label: c.number },
  );
}

export async function revokePdfConsent(ctx: ModelCtx, contactId: Id<"contacts">, revokedAt: string): Promise<void> {
  const c = await getContact(ctx, contactId);
  const today = berlinCalendarDate(ctx.now());
  const target = revocationTarget(c.einvoice.pdfConsents, calendarDate(revokedAt), today);
  if ("error" in target) fail(target.error);
  const pdfConsents = c.einvoice.pdfConsents.map((x, i) => (i === target.index ? { ...x, revokedAt } : x));
  await auditedPatch(
    ctx,
    "contacts",
    contactId,
    { einvoice: { ...c.einvoice, pdfConsents }, version: c.version + 1 },
    { action: "contact.consent.revoke", label: c.number },
  );
}

export async function addCertificate(
  ctx: ModelCtx,
  contactId: Id<"contacts">,
  input: { validUntil: string; storageId?: Id<"_storage">; fileName?: string },
): Promise<{ warnings: FieldIssue[] }> {
  const c = await getContact(ctx, contactId);
  let file: Doc<"contacts">["reverseCharge13bCertificates"][number]["file"];
  if (input.storageId) {
    const meta = await ctx.db.system.get(input.storageId);
    if (!meta) throw appError("not_found", "Datei nicht gefunden.");
    file = {
      storageId: input.storageId,
      sha256: meta.sha256,
      bytes: meta.size,
      mime: meta.contentType ?? mimeFromName(input.fileName ?? ""),
      name: input.fileName?.trim() || "USt-1-TG",
    };
  }
  const today = berlinCalendarDate(ctx.now());
  const r = validateCertificate({ validUntil: input.validUntil, file }, today);
  if (r.errors[0]) fail(r.errors[0]);
  const now = ctx.now();
  // CON-072: the previous certificate stays as evidence (marked replaced).
  const history = c.reverseCharge13bCertificates.map((x) =>
    x.replacedAt === undefined ? { ...x, replacedAt: now } : x,
  );
  await auditedPatch(
    ctx,
    "contacts",
    contactId,
    {
      reverseCharge13bCertificates: [
        ...history,
        { ...(file ? { file } : {}), validUntil: input.validUntil, addedAt: now },
      ],
      version: c.version + 1,
    },
    { action: "contact.certificate.add", label: c.number },
  );
  return { warnings: r.warnings };
}

function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop();
  return ext === "pdf"
    ? "application/pdf"
    : ext === "png"
      ? "image/png"
      : ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : "application/octet-stream";
}

// ── bulk (CON-174) ────────────────────────────────────────────────────────────────────────────────────
export async function bulkTag(ctx: ModelCtx, ids: readonly Id<"contacts">[], tagId: Id<"tags">, add: boolean) {
  if (!(await ctx.db.get(tagId))) throw appError("not_found", "Tag nicht gefunden.");
  let changed = 0;
  for (const id of ids) {
    const c = await getContact(ctx, id);
    const has = c.tags.includes(tagId);
    if (has === add) continue;
    const tags = add ? [...c.tags, tagId] : c.tags.filter((t) => t !== tagId);
    const searchText = await computeSearchText(ctx, { ...c, tags }, id);
    await auditedPatch(
      ctx,
      "contacts",
      id,
      { tags, searchText, version: c.version + 1 },
      {
        action: add ? "contact.tag.add" : "contact.tag.remove",
        label: c.number,
      },
    );
    changed++;
  }
  return changed;
}

/** SET-094: deleting a tag removes it from every contact. */
export async function removeTagFromContacts(ctx: ModelCtx, tagId: Id<"tags">) {
  for (const c of await ctx.db.query("contacts").collect()) {
    if (!c.tags.includes(tagId)) continue;
    const tags = c.tags.filter((t) => t !== tagId);
    await auditedPatch(
      ctx,
      "contacts",
      c._id,
      { tags, version: c.version + 1 },
      { action: "contact.tag.remove", label: c.number },
    );
  }
}

// ── DATEV personal accounts (CON-101) ───────────────────────────────────────────────────────────────────
/** Called by the first finalised sales document (F04) or booked voucher (F06) or the DATEV export (F09). */
export async function ensurePersonalAccount(
  ctx: ModelCtx,
  contactId: Id<"contacts">,
  kind: "debtor" | "creditor",
): Promise<string | undefined> {
  const c = await getContact(ctx, contactId);
  const field = kind === "debtor" ? "debtorAccount" : "creditorAccount";
  if (c[field]) return c[field];
  if (kind === "debtor" && c.useCollectiveDebtor) return undefined;
  const cc = await companyContext(ctx, ctx.now());
  const ranges = personalAccountRanges(cc.accountLength);
  const used = (await ctx.db.query("contacts").collect()).map((x) => x[field]).filter((a): a is string => !!a);
  const account = nextFreeAccount(used, kind === "debtor" ? ranges.debtors : ranges.creditors);
  if (!account) {
    throw appError("invalid_input", "Der Nummernbereich für Personenkonten ist erschöpft.", {
      reason: "ACCOUNT_RANGE_EXHAUSTED",
    });
  }
  await auditedPatch(
    ctx,
    "contacts",
    contactId,
    { [field]: account, version: c.version + 1 },
    {
      action: "contact.account.assign",
      label: c.number,
    },
  );
  return account;
}

// ── duplicates (CON-131) ──────────────────────────────────────────────────────────────────────────────
export async function duplicatePairs(ctx: ReadCtx) {
  const contacts = (await ctx.db.query("contacts").collect()).filter((c) => !c.mergedIntoId && c.status !== "archived");
  const candidates = await Promise.all(contacts.map((c) => candidateOf(ctx, c)));
  const dismissed = new Set((await ctx.db.query("dismissedDuplicates").collect()).map((d) => `${d.a}|${d.b}`));
  const byId = new Map(contacts.map((c) => [c._id as string, c]));
  return findDuplicatePairs(candidates, dismissed).map((p) => ({
    ...p,
    a: byId.get(p.a) as ContactDoc,
    b: byId.get(p.b) as ContactDoc,
  }));
}

export async function dismissDuplicate(ctx: ModelCtx, x: Id<"contacts">, y: Id<"contacts">): Promise<void> {
  const [a, b] = pairKey(x, y) as [Id<"contacts">, Id<"contacts">];
  const ca = await getContact(ctx, a);
  await getContact(ctx, b);
  const existing = await ctx.db
    .query("dismissedDuplicates")
    .withIndex("by_pair", (q) => q.eq("a", a).eq("b", b))
    .first();
  if (existing) return;
  await auditedInsert(
    ctx,
    "dismissedDuplicates",
    { a, b, at: ctx.now(), actor: ctx.actor },
    {
      action: "contact.duplicate.dismiss",
      label: ca.number,
    },
  );
}

// ── merge (CON-132…135) ─────────────────────────────────────────────────────────────────────────────────
const mergeContactOf = (c: ContactDoc): MergeContact => ({
  id: c._id,
  kind: c.kind,
  status: c.status,
  mergedIntoId: c.mergedIntoId,
  restrictedAt: c.dsgvo?.restrictedAt,
  displayName: c.displayName,
  fields: Object.fromEntries(MERGE_FIELDS.map((f) => [f, c[f as keyof ContactDoc]])) as MergeContact["fields"],
  tags: c.tags,
  customFields: c.customFields,
});

/** Rows of `contactId` that move to the winner (mutable data only; finalised records stay, CON-132). */
async function movableRows(ctx: ReadCtx, contactId: Id<"contacts">) {
  return {
    contactAddresses: await contactAddresses(ctx, contactId),
    contactChannels: await contactChannels(ctx, contactId),
    contactActivities: await contactActivities(ctx, contactId),
    customerPrices: await ctx.db
      .query("customerPrices")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .collect(),
    persons: await childPersons(ctx, contactId),
  };
}

export async function mergePreview(ctx: ReadCtx, loserIds: readonly Id<"contacts">[]) {
  const losers = await Promise.all(loserIds.map((id) => getContact(ctx, id)));
  const moves = await Promise.all(losers.map((l) => movableRows(ctx, l._id)));
  const sum = (k: keyof Awaited<ReturnType<typeof movableRows>>) => moves.reduce((n, m) => n + m[k].length, 0);
  const vatChecks = (
    await Promise.all(
      losers.map((l) =>
        ctx.db
          .query("vatIdChecks")
          .withIndex("by_contact", (q) => q.eq("contactId", l._id))
          .collect(),
      ),
    )
  ).flat().length;
  return {
    moves: {
      addresses: sum("contactAddresses"),
      channels: sum("contactChannels"),
      activities: sum("contactActivities"),
      customerPrices: sum("customerPrices"),
      persons: sum("persons"),
    },
    stays: { vatIdChecks: vatChecks },
  };
}

export async function mergeContacts(
  ctx: ModelCtx,
  input: {
    winnerId: Id<"contacts">;
    loserIds: Id<"contacts">[];
    fieldChoices: Record<string, string>;
    confirmVatConflict: boolean;
  },
): Promise<Id<"contactMerges">[]> {
  const winner = await getContact(ctx, input.winnerId);
  const losers = await Promise.all(input.loserIds.map((id) => getContact(ctx, id)));
  const issue = validateMerge(mergeContactOf(winner), losers.map(mergeContactOf), input.confirmVatConflict);
  if (issue) fail(issue);
  const choices = input.fieldChoices as FieldChoices;
  const merged = mergedValues(mergeContactOf(winner), losers.map(mergeContactOf), choices);
  const restoreWinner: Record<string, unknown> = {
    tags: winner.tags,
    customFields: winner.customFields,
  };
  const patch: Record<string, unknown> = { tags: merged.tags, customFields: merged.customFields };
  for (const [f, value] of Object.entries(merged.fields)) {
    restoreWinner[f] = winner[f as keyof ContactDoc] ?? null;
    patch[f] = value;
  }
  // Uniqueness of DATEV accounts: a moved account must not stay on the loser too (CON-135 keeps the winner's).
  const nextWinner = { ...winner, ...patch } as ContactDoc;
  nextWinner.displayName = displayName(nextWinner);
  patch.displayName = nextWinner.displayName;
  restoreWinner.displayName = winner.displayName;
  patch.searchText = await computeSearchText(ctx, nextWinner, winner._id);
  restoreWinner.searchText = winner.searchText;
  restoreWinner.version = winner.version;
  patch.version = winner.version + 1;
  const fieldChoiceRecord: Record<string, "winner" | "loser"> = {};
  for (const f of MERGE_FIELDS) {
    const chosen = choices[f as MergeField];
    if (chosen && chosen !== winner._id) fieldChoiceRecord[f] = "loser";
  }
  const ids: Id<"contactMerges">[] = [];
  for (const loser of losers) {
    const rows = await movableRows(ctx, loser._id);
    const moved: { table: string; id: string }[] = [];
    for (const a of rows.contactAddresses) {
      // The winner keeps its defaults; moved addresses become additional ones.
      await auditedPatch(
        ctx,
        "contactAddresses",
        a._id,
        { contactId: winner._id, isDefault: false },
        {
          action: "contact.merge",
          label: winner.number,
        },
      );
      moved.push({ table: "contactAddresses", id: a._id });
    }
    for (const ch of rows.contactChannels) {
      await auditedPatch(
        ctx,
        "contactChannels",
        ch._id,
        { contactId: winner._id, isPrimary: false },
        {
          action: "contact.merge",
          label: winner.number,
        },
      );
      moved.push({ table: "contactChannels", id: ch._id });
    }
    for (const act of rows.contactActivities) {
      await auditedPatch(
        ctx,
        "contactActivities",
        act._id,
        { contactId: winner._id },
        {
          action: "contact.merge",
          label: winner.number,
        },
      );
      moved.push({ table: "contactActivities", id: act._id });
    }
    for (const p of rows.customerPrices) {
      await auditedPatch(
        ctx,
        "customerPrices",
        p._id,
        { contactId: winner._id },
        { action: "contact.merge", label: winner.number },
      );
      moved.push({ table: "customerPrices", id: p._id });
    }
    for (const person of rows.persons) {
      await auditedPatch(
        ctx,
        "contacts",
        person._id,
        { parentId: winner._id, version: person.version + 1 },
        {
          action: "contact.merge",
          label: winner.number,
        },
      );
      moved.push({ table: "contacts", id: person._id });
    }
    await auditedPatch(
      ctx,
      "contacts",
      loser._id,
      { status: "archived", mergedIntoId: winner._id, version: loser.version + 1 },
      { action: "contact.merge", label: loser.number, reason: `Zusammengeführt mit ${winner.number}` },
    );
    ids.push(
      await auditedInsert(
        ctx,
        "contactMerges",
        {
          winnerId: winner._id,
          loserId: loser._id,
          moved,
          fieldChoices: fieldChoiceRecord,
          restore: { winner: restoreWinner, loserStatus: loser.status },
          at: ctx.now(),
          actor: ctx.actor,
        },
        { action: "contact.merge", label: `${loser.number} → ${winner.number}` },
      ),
    );
  }
  // Fields moved from a loser: clear account fields on the loser first so the index stays unique.
  await auditedPatch(ctx, "contacts", winner._id, patch as Partial<ContactDoc>, {
    action: "contact.merge",
    label: winner.number,
  });
  await refreshSearchText(ctx, winner._id, "contact.merge");
  return ids;
}

/** CON-134: undo while no moved draft was finalised (drafts arrive with F04: 0 until then). */
export async function undoMerge(ctx: ModelCtx, mergeId: Id<"contactMerges">): Promise<void> {
  const m = await ctx.db.get(mergeId);
  if (!m) throw appError("not_found", "Zusammenführung nicht gefunden.");
  const issue = checkUndo(0, m.undoneAt !== undefined);
  if (issue) fail(issue);
  const loser = await getContact(ctx, m.loserId);
  const winner = await getContact(ctx, m.winnerId);
  for (const item of m.moved) {
    if (item.table === "contacts") {
      const id = item.id as Id<"contacts">;
      const p = await getContact(ctx, id);
      await auditedPatch(
        ctx,
        "contacts",
        id,
        { parentId: loser._id, version: p.version + 1 },
        {
          action: "contact.merge_undo",
          label: loser.number,
        },
      );
    } else if (
      item.table === "contactAddresses" ||
      item.table === "contactChannels" ||
      item.table === "contactActivities" ||
      item.table === "customerPrices"
    ) {
      const id = item.id as Id<"contactAddresses">;
      const row = await ctx.db.get(id);
      if (row) {
        await auditedPatch(
          ctx,
          item.table as "contactAddresses",
          id,
          { contactId: loser._id },
          {
            action: "contact.merge_undo",
            label: loser.number,
          },
        );
      }
    }
  }
  // Defaults of the restored loser: the first address/channel per type becomes the default again.
  for (const type of ["billing", "delivery", "other"] as const) {
    const rows = (await contactAddresses(ctx, loser._id)).filter((a) => a.type === type);
    if (rows.length > 0 && !rows.some((a) => a.isDefault)) {
      await auditedPatch(
        ctx,
        "contactAddresses",
        (rows[0] as Doc<"contactAddresses">)._id,
        { isDefault: true },
        {
          action: "contact.merge_undo",
          label: loser.number,
        },
      );
    }
  }
  for (const ch of await contactChannels(ctx, loser._id)) {
    const sameType = (await contactChannels(ctx, loser._id)).filter((x) => x.type === ch.type);
    if (!sameType.some((x) => x.isPrimary)) {
      await auditedPatch(
        ctx,
        "contactChannels",
        ch._id,
        { isPrimary: true },
        { action: "contact.merge_undo", label: loser.number },
      );
    }
  }
  await auditedPatch(
    ctx,
    "contacts",
    loser._id,
    { status: m.restore.loserStatus, mergedIntoId: undefined, version: loser.version + 1 },
    { action: "contact.merge_undo", label: loser.number },
  );
  const restore: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m.restore.winner)) restore[k] = v === null ? undefined : v;
  restore.version = winner.version + 1;
  await auditedPatch(ctx, "contacts", winner._id, restore as Partial<ContactDoc>, {
    action: "contact.merge_undo",
    label: winner.number,
  });
  await refreshSearchText(ctx, winner._id, "contact.merge_undo");
  await refreshSearchText(ctx, loser._id, "contact.merge_undo");
  await auditedPatch(
    ctx,
    "contactMerges",
    mergeId,
    { undoneAt: ctx.now() },
    { action: "contact.merge_undo", label: loser.number },
  );
}
