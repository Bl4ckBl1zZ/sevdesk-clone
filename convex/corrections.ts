import { v } from "convex/values";
import { canonicalSnapshotJson, type DocumentSnapshot } from "../src/domain/documents/snapshot";
import { serializeEinvoice } from "../src/domain/einvoice/serialize";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, mutation, query, systemQuery, vConfirmToken } from "./functions";
import { validateXml } from "./lib/einvoiceTools";
import { appError } from "./lib/errors";
import { storedSnapshot } from "./model/invoiceChains";
import {
  cancelDocument,
  cancelPreview as cancelPreviewModel,
  chainOverview,
  createChainDraft as createChainDraftModel,
  createCorrectionDraft,
  reduceAdvanceToReceived,
} from "./model/invoiceCorrections";
import { getDocument } from "./model/salesDocuments";
import { settlementOf } from "./model/settlement";

/**
 * Storno, Rechnungskorrektur, Rechnungsberichtigung and the advance/final chain (F04 §4.7/§4.8, INV-03…15).
 * UI today; REST (`/invoices/{id}/cancel|correct|chain`, `/corrections/{id}/cancel`) and MCP (`document_preview`
 * intent `cancel`, ⚠ `invoice_cancel`, `invoice_create_correction`) call the same functions. All writes go through
 * convex/model/invoiceCorrections.ts; correction/advance/final drafts are finalised by `invoices.finalize`.
 */

const vCancelOptions = { reason: v.optional(v.string()), documentDate: v.optional(v.string()) };

const optionsOf = (a: { reason?: string; documentDate?: string }) => ({
  ...(a.reason?.trim() ? { reason: a.reason.trim() } : {}),
  ...(a.documentDate ? { documentDate: a.documentDate } : {}),
});

function mirrorView(s: DocumentSnapshot) {
  return {
    documentDate: s.documentDate,
    currency: s.currency,
    format: s.einvoice.format,
    decision: s.einvoice.decision ?? null,
    lines: s.lines.flatMap((l) =>
      l.kind === "item"
        ? [{ name: l.name, quantityMilli: l.quantityMilli, unitCode: l.unitCode, netCents: l.netCents }]
        : [],
    ),
    totals: {
      netCents: s.totals.netCents,
      vatCents: s.totals.vatCents,
      grossCents: s.totals.grossCents,
      payableCents: s.totals.payableCents,
    },
    notes: s.notes.map((n) => n.de),
  };
}

/** Storno preview dialog (§4.8): mirror totals, guard result, dispatch notice — writes nothing. */
export const cancelPreview = query({
  permission: "documents.read",
  args: { id: v.id("salesDocuments"), ...vCancelOptions },
  handler: async (ctx, a) => {
    const p = await cancelPreviewModel(ctx, a.id, optionsOf(a), ctx.now());
    const doc = await getDocument(ctx, a.id);
    return {
      version: doc.version,
      guard: p.guard ? { code: p.guard.code, message: p.guard.message } : null,
      original: p.original,
      documentDate: p.documentDate,
      notice: p.notice,
      mirror: p.snapshot ? mirrorView(p.snapshot) : null,
    };
  },
});

/** Preview snapshot JSON for the XML check of the action below. */
export const cancelPreviewSnapshot = systemQuery({
  job: "documents.pipeline",
  args: { id: v.id("salesDocuments"), ...vCancelOptions },
  handler: async (ctx, a) => {
    const p = await cancelPreviewModel(ctx, a.id, optionsOf(a), ctx.now());
    return {
      guard: p.guard ? { code: p.guard.code, message: p.guard.message } : null,
      snapshotJson: p.snapshot ? canonicalSnapshotJson(p.snapshot) : null,
    };
  },
});

/**
 * INV-20 for the Storno: the mirror XML (PREVIEW-0000) is validated before the owner confirms; errors abort before a
 * number is assigned. Step 3 validates the final XML again.
 */
export const validateCancel = action({
  permission: "documents.read",
  args: { id: v.id("salesDocuments"), ...vCancelOptions },
  handler: async (
    ctx,
    a,
  ): Promise<{ status: "passed" | "skipped" | "not_required" | "failed" | "blocked"; message: string | null }> => {
    const p = await ctx.runQuery(internal.corrections.cancelPreviewSnapshot, { id: a.id, ...optionsOf(a) });
    if (p.guard || !p.snapshotJson) return { status: "blocked", message: p.guard?.message ?? null };
    const snapshot = JSON.parse(p.snapshotJson) as DocumentSnapshot;
    if (snapshot.einvoice.format === "none") return { status: "not_required", message: null };
    const outcome = await validateXml(serializeEinvoice(snapshot, snapshot.einvoice.format).xml);
    if (outcome.kind === "unavailable") throw appError("dependency_unavailable", undefined, { detail: outcome.detail });
    if (outcome.kind === "failed") {
      const first = outcome.errors[0];
      return {
        status: "failed",
        message: `Die E-Rechnung der Stornorechnung ist ungültig (${outcome.errors.length} Fehler). Erster Fehler: ${first?.ruleId ?? "?"} – ${first?.text ?? ""}.`,
      };
    }
    return { status: outcome.kind === "passed" ? "passed" : "skipped", message: null };
  },
});

