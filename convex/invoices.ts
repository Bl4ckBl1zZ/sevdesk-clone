import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { filter } from "convex-helpers/server/filter";
import { normalizeSearchQuery } from "../src/domain/contacts/core";
import { defaultMarkSelection, effectiveMark, exportEntriesFor } from "../src/domain/documents/dispatch";
import { DRAFT_TYPES, type DraftType, isLetterType } from "../src/domain/documents/doc-types";
import type { DraftDocument } from "../src/domain/documents/draft";
import { canonicalSnapshotJson } from "../src/domain/documents/snapshot";
import { blocking, type Finding, validateDocument } from "../src/domain/documents/validate";
import { resolvePrice } from "../src/domain/products/pricing";
import { draftSchema, markSentSchema, retractMarkSchema } from "../src/domain/schemas/documents";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { type CalendarDate, isCalendarDate } from "../src/domain/time/calendar-date";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { action, actorMutation, mutation, query, systemMutation, systemQuery, vConfirmToken } from "./functions";
import { isTest } from "./lib/env";
import { appError } from "./lib/errors";
import { runFinalizePipeline } from "./lib/finalizePipeline";
import { parse } from "./lib/parse";
import { defaultInvoiceAccount } from "./model/bankAccounts";
import { getCompanyProfile } from "./model/companyProfile";
import { getContact } from "./model/contacts";
import { runQuoteDeadlines } from "./model/documentFlows";
import { listPaymentMethods } from "./model/lookups";
import {
  archivedArtifacts,
  checkMarkSent,
  commitFinalization,
  createDraft as createDraftModel,
  deleteDraft as deleteDraftModel,
  displayStatusOf,
  documentArtifacts,
  documentLines,
  draftFromDoc,
  duplicateDocument,
  type FinalizeOptions,
  finalizePreview,
  getDocument,
  lastExportArtifactIds,
  loadDocumentContext,
  markSent as markSentModel,
  notifyExportedNotMarked,
  openTodos,
  orphanedArtifactRenders,
  readContact,
  recordArtifactFailure,
  recordArtifacts,
  recordExport,
  restartArtifacts,
  retractMark as retractMarkModel,
  sendLogOf,
  sendLogRows,
  snapshotOf,
  updateDraft as updateDraftModel,
  validateStored,
  withPaymentDefaults,
} from "./model/salesDocuments";

/**
 * Rechnungen (F04, P1 invoices core): drafts, compliance panel, finalisation pipeline (02 §6), export and the
 * manual sent mark (SND). UI today; REST/MCP reuse these functions and the shared zod schemas. All writes go through
 * convex/model/salesDocuments.ts.
 */

const vFinalizeOptions = {
  documentDate: v.optional(v.string()),
  backdateReason: v.optional(v.string()),
  overrides: v.optional(
    v.object({
      vatCheck: v.optional(v.object({ reason: v.string() })),
      rc13bCertificate: v.optional(v.object({ reason: v.string() })),
    }),
  ),
};

const optionsOf = (a: {
  documentDate?: string;
  backdateReason?: string;
  overrides?: FinalizeOptions["overrides"];
}) => ({
  ...(a.documentDate ? { documentDate: a.documentDate } : {}),
  ...(a.backdateReason ? { backdateReason: a.backdateReason } : {}),
  ...(a.overrides ? { overrides: a.overrides } : {}),
});

const findingsValue = (fs: readonly Finding[]) =>
  fs.map((f) => ({
    code: f.code,
    severity: f.severity,
    message: f.message,
    rule: f.rule,
    group: f.group,
    ...(f.field ? { field: f.field } : {}),
    ...(f.overridable ? { overridable: true } : {}),
  }));

// ── list (DOC-37) ────────────────────────────────────────────────────────────────────────────────────────

/** The documents of the „Rechnungen“ area (F04 §6.1): invoice family, Storno and corrections. */
const INVOICE_LIKE: readonly Doc<"salesDocuments">["type"][] = [
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
  "cancellation",
  "correction",
];
const isInvoiceLike = (d: Pick<Doc<"salesDocuments">, "type">) => INVOICE_LIKE.includes(d.type);

const TABS = [
  "all",
  "draft",
  "unsent",
  "open",
  "overdue",
  "paid",
  "exported_not_marked",
  // quotes, orders, delivery notes (F04 §6.1)
  "accepted",
  "rejected",
  "expired",
  "partially_invoiced",
  "invoiced",
  "received",
] as const;
type Tab = (typeof TABS)[number];

