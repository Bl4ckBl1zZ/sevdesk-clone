import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { filter } from "convex-helpers/server/filter";
import { invoiceRecipients, primaryOf } from "../src/domain/contacts/channels";
import { currentCertificate } from "../src/domain/contacts/consent";
import { normalizeContactNumber, normalizeSearchQuery } from "../src/domain/contacts/core";
import { CONTACT_EXPORT_HEADERS, classifyRow, contactExportRow } from "../src/domain/contacts/csv-io";
import { contactRanking, type RankedDocument, sortRanking } from "../src/domain/contacts/ranking";
import { computeContactStats, type StatsDocType, type StatsDocument } from "../src/domain/contacts/stats";
import { effectiveElectronicAddress } from "../src/domain/contacts/tax";
import { deriveTaxProfile } from "../src/domain/contacts/tax-profile";
import { vatBadge } from "../src/domain/contacts/vat-check";
import { render } from "../src/domain/numbering/format";
import {
  activitySchema,
  addressSchema,
  certificateSchema,
  channelSchema,
  contactCreateSchema,
  contactSchema,
  mergeSchema,
  pdfConsentSchema,
} from "../src/domain/schemas/contacts";
import type { TaxCase } from "../src/domain/tax/tax-case";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { formatGermanDate } from "../src/domain/time/calendar-date";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query, vConfirmToken } from "./functions";
import { appError } from "./lib/errors";
import { parse } from "./lib/parse";
import {
  addActivity as addActivityModel,
  addCertificate as addCertificateModel,
  addPdfConsent as addPdfConsentModel,
  blockingReferences,
  bulkTag as bulkTagModel,
  childPersons,
  companyContext,
  contactActivities,
  contactAddresses,
  contactChannels,
  createContact,
  defaultAddressOf,
  deleteContact,
  dismissDuplicate as dismissDuplicateModel,
  duplicateHintsFor,
  duplicatePairs,
  getContact,
  mergeContacts,
  mergePreview as mergePreviewModel,
  removeActivity as removeActivityModel,
  removeAddress as removeAddressModel,
  removeChannel as removeChannelModel,
  revokePdfConsent as revokePdfConsentModel,
  saveAddress as saveAddressModel,
  saveChannel as saveChannelModel,
  setArchived,
  setSelfBillingAgreement as setSelfBillingAgreementModel,
  setTaskDone as setTaskDoneModel,
  undoMerge as undoMergeModel,
  updateActivity as updateActivityModel,
  updateContact,
} from "./model/contacts";
import { listDefaultRanges, nextValue } from "./model/numberRanges";
import { contactChecks } from "./model/vatChecks";
import { vFileRef } from "./validators";

/**
 * Kontakte (F02). Public queries and mutations for the UI (and later REST/MCP): every function declares its
 * permission (contacts.read / contacts.write / contacts.merge); all writes go through convex/model/contacts.ts.
 */

const germanDate = (ms: number) => formatGermanDate(berlinCalendarDate(ms));

const vStatusFilter = v.optional(
  v.union(v.literal("open"), v.literal("lead"), v.literal("active"), v.literal("archived"), v.literal("all")),
);

const listArgs = {
  q: v.optional(v.string()),
  status: vStatusFilter,
  kind: v.optional(v.union(v.literal("organization"), v.literal("person"))),
  role: v.optional(v.union(v.literal("customer"), v.literal("supplier"), v.literal("partner"), v.literal("prospect"))),
  tag: v.optional(v.string()),
  country: v.optional(v.string()),
  type: v.optional(v.union(v.literal("b2b"), v.literal("b2c"), v.literal("b2g"))),
  vatStatus: v.optional(
    v.union(
      v.literal("qualified"),
      v.literal("valid"),
      v.literal("invalid"),
      v.literal("unchecked"),
      v.literal("unavailable"),
    ),
  ),
  parentId: v.optional(v.id("contacts")),
};

type ListFilter = {
  q?: string;
  status?: "open" | "lead" | "active" | "archived" | "all";
  kind?: "organization" | "person";
  role?: "customer" | "supplier" | "partner" | "prospect";
  tag?: string;
  country?: string;
  type?: "b2b" | "b2c" | "b2g";
  vatStatus?: "qualified" | "valid" | "invalid" | "unchecked" | "unavailable";
  parentId?: Id<"contacts">;
};