/**
 * ⚠ „Stornieren“ (INV-10): creates and finalises the Stornorechnung in one transaction and schedules its files.
 * MCP callers need a confirm token from `document_preview` with `intent: "cancel"`.
 */
export const cancel = mutation({
  permission: "invoices.cancel",
  args: { id: v.id("salesDocuments"), ...vCancelOptions, confirmToken: vConfirmToken },
  handler: async (ctx, a) => {
    const r = await cancelDocument(ctx, a.id, optionsOf(a));
    await ctx.scheduler.runAfter(0, internal.documentArtifacts.render, { id: r.id });
    return r;
  },
});

/** The created draft (id + OCC version for the following finalisation). */
async function draftRef(ctx: Parameters<typeof getDocument>[0], id: Id<"salesDocuments">) {
  return { id, version: (await getDocument(ctx, id)).version };
}

/** „Korrigieren…“ → Rechnungskorrektur or Rechnungsberichtigung draft (INV-12/13). */
export const createCorrection = mutation({
  permission: "documents.write",
  args: {
    originalId: v.id("salesDocuments"),
    kind: v.union(v.literal("credit"), v.literal("rectification")),
    changes: v.optional(
      v.array(
        v.object({
          position: v.number(),
          quantityMilli: v.optional(v.number()),
          unitPriceMicros: v.optional(v.number()),
        }),
      ),
    ),
  },
  handler: async (ctx, a) =>
    draftRef(
      ctx,
      await createCorrectionDraft(ctx, a.originalId, { kind: a.kind, ...(a.changes ? { changes: a.changes } : {}) }),
    ),
});

/** „Weitere Abschlagsrechnung“ / „Schlussrechnung erstellen“ (INV-03/06). */
export const createChainDraft = mutation({
  permission: "documents.write",
  args: { fromId: v.id("salesDocuments"), type: v.union(v.literal("advance_invoice"), v.literal("final_invoice")) },
  handler: async (ctx, a) => draftRef(ctx, await createChainDraftModel(ctx, a.fromId, a.type)),
});

/** EC-071: Rechnungskorrektur of a partially paid advance down to the received amount (draft). */
export const reduceAdvance = mutation({
  permission: "documents.write",
  args: { advanceId: v.id("salesDocuments") },
  handler: async (ctx, a) => draftRef(ctx, await reduceAdvanceToReceived(ctx, a.advanceId)),
});

const ref = (d: Doc<"salesDocuments">) => ({
  id: d._id,
  type: d.type,
  correctionKind: d.correctionKind ?? null,
  number: d.number ?? null,
  documentDate: d.documentDate ?? null,
  status: d.status,
  grossCents: d.totals.grossCents,
});

/** Related documents for the detail page: original, Storno, corrections, chain with received/open amounts. */
export const relations = query({
  permission: "documents.read",
  args: { id: v.id("salesDocuments") },
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get(id);
    if (!doc) return null;
    const original = doc.correctsId ? await ctx.db.get(doc.correctsId) : null;
    const dependents = await ctx.db
      .query("salesDocuments")
      .withIndex("by_correctsId", (q) => q.eq("correctsId", id))
      .collect();
    const cancelledBy = doc.cancellation?.byDocumentId ? await ctx.db.get(doc.cancellation.byDocumentId) : null;
    const settlement = doc.status === "draft" ? null : await settlementOf(ctx, doc);
    const snap = doc.status === "draft" ? null : await storedSnapshot(ctx, doc);
    return {
      original: original ? ref(original) : null,
      cancelledBy: cancelledBy ? ref(cancelledBy) : null,
      cancellationReason: doc.cancellation?.reason ?? null,
      corrections: dependents.filter((d) => d.type === "correction").map(ref),
      chain: await chainOverview(ctx, doc),
      settlement,
      deductions: snap?.deductions ?? [],
      rectifiedFields: snap?.rectifiedFields ?? [],
      sentOrExported: doc.sentAt !== undefined || doc.firstExportedAt !== undefined,
    };
  },
});