const vListType = v.union(...DRAFT_TYPES.map((t) => v.literal(t)));

function tabMatches(d: Doc<"salesDocuments">, tab: Tab, today: string): boolean {
  const s = displayStatusOf(d, today).token;
  if (isLetterType(d.type) && tab === "open") return d.status === "finalized" || d.status === "sent";
  switch (tab) {
    case "draft":
      return d.status === "draft";
    case "accepted":
      return d.status === "accepted" && d.type === "quote";
    case "received":
      return d.status === "accepted" && d.type === "delivery_note";
    case "rejected":
    case "expired":
    case "partially_invoiced":
    case "invoiced":
      return d.status === tab;
    case "unsent":
      return s === "unsent";
    case "open":
      return s === "open" || s === "overdue" || s === "partially_paid";
    case "overdue":
      return s === "overdue";
    case "paid":
      return s === "paid";
    case "exported_not_marked":
      return d.status === "finalized" && d.firstExportedAt !== undefined;
    default:
      return true;
  }
}

/** The Rechnungen list (type `invoice`) shows the whole invoice family; the other lists show one type. */
function baseQuery(ctx: QueryCtx, q: string, type: DraftType) {
  if (type === "invoice") {
    if (q) return ctx.db.query("salesDocuments").withSearchIndex("search", (s) => s.search("contactName", q));
    return ctx.db.query("salesDocuments").order("desc");
  }
  if (q)
    return ctx.db.query("salesDocuments").withSearchIndex("search", (s) => s.search("contactName", q).eq("type", type));
  return ctx.db
    .query("salesDocuments")
    .withIndex("by_type_status_date", (i) => i.eq("type", type))
    .order("desc");
}

/** DOC-37 list of one document type (default: invoices; quotes, orders, delivery notes and proforma, F04 §6.1). */
export const list = query({
  permission: "documents.read",
  args: {
    paginationOpts: paginationOptsValidator,
    tab: v.optional(v.string()),
    q: v.optional(v.string()),
    type: v.optional(vListType),
  },
  handler: async (ctx, { paginationOpts, tab, q, type: typeArg }) => {
    const type = typeArg ?? "invoice";
    const today = berlinCalendarDate(ctx.now());
    const t = (TABS as readonly string[]).includes(tab ?? "") ? (tab as Tab) : "all";
    const query = q?.trim() ?? "";
    const numberHit = query
      ? await ctx.db
          .query("salesDocuments")
          .withIndex("by_number", (i) => i.eq("number", query.toUpperCase()))
          .first()
      : null;
    const inList = (d: Doc<"salesDocuments">) => (type === "invoice" ? isInvoiceLike(d) : d.type === type);
    const page = await filter(
      baseQuery(ctx, query ? normalizeSearchQuery(query) : "", type),
      (d) => inList(d) && tabMatches(d, t, today),
    ).paginate(paginationOpts);
    const hit = numberHit && inList(numberHit) ? numberHit : null;
    const rows = [...(hit && !page.page.some((d) => d._id === hit._id) ? [hit] : []), ...page.page].map((d) => ({
      _id: d._id,
      type: d.type,
      correctionKind: d.correctionKind ?? null,
      number: d.number ?? null,
      contactName: d.contactName ?? null,
      documentDate: d.documentDate ?? null,
      dueDate: d.dueDate ?? null,
      grossCents: d.totals.grossCents,
      openAmountCents: d.openAmountCents ?? null,
      currency: d.currency,
      status: d.status,
      displayStatus: displayStatusOf(d, today),
      exported: d.firstExportedAt !== undefined,
      artifactStatus: d.artifactStatus ?? null,
      validUntil: d.validUntil ?? null,
      supplyDate: d.supplyDate ?? null,
      orderReference: d.orderReference ?? null,
      coveredBp: d.coverage?.coveredBp ?? null,
      updatedAt: d._creationTime,
    }));
    return { ...page, page: rows };
  },
});

// ── detail (DOC-20 compliance panel, §6.4) ───────────────────────────────────────────────────────────────