function baseQuery(ctx: QueryCtx, f: ListFilter) {
  const status = f.status ?? "open";
  const q = f.q?.trim() ? normalizeSearchQuery(f.q) : "";
  if (q) {
    return ctx.db.query("contacts").withSearchIndex("search", (s) => {
      const base = s.search("searchText", q);
      const withStatus =
        status === "lead" || status === "active" || status === "archived" ? base.eq("status", status) : base;
      return f.kind ? withStatus.eq("kind", f.kind) : withStatus;
    });
  }
  if (status === "lead" || status === "active" || status === "archived") {
    return ctx.db
      .query("contacts")
      .withIndex("by_status_name", (i) => i.eq("status", status))
      .order("asc");
  }
  if (f.parentId) {
    return ctx.db.query("contacts").withIndex("by_parent", (i) => i.eq("parentId", f.parentId));
  }
  return ctx.db.query("contacts").withIndex("by_status_name").order("asc");
}

async function matches(ctx: QueryCtx, c: Doc<"contacts">, f: ListFilter): Promise<boolean> {
  const status = f.status ?? "open";
  if (c.mergedIntoId && status !== "all") return false;
  // F12 PRV-012: restricted contacts (DSGVO Art. 18) are hidden from lists, search and pickers („Alle“ shows them).
  if (c.dsgvo?.restrictedAt !== undefined && status !== "all") return false;
  if (status === "open" && c.status === "archived") return false;
  if ((status === "lead" || status === "active" || status === "archived") && c.status !== status) return false;
  if (f.kind && c.kind !== f.kind) return false;
  if (f.parentId && c.parentId !== f.parentId) return false;
  if (f.role && !c.roles.includes(f.role)) return false;
  if (f.type === "b2c" && !c.isConsumer) return false;
  if (f.type === "b2g" && !c.isPublicAuthority) return false;
  if (f.type === "b2b" && (c.isConsumer || c.isPublicAuthority)) return false;
  if (f.vatStatus) {
    const s = c.vatIdStatus;
    const kind = !s ? "unchecked" : s.status !== "valid" ? s.status : s.qualified ? "qualified" : "valid";
    if (kind !== f.vatStatus) return false;
  }
  if (f.tag) {
    // CON-010: tags of the parent organisation apply to its persons for filtering (computed, not copied).
    const own = c.tags.some((t) => t === f.tag);
    const parent = !own && c.parentId ? await ctx.db.get(c.parentId) : null;
    if (!own && !parent?.tags.some((t) => t === f.tag)) return false;
  }
  if (f.country) {
    const billing = defaultAddressOf(await contactAddresses(ctx, c._id), "billing");
    if (billing?.address.countryCode !== f.country.toUpperCase()) return false;
  }
  return true;
}

async function listRow(ctx: QueryCtx, c: Doc<"contacts">, figures?: { openCents: number; revenueYearCents: number }) {
  const addresses = await contactAddresses(ctx, c._id);
  const channels = await contactChannels(ctx, c._id);
  const billing = defaultAddressOf(addresses, "billing");
  const parent = c.parentId ? await ctx.db.get(c.parentId) : null;
  const lastCheck = c.vatIdStatus ? await ctx.db.get(c.vatIdStatus.lastCheckId) : null;
  const tags = (await Promise.all(c.tags.map((t) => ctx.db.get(t)))).filter((t): t is Doc<"tags"> => t !== null);
  return {
    _id: c._id,
    number: c.number,
    kind: c.kind,
    displayName: c.displayName,
    status: c.status,
    roles: c.roles,
    parentName: parent?.displayName ?? null,
    city: billing?.address.city ?? null,
    countryCode: billing?.address.countryCode ?? null,
    email: primaryOf(channels, "email") ?? null,
    phone: primaryOf(channels, "phone") ?? primaryOf(channels, "mobile") ?? null,
    vatId: c.vatId ?? null,
    vatBadge: c.vatId ? vatBadge(c.vatIdStatus, lastCheck?.qualified, germanDate) : null,
    isConsumer: c.isConsumer,
    isPublicAuthority: c.isPublicAuthority,
    tags: tags.map((t) => ({ _id: t._id, name: t.name, color: t.color ?? null })),
    ...(figures ?? (await figuresOf(ctx, c._id))),
  };
}

