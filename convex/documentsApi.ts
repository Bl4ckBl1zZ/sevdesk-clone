import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { filter } from "convex-helpers/server/filter";
import { normalizeSearchQuery } from "../src/domain/contacts/core";
import { DRAFT_TYPES } from "../src/domain/documents/doc-types";
import { SALES_DOC_STATUSES } from "../src/domain/documents/lifecycle";
import { blocking } from "../src/domain/documents/validate";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./functions";
import { displayStatusOf, documentLines, validateStored } from "./model/salesDocuments";

/**
 * Sales documents for REST and MCP (05 §4.3, 06 §3.4, F04 §7): list and read with the related documents' types (for
 * their prefixed IDs). Writes reuse convex/invoices.ts (drafts, finalisation) and convex/documentFlows.ts
 * (acceptance, conversions, …) with the shared schemas; the wire mapping is src/domain/schemas/api/documents.ts.
 */

const vType = v.union(...DRAFT_TYPES.map((t) => v.literal(t)));

function base(ctx: QueryCtx, a: { type: (typeof DRAFT_TYPES)[number]; status?: string; q?: string }) {
  const q = a.q?.trim() ? normalizeSearchQuery(a.q) : "";
  if (q) {
    return ctx.db
      .query("salesDocuments")
      .withSearchIndex("search", (s) => s.search("contactName", q).eq("type", a.type));
  }
  const status = SALES_DOC_STATUSES.find((s) => s === a.status);
  if (status) {
    return ctx.db
      .query("salesDocuments")
      .withIndex("by_type_status_date", (i) => i.eq("type", a.type).eq("status", status))
      .order("desc");
  }
  return ctx.db
    .query("salesDocuments")
    .withIndex("by_type_status_date", (i) => i.eq("type", a.type))
    .order("desc");
}

/** GET /quotes, /order-confirmations, /delivery-notes, /invoices (standard, proforma) and MCP `document_search`. */
export const list = query({
  permission: "documents.read",
  args: {
    paginationOpts: paginationOptsValidator,
    type: vType,
    status: v.optional(v.string()),
    contactId: v.optional(v.string()),
    q: v.optional(v.string()),
  },
  handler: async (ctx, { paginationOpts, ...a }) => {
    const today = berlinCalendarDate(ctx.now());
    const contactId = a.contactId ? ctx.db.normalizeId("contacts", a.contactId) : null;
    if (a.contactId && !contactId) return { page: [], isDone: true, continueCursor: "" };
    const keep = (d: Doc<"salesDocuments">) =>
      (!contactId || d.contactId === contactId) && (!a.status || !a.q?.trim() || d.status === a.status);
    const page = await filter(base(ctx, a), keep).paginate(paginationOpts);
    return { ...page, page: page.page.map((d) => ({ doc: d, displayStatus: displayStatusOf(d, today) })) };
  },
});

/** GET /{type}/{id}: the document, its lines, display status, draft validation and the types of linked documents. */
export const get = query({
  permission: "documents.read",
  args: { id: v.string(), types: v.array(vType) },
  handler: async (ctx, { id, types }) => {
    const docId = ctx.db.normalizeId("salesDocuments", id);
    const doc = docId ? await ctx.db.get(docId) : null;
    if (!doc || !(types as string[]).includes(doc.type)) return null;
    const now = ctx.now();
    const lines = (await documentLines(ctx, doc._id)).sort((a, b) => a.position - b.position);
    const related: Record<string, string> = {};
    const linked = [doc.originId, doc.chainRootId, ...(doc.sourceDocumentIds ?? [])].filter(
      (x): x is Id<"salesDocuments"> => x !== undefined,
    );
    for (const r of linked) {
      const d = await ctx.db.get(r);
      if (d) related[r] = d.type;
    }
    let validation: { code: string; severity: string; message: string; rule: string; field: string | null }[] | null =
      null;
    let canFinalize: boolean | null = null;
    if (doc.status === "draft") {
      const { result } = await validateStored(ctx, doc, now);
      validation = result.findings.map((f) => ({
        code: f.code,
        severity: f.severity,
        message: f.message,
        rule: f.rule,
        field: f.field ?? null,
      }));
      canFinalize = blocking(result.findings).length === 0;
    }
    return {
      doc,
      lines,
      displayStatus: displayStatusOf(doc, berlinCalendarDate(now)),
      related,
      validation,
      canFinalize,
    };
  },
});

/**
 * Type, status and version of any sales document (incl. Storno, corrections and reminders) — REST/MCP resolve a
 * prefixed id to its document before export, mark-sent and finalise (F04 §7.1/§7.2). Null when unknown.
 */
export const head = query({
  permission: "documents.read",
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const docId = ctx.db.normalizeId("salesDocuments", id);
    const doc = docId ? await ctx.db.get(docId) : null;
    if (!doc) return null;
    return { id: doc._id, type: doc.type, status: doc.status, version: doc.version, number: doc.number ?? null };
  },
});