export const get = query({
  permission: "documents.read",
  args: { id: v.id("salesDocuments") },
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get(id);
    if (!doc || !(isInvoiceLike(doc) || isLetterType(doc.type))) return null;
    const now = ctx.now();
    const today = berlinCalendarDate(now);
    const lines = (await documentLines(ctx, id)).sort((a, b) => a.position - b.position);
    const productChanged: string[] = [];
    for (const l of lines) {
      if (!l.productId || doc.status !== "draft") continue;
      const p = await ctx.db.get(l.productId);
      if (p && l.productSyncedVersion !== undefined && p.version > l.productSyncedVersion) productChanged.push(l._id);
    }
    const base = {
      doc,
      lines,
      displayStatus: displayStatusOf(doc, today),
      today,
      productChanged,
    };
    if (doc.status === "draft") {
      const { result, loaded } = await validateStored(ctx, doc, now);
      const { billingAddress: _b, ...values } = draftFromDoc(doc, lines);
      return {
        ...base,
        values,
        findings: findingsValue(result.findings),
        canFinalize: blocking(result.findings).length === 0,
        resolved: {
          taxCase: result.resolved.taxCase,
          taxCaseRow: result.resolved.derivation.kind === "ok" ? result.resolved.derivation.row : null,
          taxCaseReasons: result.resolved.derivation.kind === "ok" ? result.resolved.derivation.reasons : [],
          categoriesAllowed:
            result.resolved.derivation.kind === "ok" ? result.resolved.derivation.categoriesAllowed : [],
          documentDate: result.resolved.documentDate,
          lines: result.resolved.lines.map((l) => ({
            index: l.index,
            vatCategory: l.vatCategory,
            vatRateBp: l.vatRateBp,
          })),
          totals: result.resolved.totals
            ? {
                netCents: result.resolved.totals.taxExclusiveCents,
                vatCents: result.resolved.totals.vatTotalCents,
                grossCents: result.resolved.totals.grossCents,
                payableCents: result.resolved.totals.payableCents,
                groups: result.resolved.totals.groups.map((g) => ({
                  category: g.vatCategory,
                  rateBp: g.rateBp,
                  baseCents: g.baseCents,
                  vatCents: g.vatCents,
                })),
                lineNets: result.resolved.itemNetCents.map((n) => n ?? null),
              }
            : null,
        },
        einvoice: {
          decision: result.einvoice.er03.decision,
          reason: result.einvoice.er03.reason,
          format: result.einvoice.format,
          allowed: result.einvoice.formatDecision.allowed,
          notice: result.einvoice.formatDecision.notice ?? null,
        },
        buyer: loaded.ctx.contact?.buyer ?? null,
        snapshot: null,
        artifacts: [],
        sendLog: [],
        effectiveMarkId: null,
        exportEntries: [],
        defaultMarkSelection: [],
        register: null,
      };
    }
    const snapshot = await snapshotOf(ctx, doc);
    const artifacts = await documentArtifacts(ctx, id);
    const log = await sendLogOf(ctx, id);
    const effective = effectiveMark(sendLogRows(log));
    const register = doc.number
      ? await ctx.db
          .query("numberRegister")
          .withIndex("by_normalized", (q) => q.eq("normalized", (doc.number ?? "").toUpperCase()))
          .first()
      : null;
    const format = doc.einvoice.format ?? "none";
    return {
      ...base,
      findings: [],
      canFinalize: false,
      resolved: null,
      einvoice: { decision: doc.einvoice.decision ?? null, reason: null, format, allowed: [], notice: null },
      buyer: snapshot?.buyer ?? null,
      snapshot,
      artifacts: artifacts.map((a) => ({
        _id: a._id,
        kind: a.kind,
        variant: a.variant ?? "original",
        name: a.name,
        sha256: a.sha256,
        bytes: a.bytes,
        createdAt: a.createdAt,
      })),
      sendLog: log.map((r) => ({
        _id: r._id,
        kind: r.kind,
        sentOn: r.sentOn,
        channel: r.channel,
        note: r.note ?? null,
        retractsId: r.retractsId ?? null,
        artifacts: r.artifacts,
        einvoiceHandedOverElectronically: r.einvoiceHandedOverElectronically ?? false,
        at: r.at,
        actor: r.actor,
      })),
      effectiveMarkId: effective?.id ?? null,
      exportEntries: exportEntriesFor(format),
      defaultMarkSelection: defaultMarkSelection(
        format,
        archivedArtifacts(artifacts),
        await lastExportArtifactIds(ctx, id),
      ),
      register: register
        ? {
            number: register.number,
            status: register.status,
            assignedAt: register.assignedAt,
            periodKey: register.periodKey ?? null,
          }
        : null,
    };
  },
});