/** CON-153 columns „Offen“ / „Umsatz (Jahr)“ of one contact (CON-150 definitions). */
async function figuresOf(ctx: QueryCtx, id: Id<"contacts">) {
  const s = await contactStats(ctx, id, berlinCalendarDate(ctx.now()));
  return { openCents: s.openCents, revenueYearCents: s.revenueThisYearCents };
}

/** CON-153: figures of every contact (persons fold into their organisation, merged contacts into the winner). */
async function rankingFigures(ctx: QueryCtx, today: CalendarDate) {
  const contacts = new Map((await ctx.db.query("contacts").collect()).map((c) => [c._id as string, c]));
  const rootOf = (id: string) => {
    let c = contacts.get(id);
    for (let i = 0; c && i < 10; i++) {
      const next = c.mergedIntoId ?? (c.kind === "person" ? c.parentId : undefined);
      if (!next) break;
      c = contacts.get(next);
    }
    return (c?._id as string | undefined) ?? id;
  };
  const docs: RankedDocument[] = [];
  for (const d of await ctx.db.query("salesDocuments").collect()) {
    if (d.status === "draft" || !d.documentDate || !d.contactId) continue;
    docs.push({ contactId: d.contactId, ...statsDocument(d) });
  }
  return contactRanking(docs, rootOf, today);
}

/** CON-172/173 list with search and filters (filters in the URL, 04 §4.1). */
export const list = query({
  permission: "contacts.read",
  args: { paginationOpts: paginationOptsValidator, ...listArgs },
  handler: async (ctx, { paginationOpts, ...f }) => {
    const page = await filter(baseQuery(ctx, f), (c) => matches(ctx, c, f)).paginate(paginationOpts);
    return { ...page, page: await Promise.all(page.page.map((c) => listRow(ctx, c))) };
  },
});

/**
 * CON-153: the list sorted by „Offen“ or „Umsatz (Jahr)“ over all contacts matching the list filters (top `limit`,
 * default 200). The top-customers view uses the same query (`sortBy: "revenueYear"`, small `limit`).
 */