/** Live check of unsaved editor values (DOC-19/20/42): totals, tax case, findings — nothing is written. */
export const check = query({
  permission: "documents.read",
  args: { values: v.any(), id: v.optional(v.id("salesDocuments")) },
  handler: async (ctx, { values, id }) => {
    const parsed = draftSchema.safeParse(values);
    if (!parsed.success) return null;
    const draftValues = await withPaymentDefaults(ctx, parsed.data);
    const now = ctx.now();
    const probe = {
      ...(id ? await getDocument(ctx, id) : {}),
      _id: id ?? ("new" as Id<"salesDocuments">),
      type: draftValues.type,
      status: "draft",
      ...(draftValues.chainOrder ? { chainOrder: draftValues.chainOrder } : {}),
      // The turnover monitors look at the supply year of the edited values (KU-01, TAX-017).
      ...(draftValues.supplyDate ? { supplyDate: draftValues.supplyDate } : {}),
      ...(draftValues.contactId ? { contactId: draftValues.contactId as Id<"contacts"> } : { contactId: undefined }),
      ...(draftValues.bankAccountId
        ? { bankAccountId: draftValues.bankAccountId as Id<"bankAccounts"> }
        : { bankAccountId: undefined }),
      ...(draftValues.paymentMethodId
        ? { paymentMethodId: draftValues.paymentMethodId as Id<"paymentMethods"> }
        : { paymentMethodId: undefined }),
    } as Doc<"salesDocuments">;
    const loaded = await loadDocumentContext(ctx, probe, now);
    const draft: DraftDocument = {
      ...(draftValues as unknown as DraftDocument),
      // Not part of the editable values (set when the correction draft is created, INV-12/13).
      ...(probe.correctionKind ? { correctionKind: probe.correctionKind } : {}),
      ...(loaded.contact?.context.buyer.address ? { billingAddress: loaded.contact.context.buyer.address } : {}),
      // DOC-23: the contact's default delivery address while the draft names none (same as the commit).
      ...(!draftValues.deliveryAddress && loaded.contact?.defaultDelivery
        ? { deliveryAddress: loaded.contact.defaultDelivery }
        : {}),
    };
    const r = validateDocument(draft, loaded.ctx);
    const t = r.resolved.totals;
    return {
      findings: findingsValue([...r.findings, ...(loaded.contact?.warnings ?? [])]),
      canFinalize: blocking(r.findings).length === 0,
      taxCase: r.resolved.taxCase,
      taxCaseReasons: r.resolved.derivation.kind === "ok" ? r.resolved.derivation.reasons : [],
      categoriesAllowed: r.resolved.derivation.kind === "ok" ? r.resolved.derivation.categoriesAllowed : [],
      lines: r.resolved.lines.map((l) => ({ index: l.index, vatCategory: l.vatCategory, vatRateBp: l.vatRateBp })),
      totals: t
        ? {
            netCents: t.taxExclusiveCents,
            vatCents: t.vatTotalCents,
            grossCents: t.grossCents,
            payableCents: t.payableCents,
            groups: t.groups.map((g) => ({
              category: g.vatCategory,
              rateBp: g.rateBp,
              baseCents: g.baseCents,
              vatCents: g.vatCents,
            })),
            lineNets: r.resolved.itemNetCents.map((n) => n ?? null),
          }
        : null,
      einvoice: {
        decision: r.einvoice.er03.decision,
        reason: r.einvoice.er03.reason,
        format: r.einvoice.format,
        allowed: r.einvoice.formatDecision.allowed,
        notice: r.einvoice.formatDecision.notice ?? null,
      },
      buyer: loaded.ctx.contact?.buyer ?? null,
      documentDate: r.resolved.documentDate,
    };
  },
});

/** Defaults for a new draft or a newly chosen contact (§4.4 item 1, DOC-08, DOC-16). */
export const draftDefaults = query({
  permission: "documents.read",
  args: { contactId: v.optional(v.id("contacts")) },
  handler: async (ctx, { contactId }) => {
    const profile = await getCompanyProfile(ctx);
    const contact = contactId ? await getContact(ctx, contactId) : null;
    const methods = await listPaymentMethods(ctx);
    const method =
      (contact?.paymentMethodId ? methods.find((m) => m._id === contact.paymentMethodId) : undefined) ??
      methods.find((m) => m.isDefault && m.active);
    const bank = await defaultInvoiceAccount(ctx, contact?.currency ?? "EUR");
    const terms = contact?.paymentTerms ?? profile?.defaults.paymentTerms ?? { dueDays: 14 };
    return {
      currency: contact?.currency ?? "EUR",
      language: contact?.language ?? profile?.defaults.language ?? "de",
      priceMode: contact?.isConsumer ? ("gross" as const) : (profile?.defaults.priceMode ?? "net"),
      paymentTerms: terms,
      paymentMethodId: method?._id ?? null,
      bankAccountId: bank?._id ?? null,
      defaultDiscountBp: contact?.defaultDiscountBp ?? null,
      buyerReference: contact?.buyerReference ?? null,
      showEpcQr: true,
      today: berlinCalendarDate(ctx.now()),
      contact: contact
        ? {
            _id: contact._id,
            displayName: contact.displayName,
            isConsumer: contact.isConsumer,
            isPublicAuthority: contact.isPublicAuthority,
            hasInvoiceEmail: !!(await readContact(ctx, contact._id)).context.buyer.invoiceEmail,
          }
        : null,
    };
  },
});

/**
 * DOC-05/DOC-06: the values a picked product copies into a line — customer price (own, then parent organisation)
 * → product price, converted to the document price mode at the rate of the reference date; contact discount.
 */
export const productLine = query({
  permission: "documents.read",
  args: {
    productId: v.id("products"),
    contactId: v.optional(v.id("contacts")),
    referenceDate: v.string(),
    priceMode: v.union(v.literal("net"), v.literal("gross")),
    currency: v.string(),
    fxRate: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const p = await ctx.db.get(a.productId);
    if (!p) throw appError("not_found", "Produkt nicht gefunden.");
    if (!isCalendarDate(a.referenceDate)) throw appError("invalid_input", "Ungültiges Datum.");
    const contact = a.contactId ? await ctx.db.get(a.contactId) : null;
    const profile = await getCompanyProfile(ctx);
    const prices = await ctx.db
      .query("customerPrices")
      .withIndex("by_product_contact_validFrom", (q) => q.eq("productId", a.productId))
      .collect();
    const r = resolvePrice(
      {
        id: p._id,
        active: p.active,
        unitCode: p.unitCode,
        priceMode: p.priceMode,
        unitPriceMicros: p.unitPriceMicros,
        ...(p.scheduledPrice ? { scheduledPrice: p.scheduledPrice } : {}),
        ...(p.purchasePriceMicros !== undefined ? { purchasePriceMicros: p.purchasePriceMicros } : {}),
        vatRateKey: p.vatRateKey,
        extraUnits: p.extraUnits,
      },
      {
        ...(contact ? { contactId: contact._id } : {}),
        ...(contact?.parentId ? { parentContactId: contact.parentId } : {}),
        customerPrices: prices.map((c) => ({
          contactId: c.contactId,
          unitPriceMicros: c.unitPriceMicros,
          priceMode: c.priceMode,
          ...(c.validFrom ? { validFrom: c.validFrom } : {}),
        })),
        referenceDate: a.referenceDate as CalendarDate,
        documentPriceMode: a.priceMode,
        documentCurrency: a.currency,
        ...(a.fxRate ? { fxRate: a.fxRate } : {}),
        ...(contact?.defaultDiscountBp ? { contactDiscountBp: contact.defaultDiscountBp } : {}),
        discountOnCustomerPrices: profile?.defaults.discountOnCustomerPrices ?? false,
      },
    );
    if (!r.ok) throw appError("invalid_input", r.error.message, { reason: r.error.code });
    return {
      line: {
        kind: "item" as const,
        productId: p._id,
        productType: p.type,
        productSyncedVersion: p.version,
        name: p.name,
        ...(p.description ? { description: p.description } : {}),
        quantityMilli: 1_000,
        unitCode: r.value.unitCode,
        unitPriceMicros: r.value.unitPriceMicros,
        ...(r.value.discountBp ? { discount: { kind: "percent" as const, valueBp: r.value.discountBp } } : {}),
        vatRateKey: p.vatRateKey,
        ...(p.exemptionReasonCode ? { exemptionReasonCode: p.exemptionReasonCode } : {}),
        ...(p.placeOfSupplyRule ? { placeOfSupplyRule: p.placeOfSupplyRule } : {}),
        ...(p.reverseCharge13b ? { reverseCharge13b: p.reverseCharge13b } : {}),
        ...(p.laborCostShareBp ? { isLaborCost: true } : {}),
        itemNumber: p.number,
        ...(p.revenueAccountOverride ? { revenueAccount: p.revenueAccountOverride } : {}),
      },
      source: r.value.source,
      purchasePriceMicros: p.purchasePriceMicros ?? null,
      warnings: r.value.warnings.map((w) => w.message),
    };
  },
});

// ── draft writes (DOC-03, DOC-52) ────────────────────────────────────────────────────────────────────────