export const ranking = query({
  permission: "contacts.read",
  args: {
    ...listArgs,
    sortBy: v.union(v.literal("open"), v.literal("revenueYear")),
    dir: v.union(v.literal("asc"), v.literal("desc")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { sortBy, dir, limit, ...f }) => {
    const figures = await rankingFigures(ctx, berlinCalendarDate(ctx.now()));
    const contacts = await filter(baseQuery(ctx, f), (c) => matches(ctx, c, f)).collect();
    const byId = new Map(contacts.map((c) => [c._id as string, c]));
    const rows = contacts.map((c) => ({
      contactId: c._id as string,
      displayName: c.displayName,
      openCents: figures.get(c._id)?.openCents ?? 0,
      revenueYearCents: figures.get(c._id)?.revenueYearCents ?? 0,
    }));
    const top = sortRanking(rows, sortBy, dir, Math.max(1, Math.min(limit ?? 200, 500)));
    return Promise.all(
      top.map((r) =>
        listRow(ctx, byId.get(r.contactId) as Doc<"contacts">, {
          openCents: r.openCents,
          revenueYearCents: r.revenueYearCents,
        }),
      ),
    );
  },
});

/** Contact picker (parent organisation, customer prices, documents later): non-archived matches. */
export const options = query({
  permission: "contacts.read",
  args: { q: v.optional(v.string()), kind: v.optional(v.union(v.literal("organization"), v.literal("person"))) },
  handler: async (ctx, { q, kind }) => {
    const f: ListFilter = { status: "open", ...(q ? { q } : {}), ...(kind ? { kind } : {}) };
    const rows = await filter(baseQuery(ctx, f), (c) => matches(ctx, c, f)).take(20);
    return rows.map((c) => ({ _id: c._id, number: c.number, displayName: c.displayName, kind: c.kind }));
  },
});

/** Preview of the next automatic number („wird automatisch vergeben“, CON-003). */
export const nextNumber = query({
  permission: "contacts.read",
  args: {},
  handler: async (ctx) => {
    const range = (await listDefaultRanges(ctx)).find((r) => r.docTypes.includes("contact"));
    if (!range) return null;
    const today = berlinCalendarDate(ctx.now());
    const ym = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
    return render(range.format, ym, await nextValue(ctx, range, ym));
  },
});

/** Contact page: everything the tabs need in one subscription. */
export const get = query({
  permission: "contacts.read",
  args: { id: v.id("contacts") },
  handler: async (ctx, { id }) => {
    const c = await ctx.db.get(id);
    if (!c) return null;
    const cc = await companyContext(ctx, ctx.now());
    const addresses = (await contactAddresses(ctx, id)).filter((a) => a.archivedAt === undefined);
    const channels = await contactChannels(ctx, id);
    const activities = (await contactActivities(ctx, id)).sort((a, b) => b._creationTime - a._creationTime);
    const persons = await childPersons(ctx, id);
    const parent = c.parentId ? await ctx.db.get(c.parentId) : null;
    const parentChannels = parent ? await contactChannels(ctx, parent._id) : null;
    const checks = await contactChecks(ctx, id);
    const lastCheck = c.vatIdStatus ? checks.find((x) => x._id === c.vatIdStatus?.lastCheckId) : undefined;
    const billing = defaultAddressOf(addresses, "billing");
    const delivery = defaultAddressOf(addresses, "delivery");
    const tags = (await Promise.all(c.tags.map((t) => ctx.db.get(t)))).filter((t): t is Doc<"tags"> => t !== null);
    const mergedInto = c.mergedIntoId ? await ctx.db.get(c.mergedIntoId) : null;
    const merges = (
      await ctx.db
        .query("contactMerges")
        .withIndex("by_winner", (q) => q.eq("winnerId", id))
        .collect()
    ).filter((m) => m.undoneAt === undefined);
    const mergeRows = await Promise.all(merges.map(async (m) => ({ ...m, loser: await ctx.db.get(m.loserId) })));
    const paymentMethod = c.paymentMethodId ? await ctx.db.get(c.paymentMethodId) : null;
    const invoiceEmails = channels.filter((ch) => ch.isInvoiceEmail).map((ch) => ch.value);
    const taxProfile = deriveTaxProfile({
      isConsumer: c.isConsumer,
      isPublicAuthority: c.isPublicAuthority,
      vatId: c.vatId,
      vatIdStatus: c.vatIdStatus,
      billingCountry: billing?.address.countryCode,
      deliveryCountry: delivery?.address.countryCode,
      companyIsKleinunternehmer: cc.kleinunternehmer,
      defaultTaxCase: c.defaultTaxCase as TaxCase | undefined,
      today: cc.today,
    });
    const hints = c.mergedIntoId
      ? []
      : await duplicateHintsFor(ctx, {
          id,
          displayName: c.displayName,
          vatId: c.vatId,
          invoiceEmails,
          iban: c.iban,
          postalCode: billing?.address.postalCode,
        });
    // CON-120 Verlauf: manual activities + derived events (VAT checks, consents, certificates, merges).
    const derived = [
      ...checks.map((x) => ({
        kind: "vat_check" as const,
        at: x.checkedAt,
        text: `USt-IdNr ${x.vatId} geprüft: ${x.message ?? x.status}`,
      })),
      ...c.einvoice.pdfConsents.map((x) => ({
        kind: "consent" as const,
        at: x.recordedAt,
        text: `Zustimmung zu PDF-Rechnungen erfasst (gegeben am ${formatGermanDate(x.givenAt as never)})${x.revokedAt ? `, widerrufen am ${formatGermanDate(x.revokedAt as never)}` : ""}`,
      })),
      ...c.reverseCharge13bCertificates.map((x) => ({
        kind: "certificate" as const,
        at: x.addedAt,
        text: `Bescheinigung USt 1 TG hinterlegt (gültig bis ${formatGermanDate(x.validUntil as never)})`,
      })),
      ...mergeRows.map((m) => ({
        kind: "merge" as const,
        at: m.at,
        text: `Kontakt ${m.loser?.number ?? ""} ${m.loser?.displayName ?? ""} zusammengeführt`,
      })),
    ];
    return {
      contact: c,
      addresses,
      channels,
      activities,
      derived: derived.sort((a, b) => b.at - a.at),
      persons: persons.map((p) => ({
        _id: p._id,
        number: p.number,
        displayName: p.displayName,
        position: p.position ?? null,
        status: p.status,
      })),
      parent: parent ? { _id: parent._id, number: parent.number, displayName: parent.displayName } : null,
      mergedInto: mergedInto
        ? { _id: mergedInto._id, number: mergedInto.number, displayName: mergedInto.displayName }
        : null,
      merges: mergeRows.map((m) => ({
        _id: m._id,
        at: m.at,
        loser: m.loser ? { _id: m.loser._id, number: m.loser.number, displayName: m.loser.displayName } : null,
        moved: m.moved.length,
      })),
      checks,
      vatBadge: vatBadge(c.vatIdStatus, lastCheck?.qualified, germanDate),
      taxProfile,
      invoiceRecipients: invoiceRecipients(channels, parentChannels),
      electronicAddress: effectiveElectronicAddress({ ...c, invoiceEmails }),
      certificate: currentCertificate(c.reverseCharge13bCertificates) ?? null,
      tags: tags.map((t) => ({ _id: t._id, name: t.name, color: t.color ?? null })),
      paymentMethod: paymentMethod ? { _id: paymentMethod._id, name: paymentMethod.name } : null,
      duplicateHints: hints,
      // CON-150: statistics over the finalised documents of the contact, its persons and merged aliases.
      stats: await contactStats(ctx, id, cc.today),
      deleteBlockedBy: await blockingReferences(ctx, id),
      today: cc.today,
    };
  },
});

/** CON-130 hints while typing in the create/edit form (non-blocking). */
export const duplicateHints = query({
  permission: "contacts.read",
  args: {
    id: v.optional(v.id("contacts")),
    displayName: v.string(),
    vatId: v.optional(v.string()),
    email: v.optional(v.string()),
    iban: v.optional(v.string()),
    postalCode: v.optional(v.string()),
  },
  handler: async (ctx, a) =>
    duplicateHintsFor(ctx, {
      ...(a.id ? { id: a.id } : {}),
      displayName: a.displayName,
      vatId: a.vatId?.toUpperCase().replace(/[\s.-]/g, "") || undefined,
      invoiceEmails: a.email ? [a.email.trim().toLowerCase()] : [],
      iban: a.iban?.toUpperCase().replace(/\s/g, "") || undefined,
      postalCode: a.postalCode || undefined,
    }),
});

// ── writes ────────────────────────────────────────────────────────────────────────────────────────────
export const create = mutation({
  permission: "contacts.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) => {
    const r = await createContact(ctx, parse(contactCreateSchema, values));
    return { id: r.id, number: r.number, warnings: r.warnings.map((w) => w.message) };
  },
});