export const createDraft = mutation({
  permission: "documents.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) => ({ id: await createDraftModel(ctx, parse(draftSchema, values)) }),
});

export const updateDraft = mutation({
  permission: "documents.write",
  args: {
    id: v.id("salesDocuments"),
    version: v.number(),
    values: v.any(),
    billingAddressId: v.optional(v.id("contactAddresses")),
  },
  handler: async (ctx, { id, version, values, billingAddressId }) =>
    updateDraftModel(ctx, id, version, parse(draftSchema, values), billingAddressId ? { billingAddressId } : {}),
});

/** F04 DOC-35 „Duplizieren“ (new draft of the same type; advance/partial/final → invoice). */
export const duplicate = mutation({
  permission: "documents.write",
  args: { id: v.id("salesDocuments") },
  handler: async (ctx, { id }) => ({ id: await duplicateDocument(ctx, id) }),
});

export const deleteDraft = mutation({
  permission: "documents.write",
  args: { id: v.id("salesDocuments") },
  handler: async (ctx, { id }) => deleteDraftModel(ctx, id),
});

// ── finalisation pipeline (02 §6, F04 §4.6) ───────────────────────────────────────────────────────────────

/** Step 1a/1b (read only): findings and the preview snapshot (number PREVIEW-0000). */
export const pipelinePreview = systemQuery({
  job: "documents.pipeline",
  args: { id: v.id("salesDocuments"), ...vFinalizeOptions },
  handler: async (ctx, a) => {
    const p = await finalizePreview(ctx, a.id, ctx.now(), optionsOf(a));
    const doc = await getDocument(ctx, a.id);
    return {
      status: doc.status,
      version: doc.version,
      number: doc.number ?? null,
      finalizedFromVersion: doc.finalizedFromVersion ?? null,
      findings: findingsValue(p.findings),
      snapshotJson: p.snapshot ? canonicalSnapshotJson(p.snapshot) : null,
      format: p.format,
      decision: p.decision,
    };
  },
});

/**
 * Step 2: the single commit transaction; schedules step 3. ⚠ for MCP (06 §3.4): the `document_preview` token binds
 * id, version and the finalisation options — not the server-computed `validation` outcome — and is consumed here.
 */
export const commit = actorMutation({
  permission: "invoices.finalize",
  args: {
    id: v.id("salesDocuments"),
    version: v.number(),
    validation: v.union(v.literal("passed"), v.literal("skipped"), v.literal("not_required")),
    ...vFinalizeOptions,
    confirmToken: vConfirmToken,
  },
  confirmArgs: ["id", "version", ...Object.keys(vFinalizeOptions)],
  handler: async (ctx, a) => {
    const r = await commitFinalization(ctx, a.id, a.version, { ...optionsOf(a), validation: a.validation });
    if (r.status === "finalized" && !r.idempotentReplay) {
      await ctx.scheduler.runAfter(0, internal.documentArtifacts.render, { id: a.id });
    }
    return r.status === "finalized" ? r : { status: r.status, findings: findingsValue(r.findings) };
  },
});

/**
 * „Fertigstellen“ (DOC-24): validation → preview snapshot → preview XML validation (KoSIT) → commit → render.
 * Errors before the commit consume no number (EC-007, T-DOC-018).
 */
export const finalize = action({
  permission: "invoices.finalize",
  args: { id: v.id("salesDocuments"), version: v.number(), ...vFinalizeOptions, confirmToken: vConfirmToken },
  handler: async (ctx, a): Promise<{ number: string; idempotentReplay: boolean }> =>
    runFinalizePipeline(ctx, ctx.actorContext, {
      id: a.id,
      version: a.version,
      ...optionsOf(a),
      ...(a.confirmToken ? { confirmToken: a.confirmToken } : {}),
    }),
});

/**
 * „Fertigstellen“-Vorschau (DOC-42, 06 §3.4 `document_preview`, REST `POST /{type}/{id}/preview`): the same step 1a/1b
 * as the pipeline (validation and preview snapshot) with totals, tax case and the ER-03 decision — writes nothing.
 */
export const finalizeCheck = query({
  permission: "documents.read",
  args: { id: v.id("salesDocuments"), ...vFinalizeOptions },
  handler: async (ctx, a) => {
    const doc = await getDocument(ctx, a.id);
    if (doc.status !== "draft") {
      return { status: doc.status, version: doc.version, type: doc.type, number: doc.number ?? null, check: null };
    }
    const p = await finalizePreview(ctx, a.id, ctx.now(), optionsOf(a));
    return {
      status: doc.status,
      version: doc.version,
      type: doc.type,
      number: null,
      check: {
        findings: findingsValue(p.findings),
        canFinalize: p.snapshot !== null && blocking(p.findings).length === 0,
        documentDate: p.documentDate,
        taxCase: p.taxCase ?? null,
        taxCaseReasons: p.taxCaseReasons ?? [],
        totals: p.totals ?? null,
        einvoice: { decision: p.decision, reason: p.decisionReason ?? null, format: p.format },
      },
    };
  },
});

/** „Erneut erzeugen“ (§4.6.5) after a sidecar/config fix: re-renders from the unchanged snapshot. */
export const retryArtifacts = mutation({
  permission: "invoices.finalize",
  // ⚠ permission: the token argument is required by the wrapper; no MCP tool calls this (UI/REST only).
  args: { id: v.id("salesDocuments"), confirmToken: vConfirmToken },
  handler: async (ctx, { id }) => {
    await restartArtifacts(ctx, id);
    await ctx.scheduler.runAfter(0, internal.documentArtifacts.render, { id });
  },
});

// ── sent mark (SND-07, SND-17, SND-18) ────────────────────────────────────────────────────────────────────

/**
 * „Als versendet markieren“ (SND-07/17). ⚠ for MCP: the `preview_action { action: "document_mark_sent" }` token binds
 * `{ id, values }` exactly as sent here (SND-24).
 */
export const markSent = mutation({
  permission: "invoices.send",
  args: { id: v.id("salesDocuments"), values: v.any(), confirmToken: vConfirmToken },
  handler: async (ctx, { id, values }) => {
    const r = await markSentModel(ctx, id, parse(markSentSchema, values));
    return { sendLogId: r.sendLogId, firstEffective: r.firstEffective, warnings: r.warnings.map((w) => w.message) };
  },
});

/**
 * Dry run of „Als versendet markieren“ (§5.1.8): findings, whether it is the first effective mark, the status and
 * Zugang afterwards. Effect of `preview_action { action: "document_mark_sent" }` and REST `mark-sent?dry_run=true`.
 */
export const markSentPreview = query({
  permission: "invoices.send",
  args: { id: v.id("salesDocuments"), values: v.any() },
  handler: async (ctx, { id, values }) => {
    const c = await checkMarkSent(ctx, id, parse(markSentSchema, values), ctx.now());
    return {
      type: c.doc.type,
      number: c.doc.number ?? null,
      version: c.doc.version,
      statusBefore: c.doc.status,
      firstEffective: c.r.firstEffective,
      statusAfter: c.errors.length > 0 ? c.doc.status : c.after.status,
      sentOn: c.after.sentOn ?? null,
      zugang: c.after.zugang?.date ?? null,
      errors: c.errors.map((f) => ({ code: f.code, message: f.message, rule: f.rule })),
      warnings: c.r.findings
        .filter((f) => f.severity !== "E")
        .map((f) => ({ code: f.code, message: f.message, rule: f.rule })),
      einvoiceHandedOverElectronically: c.r.einvoiceHandedOverElectronically === true,
    };
  },
});

/** SND-18 retraction (UI/REST only; an MCP token for it is never issued, SND-24). */
export const retractMark = mutation({
  permission: "invoices.send",
  args: { id: v.id("salesDocuments"), values: v.any(), confirmToken: vConfirmToken },
  handler: async (ctx, { id, values }) => retractMarkModel(ctx, id, parse(retractMarkSchema, values)),
});

// ── to-dos (SND-21) ──────────────────────────────────────────────────────────────────────────────────────

export const todos = query({
  permission: "documents.read",
  args: {},
  handler: async (ctx) =>
    (await openTodos(ctx)).map((n) => ({
      _id: n._id,
      kind: n.kind,
      severity: n.severity,
      title: n.title,
      link: n.link ?? null,
      createdAt: n.createdAt,
    })),
});

/** `deadlines.notify` — daily 08:00 Europe/Berlin (02 §7). */
export const notifyDeadlinesCron = systemMutation({
  job: "cron.deadlines.notify",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return { created: 0 };
    const exported = await notifyExportedNotMarked(ctx);
    const quotes = await runQuoteDeadlines(ctx);
    return { created: exported + quotes.expired + quotes.reminded };
  },
});