export const update = mutation({
  permission: "contacts.write",
  args: { id: v.id("contacts"), version: v.number(), values: v.any() },
  handler: async (ctx, { id, version, values }) => {
    const r = await updateContact(ctx, id, version, parse(contactSchema, values));
    return { warnings: r.warnings.map((w) => w.message), vatIdChanged: r.vatIdChanged };
  },
});

/** F04 §4.9 INV-16: Gutschriftsvereinbarung of a supplier (null removes it). */
export const setSelfBillingAgreement = mutation({
  permission: "contacts.write",
  args: {
    id: v.id("contacts"),
    agreement: v.union(
      v.null(),
      v.object({
        agreedOn: v.string(),
        scope: v.string(),
        validFrom: v.string(),
        validTo: v.optional(v.string()),
        file: v.optional(vFileRef),
        supplierKleinunternehmer: v.optional(v.boolean()),
        iban: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { id, agreement }) => setSelfBillingAgreementModel(ctx, id, agreement),
});

export const archive = mutation({
  permission: "contacts.write",
  args: { id: v.id("contacts") },
  handler: async (ctx, { id }) => setArchived(ctx, id, true),
});

export const unarchive = mutation({
  permission: "contacts.write",
  args: { id: v.id("contacts") },
  handler: async (ctx, { id }) => setArchived(ctx, id, false),
});

export const remove = mutation({
  permission: "contacts.write",
  args: { id: v.id("contacts") },
  handler: async (ctx, { id }) => deleteContact(ctx, id),
});

export const saveAddress = mutation({
  permission: "contacts.write",
  args: { contactId: v.id("contacts"), addressId: v.optional(v.id("contactAddresses")), values: v.any() },
  handler: async (ctx, { contactId, addressId, values }) =>
    saveAddressModel(ctx, contactId, parse(addressSchema, values), addressId),
});

export const removeAddress = mutation({
  permission: "contacts.write",
  args: { addressId: v.id("contactAddresses") },
  handler: async (ctx, { addressId }) => removeAddressModel(ctx, addressId),
});

export const saveChannel = mutation({
  permission: "contacts.write",
  args: { contactId: v.id("contacts"), channelId: v.optional(v.id("contactChannels")), values: v.any() },
  handler: async (ctx, { contactId, channelId, values }) =>
    saveChannelModel(ctx, contactId, parse(channelSchema, values), channelId),
});

export const removeChannel = mutation({
  permission: "contacts.write",
  args: { channelId: v.id("contactChannels") },
  handler: async (ctx, { channelId }) => removeChannelModel(ctx, channelId),
});

export const addActivity = mutation({
  permission: "contacts.write",
  args: { contactId: v.id("contacts"), values: v.any() },
  handler: async (ctx, { contactId, values }) => addActivityModel(ctx, contactId, parse(activitySchema, values)),
});

export const updateActivity = mutation({
  permission: "contacts.write",
  args: { activityId: v.id("contactActivities"), values: v.any() },
  handler: async (ctx, { activityId, values }) => updateActivityModel(ctx, activityId, parse(activitySchema, values)),
});

export const setTaskDone = mutation({
  permission: "contacts.write",
  args: { activityId: v.id("contactActivities"), done: v.boolean() },
  handler: async (ctx, { activityId, done }) => setTaskDoneModel(ctx, activityId, done),
});

export const removeActivity = mutation({
  permission: "contacts.write",
  args: { activityId: v.id("contactActivities") },
  handler: async (ctx, { activityId }) => removeActivityModel(ctx, activityId),
});

export const addPdfConsent = mutation({
  permission: "contacts.write",
  args: { contactId: v.id("contacts"), values: v.any() },
  handler: async (ctx, { contactId, values }) => addPdfConsentModel(ctx, contactId, parse(pdfConsentSchema, values)),
});

export const revokePdfConsent = mutation({
  permission: "contacts.write",
  args: { contactId: v.id("contacts"), revokedAt: v.string() },
  handler: async (ctx, { contactId, revokedAt }) => revokePdfConsentModel(ctx, contactId, revokedAt),
});

/** Upload URL for USt 1 TG certificates (CON-070). Writes nothing. */
export const generateUploadUrl = mutation({
  permission: "contacts.write",
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

export const addCertificate = mutation({
  permission: "contacts.write",
  args: {
    contactId: v.id("contacts"),
    validUntil: v.string(),
    storageId: v.optional(v.id("_storage")),
    fileName: v.optional(v.string()),
  },
  handler: async (ctx, { contactId, validUntil, storageId, fileName }) => {
    const { validUntil: date } = parse(certificateSchema, { validUntil });
    const r = await addCertificateModel(ctx, contactId, {
      validUntil: date,
      ...(storageId ? { storageId } : {}),
      ...(fileName ? { fileName } : {}),
    });
    return { warnings: r.warnings.map((w) => w.message) };
  },
});

// ── bulk (CON-174) ────────────────────────────────────────────────────────────────────────────────────
export const bulkTag = mutation({
  permission: "contacts.write",
  args: { ids: v.array(v.id("contacts")), tagId: v.id("tags"), add: v.boolean() },
  handler: async (ctx, { ids, tagId, add }) => bulkTagModel(ctx, ids, tagId, add),
});

export const bulkArchive = mutation({
  permission: "contacts.write",
  args: { ids: v.array(v.id("contacts")) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) await setArchived(ctx, id, true);
    return ids.length;
  },
});

// ── duplicates and merge (CON-131…135) ──────────────────────────────────────────────────────────────────
export const duplicates = query({
  permission: "contacts.read",
  args: {},
  handler: async (ctx) =>
    (await duplicatePairs(ctx)).map((p) => ({
      score: p.score,
      reasons: p.reasons,
      a: { _id: p.a._id, number: p.a.number, displayName: p.a.displayName, kind: p.a.kind },
      b: { _id: p.b._id, number: p.b.number, displayName: p.b.displayName, kind: p.b.kind },
    })),
});

export const dismissDuplicate = mutation({
  permission: "contacts.write",
  args: { a: v.id("contacts"), b: v.id("contacts") },
  handler: async (ctx, { a, b }) => dismissDuplicateModel(ctx, a, b),
});

export const mergePreview = query({
  permission: "contacts.read",
  args: { winnerId: v.id("contacts"), loserIds: v.array(v.id("contacts")) },
  handler: async (ctx, { winnerId, loserIds }) => {
    const all = await Promise.all([winnerId, ...loserIds].map((id) => getContact(ctx, id)));
    return { contacts: all, ...(await mergePreviewModel(ctx, loserIds)) };
  },
});

export const merge = mutation({
  permission: "contacts.merge",
  args: { values: v.any(), confirmToken: vConfirmToken },
  handler: async (ctx, { values }) => {
    const m = parse(mergeSchema, values);
    const id = (x: string) => {
      const n = ctx.db.normalizeId("contacts", x);
      if (!n) throw appError("not_found", "Kontakt nicht gefunden.");
      return n;
    };
    return mergeContacts(ctx, {
      winnerId: id(m.winnerId),
      loserIds: m.loserIds.map(id),
      fieldChoices: m.fieldChoices,
      confirmVatConflict: m.confirmVatConflict,
    });
  },
});

export const undoMerge = mutation({
  permission: "contacts.mergeUndo",
  args: { mergeId: v.id("contactMerges") },
  handler: async (ctx, { mergeId }) => undoMergeModel(ctx, mergeId),
});

// ── import / export (CON-140…143) ───────────────────────────────────────────────────────────────────────
const vImportRow = v.object({ rowNumber: v.number(), values: v.any() });

async function findMatch(
  ctx: QueryCtx,
  values: {
    contact: { number?: string; vatId?: string };
    channels: { type: string; value: string; isInvoiceEmail: boolean }[];
  },
) {
  // CON-141 match order: number → VAT ID → invoice e-mail.
  if (values.contact.number) {
    const hit = await ctx.db
      .query("contacts")
      .withIndex("by_number", (q) => q.eq("numberNormalized", normalizeContactNumber(values.contact.number as string)))
      .first();
    if (hit) return hit;
  }
  if (values.contact.vatId) {
    const hit = await ctx.db
      .query("contacts")
      .withIndex("by_vatId", (q) => q.eq("vatId", values.contact.vatId))
      .first();
    if (hit) return hit;
  }
  const email = values.channels.find((c) => c.type === "email" && c.isInvoiceEmail)?.value;
  if (email) {
    const ch = await ctx.db
      .query("contactChannels")
      .withIndex("by_type_value", (q) => q.eq("type", "email").eq("value", email))
      .first();
    if (ch) return ctx.db.get(ch.contactId);
  }
  return null;
}

/** CON-141 preview: per row neu / Aktualisierung / Konflikt / Fehler (rows validated with the UI schema). */
export const importPreview = query({
  permission: "contacts.write",
  args: { rows: v.array(vImportRow), mode: v.union(v.literal("create_only"), v.literal("create_and_update")) },
  handler: async (ctx, { rows, mode }) =>
    Promise.all(
      rows.map(async (r) => {
        const parsed = contactCreateSchema.safeParse(r.values);
        if (!parsed.success) {
          const i = parsed.error.issues[0];
          return { rowNumber: r.rowNumber, status: "error" as const, message: `${i?.path.join(".")}: ${i?.message}` };
        }
        const match = await findMatch(ctx, parsed.data);
        const s = classifyRow(
          match ? { id: match._id, number: match.number, restricted: match.dsgvo?.restrictedAt !== undefined } : null,
          mode,
          parsed.data.contact.number ?? "",
        );
        return { rowNumber: r.rowNumber, status: s.status, message: s.message ?? null, matchId: match?._id ?? null };
      }),
    ),
});

/**
 * CON-142 commit of up to 100 rows: idempotent through the match keys (a re-run updates the same contacts or skips
 * them in "nur neue anlegen"). The `imports`/`jobs` tables of F09 replace this batch call once they exist.
 */
export const importCommit = mutation({
  permission: "contacts.write",
  args: { rows: v.array(vImportRow), mode: v.union(v.literal("create_only"), v.literal("create_and_update")) },
  handler: async (ctx, { rows, mode }) => {
    if (rows.length > 100)
      throw appError("invalid_input", "Höchstens 100 Zeilen pro Aufruf.", { reason: "IMPORT_BATCH_TOO_LARGE" });
    const out: {
      rowNumber: number;
      status: "created" | "updated" | "skipped" | "error";
      message?: string;
      id?: Id<"contacts">;
    }[] = [];
    for (const r of rows) {
      const parsed = contactCreateSchema.safeParse(r.values);
      if (!parsed.success) {
        out.push({
          rowNumber: r.rowNumber,
          status: "error",
          message: parsed.error.issues[0]?.message ?? "Ungültige Zeile.",
        });
        continue;
      }
      const match = await findMatch(ctx, parsed.data);
      const s = classifyRow(
        match ? { id: match._id, number: match.number, restricted: match.dsgvo?.restrictedAt !== undefined } : null,
        mode,
        parsed.data.contact.number ?? "",
      );
      try {
        if (s.status === "new") {
          const created = await createContact(ctx, parsed.data);
          out.push({ rowNumber: r.rowNumber, status: "created", id: created.id });
        } else if (s.status === "update" && match) {
          await updateContact(ctx, match._id, match.version, { ...parsed.data.contact, number: match.number });
          if (parsed.data.billingAddress && !defaultAddressOf(await contactAddresses(ctx, match._id), "billing")) {
            await saveAddressModel(ctx, match._id, { ...parsed.data.billingAddress, type: "billing", isDefault: true });
          }
          out.push({ rowNumber: r.rowNumber, status: "updated", id: match._id });
        } else {
          out.push({ rowNumber: r.rowNumber, status: "skipped", message: s.message ?? "Übersprungen." });
        }
      } catch (e) {
        const data = (e as { data?: { message?: string } }).data;
        out.push({ rowNumber: r.rowNumber, status: "error", message: data?.message ?? String(e) });
      }
    }
    return out;
  },
});

/** CON-143 export rows of the current filter (restricted contacts only with `includeRestricted`). */
export const exportRows = query({
  permission: "contacts.read",
  args: { ...listArgs, includeRestricted: v.optional(v.boolean()) },
  handler: async (ctx, { includeRestricted, ...f }) => {
    const rows: string[][] = [[...CONTACT_EXPORT_HEADERS]];
    const contacts = await filter(baseQuery(ctx, f), (c) => matches(ctx, c, f)).take(20_000);
    for (const c of contacts) {
      if (c.dsgvo?.restrictedAt !== undefined && !includeRestricted) continue;
      const channels = await contactChannels(ctx, c._id);
      const billing = defaultAddressOf(await contactAddresses(ctx, c._id), "billing");
      const lastCheck = c.vatIdStatus ? await ctx.db.get(c.vatIdStatus.lastCheckId) : null;
      const tags = (await Promise.all(c.tags.map((t) => ctx.db.get(t)))).filter((t): t is Doc<"tags"> => t !== null);
      rows.push(
        contactExportRow({
          ...c,
          billing: billing?.address,
          primaryEmail: primaryOf(channels, "email"),
          primaryPhone: primaryOf(channels, "phone") ?? primaryOf(channels, "mobile"),
          invoiceEmails: channels.filter((ch) => ch.isInvoiceEmail).map((ch) => ch.value),
          vatStatusText: c.vatId ? vatBadge(c.vatIdStatus, lastCheck?.qualified, germanDate).text : "",
          dueDays: c.paymentTerms?.dueDays,
          tagNames: tags.map((t) => t.name),
        }),
      );
    }
    return rows;
  },
});

/** CON-150: finalised sales documents of the contact, its persons and the contacts merged into it (CON-133). */
async function contactStats(ctx: QueryCtx, id: Id<"contacts">, today: CalendarDate) {
  const ids = new Set<Id<"contacts">>([id]);
  for (const p of await childPersons(ctx, id)) ids.add(p._id);
  for (const m of await ctx.db
    .query("contactMerges")
    .withIndex("by_winner", (q) => q.eq("winnerId", id))
    .collect()) {
    if (m.undoneAt === undefined) ids.add(m.loserId);
  }
  const docs: StatsDocument[] = [];
  for (const cid of ids) {
    for (const d of await ctx.db
      .query("salesDocuments")
      .withIndex("by_contact", (q) => q.eq("contactId", cid))
      .collect()) {
      if (d.status === "draft" || !d.documentDate) continue;
      docs.push(statsDocument(d));
    }
  }
  return computeContactStats(docs, today);
}

function statsDocument(d: Doc<"salesDocuments">): StatsDocument {
  return {
    docType: d.type as StatsDocType,
    documentDate: d.documentDate as CalendarDate,
    ...(d.dueDate ? { dueDate: d.dueDate as CalendarDate } : {}),
    netCents: d.totals.netCents,
    grossCents: d.totals.grossCents,
    ...(d.openAmountCents !== undefined ? { openAmountCents: d.openAmountCents } : {}),
    ...(d.paymentStatus ? { paymentStatus: d.paymentStatus } : {}),
    currency: d.currency,
    ...(d.fxRateToEur ? { fxRateToEur: d.fxRateToEur.rate } : {}),
  };
}