// helpers for the export action (convex/documentArtifacts.ts)
export const exportInput = systemQuery({
  job: "documents.pipeline",
  args: { id: v.id("salesDocuments") },
  handler: async (ctx, { id }) => {
    const doc = await getDocument(ctx, id);
    return {
      status: doc.status,
      type: doc.type,
      number: doc.number ?? null,
      format: doc.einvoice.format ?? "none",
      artifactStatus: doc.artifactStatus ?? null,
      marked: doc.sentAt !== undefined,
      artifacts: (await documentArtifacts(ctx, id)).map((a) => ({
        _id: a._id,
        kind: a.kind,
        variant: a.variant ?? "original",
        name: a.name,
        sha256: a.sha256,
        mime: a.mime,
        storageId: a.storageId,
      })),
    };
  },
});

/** Step 3 input: the frozen snapshot, layout version and logo (render is deterministic for the same input). */
export const renderInput = systemQuery({
  job: "documents.pipeline",
  args: { id: v.id("salesDocuments") },
  handler: async (ctx, { id }) => {
    const doc = await getDocument(ctx, id);
    const snap = doc.snapshotId ? await ctx.db.get(doc.snapshotId) : null;
    const layoutVersion =
      snap && snap.layoutVersionId !== "default"
        ? await ctx.db.get(snap.layoutVersionId as Id<"layoutVersions">)
        : null;
    const profile = await getCompanyProfile(ctx);
    return {
      status: doc.status,
      artifactStatus: doc.artifactStatus ?? null,
      finalizedAt: doc.finalizedAt ?? null,
      snapshotJson: snap?.json ?? null,
      layoutConfig: layoutVersion?.config ?? null,
      logoStorageId: profile?.logoStorageId ?? null,
      hasArtifacts: (await documentArtifacts(ctx, id)).some((a) => (a.variant ?? "original") !== "copy"),
    };
  },
});

const vStoredArtifact = v.object({
  kind: v.union(
    v.literal("pdf"),
    v.literal("zugferd_pdf"),
    v.literal("xrechnung_xml"),
    v.literal("validation_report_kosit"),
    v.literal("validation_report_mustang"),
  ),
  variant: v.optional(v.union(v.literal("original"), v.literal("copy"), v.literal("reading"))),
  storageId: v.id("_storage"),
  sha256: v.string(),
  bytes: v.number(),
  mime: v.string(),
  name: v.string(),
  tool: v.optional(v.object({ name: v.string(), version: v.string(), config: v.optional(v.string()) })),
});

/** Step 3d: archive the rendered files (sha256) → `artifactStatus = ready`. */
export const storeArtifacts = systemMutation({
  job: "documents.pipeline",
  args: { id: v.id("salesDocuments"), artifacts: v.array(vStoredArtifact) },
  handler: async (ctx, { id, artifacts }) => recordArtifacts(ctx, id, artifacts, { initial: true }),
});

/** Step 3e: a failed attempt → retry with backoff, after the last one `blocked` + alert. */
export const artifactFailure = systemMutation({
  job: "documents.pipeline",
  args: { id: v.id("salesDocuments"), error: v.string() },
  handler: async (ctx, { id, error }) => {
    const r = await recordArtifactFailure(ctx, id, error);
    if (r.retryInMs !== null && !isTest())
      await ctx.scheduler.runAfter(r.retryInMs, internal.documentArtifacts.render, { id });
    return r;
  },
});

/** EC-005 watchdog (cron every 10 min): renders that died with their process count as failed and restart. */
export const artifactsWatchdog = systemMutation({
  job: "documents.pipeline",
  args: {},
  handler: async (ctx) => {
    const restart = await orphanedArtifactRenders(ctx);
    for (const id of restart) await ctx.scheduler.runAfter(0, internal.documentArtifacts.render, { id });
    return { restarted: restart.length };
  },
});

/** DOC-32: the "Kopie" (or a Lesefassung) archived on first generation, attributed to the exporting actor. */
export const storeVariant = actorMutation({
  permission: "documents.export",
  args: { id: v.id("salesDocuments"), artifact: vStoredArtifact },
  handler: async (ctx, { id, artifact }) => (await recordArtifacts(ctx, id, [artifact], { initial: false }))[0],
});

/** SND-22: audit `document.export` (+ `firstExportedAt` once). */
export const recordExportEntry = actorMutation({
  permission: "documents.export",
  args: {
    id: v.id("salesDocuments"),
    artifactIds: v.array(v.id("documentArtifacts")),
    entry: v.string(),
    original: v.boolean(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, a) =>
    recordExport(ctx, a.id, {
      artifactIds: a.artifactIds,
      entry: a.entry,
      original: a.original,
      ...(a.reason ? { reason: a.reason } : {}),
    }),
});
