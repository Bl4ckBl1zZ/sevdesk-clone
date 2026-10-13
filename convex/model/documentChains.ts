import { DOC_TYPE_LABEL_DE } from "../../src/domain/documents/doc-types";
import type { DocumentContext } from "../../src/domain/documents/draft";
import { INVOICE_FAMILY_TYPES, transition } from "../../src/domain/documents/lifecycle";
import {
  type ChainDoc,
  type ChainLine,
  chainProgress,
  type DocProgress,
  progressEvent,
  remainingQuantities,
} from "../../src/domain/documents/progress";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedPatch } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Document chains (F04 §4.3, DOC-34, QUO-10…13): reads every document of a chain, recomputes the invoicing/delivery
 * progress (`src/domain/documents/progress.ts`) and writes the derived caches — the statuses `partially_invoiced` /
 * `invoiced` (back to the base status after a Storno), `coverage.coveredBp` and the line caches
 * `invoicedQtyMilli` / `deliveredQtyMilli` (03 §11: derived, recomputable, never edited by hand).
 *
 * Call `recomputeChainOf(ctx, doc)` after every finalisation or cancellation of a document that belongs to a chain
 * (the Storno slice calls it after cancelling an invoice derived from a quote/order/delivery note/proforma).
 */

type SalesDoc = Doc<"salesDocuments">;
type LineDoc = Doc<"documentLines">;

export interface ChainEntry {
  doc: SalesDoc;
  lines: LineDoc[];
}

export const rootOf = (d: Pick<SalesDoc, "_id" | "chainRootId">): Id<"salesDocuments"> => d.chainRootId ?? d._id;

async function linesOf(ctx: ReadCtx, id: Id<"salesDocuments">): Promise<LineDoc[]> {
  return (
    await ctx.db
      .query("documentLines")
      .withIndex("by_document", (q) => q.eq("documentId", id))
      .collect()
  ).sort((a, b) => a.position - b.position);
}

/**
 * Every document of the chains `doc` belongs to: its root's chain plus the chains of its collective sources (a
 * collective invoice can bill delivery notes of several orders, QUO-11), closed transitively.
 */
export async function loadChain(ctx: ReadCtx, start: SalesDoc): Promise<ChainEntry[]> {
  const byId = new Map<string, SalesDoc>();
  const pendingRoots = [rootOf(start)];
  const seenRoots = new Set<string>();
  byId.set(start._id, start);
  while (pendingRoots.length > 0) {
    const root = pendingRoots.pop() as Id<"salesDocuments">;
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const rootDoc = byId.get(root) ?? (await ctx.db.get(root));
    const members = await ctx.db
      .query("salesDocuments")
      .withIndex("by_chainRoot", (q) => q.eq("chainRootId", root))
      .collect();
    for (const d of rootDoc ? [rootDoc, ...members] : members) {
      byId.set(d._id, d);
      for (const s of d.sourceDocumentIds ?? []) {
        const src = byId.get(s) ?? (await ctx.db.get(s));
        if (!src) continue;
        byId.set(src._id, src);
        if (!seenRoots.has(rootOf(src))) pendingRoots.push(rootOf(src));
      }
    }
  }
  const out: ChainEntry[] = [];
  for (const d of byId.values()) out.push({ doc: d, lines: await linesOf(ctx, d._id) });
  return out;
}

const chainLine = (l: LineDoc): ChainLine => ({
  id: l._id,
  kind: l.kind,
  ...(l.quantityMilli !== undefined ? { quantityMilli: l.quantityMilli } : {}),
  ...(l.optional ? { optional: true } : {}),
  ...(l.sourceLineId ? { sourceLineId: l.sourceLineId } : {}),
  ...(l.lineNetCents !== undefined ? { lineNetCents: l.lineNetCents } : {}),
});

export const chainDoc = (e: ChainEntry): ChainDoc => ({
  id: e.doc._id,
  type: e.doc.type,
  status: e.doc.status,
  ...(e.doc.number ? { number: e.doc.number } : {}),
  ...(e.doc.originId ? { originId: e.doc.originId } : {}),
  ...(e.doc.sourceDocumentIds?.length ? { sourceDocumentIds: e.doc.sourceDocumentIds } : {}),
  ...(e.doc.received ? { received: true } : {}),
  ...(e.doc.sentAt !== undefined ? { sent: true } : {}),
  lines: e.lines.map(chainLine),
});

export async function progressOf(
  ctx: ReadCtx,
  doc: SalesDoc,
): Promise<{ entries: ChainEntry[]; progress: Map<string, DocProgress> }> {
  const entries = await loadChain(ctx, doc);
  return { entries, progress: chainProgress(entries.map(chainDoc)) };
}

/** Remaining (not yet invoiced / delivered) quantity per item line of `doc` (QUO-10, INV-05 conversion proposal). */
export async function remainingOf(
  ctx: ReadCtx,
  doc: SalesDoc,
  what: "invoiced" | "delivered",
): Promise<Record<string, number>> {
  const { entries, progress } = await progressOf(ctx, doc);
  const self = entries.find((e) => e.doc._id === doc._id);
  return self ? remainingQuantities(progress, chainDoc(self), what) : {};
}

/**
 * Validation context of a derived invoice draft: per source line the quantity still open (`quantity_exceeds_source`)
 * and the delivery notes that another finalised invoice already contains (`delivery_note_already_invoiced`).
 */
export async function chainContextFor(
  ctx: ReadCtx,
  doc: SalesDoc,
  draftLines: readonly { readonly sourceLineId?: string | undefined }[],
): Promise<Pick<DocumentContext, "sourceLineRemaining" | "deliveryNotesInvoiced">> {
  if (!INVOICE_FAMILY_TYPES.includes(doc.type)) return {};
  const referenced = new Set(draftLines.flatMap((l) => (l.sourceLineId ? [l.sourceLineId] : [])));
  if (referenced.size === 0 && !doc.originId && !doc.sourceDocumentIds?.length) return {};
  const { entries, progress } = await progressOf(ctx, doc);
  // The draft itself never counts (status draft), so `remaining` is what this invoice may still bill.
  const lineOwner = new Map<string, ChainEntry>();
  for (const e of entries) for (const l of e.lines) lineOwner.set(l._id, e);
  const sourceLineRemaining: Record<string, { remainingMilli: number; sourceNumber: string }> = {};
  for (const lineId of referenced) {
    const owner = lineOwner.get(lineId);
    if (!owner) continue;
    // A delivery note line limits by the note's quantity; quote/order lines by what is not yet invoiced.
    const remaining = remainingQuantities(progress, chainDoc(owner), "invoiced")[lineId];
    if (remaining === undefined) continue;
    sourceLineRemaining[lineId] = {
      remainingMilli: remaining,
      sourceNumber: owner.doc.number ?? DOC_TYPE_LABEL_DE[owner.doc.type],
    };
  }
  const deliveryNotesInvoiced: { number: string; invoiceNumber: string }[] = [];
  const sources = [...(doc.sourceDocumentIds ?? []), ...(doc.originId ? [doc.originId] : [])];
  for (const id of sources) {
    const e = entries.find((x) => x.doc._id === id);
    if (e?.doc.type !== "delivery_note") continue;
    const by = progress.get(id)?.invoicedBy ?? [];
    if (by.length > 0) deliveryNotesInvoiced.push({ number: e.doc.number ?? id, invoiceNumber: by[0] as string });
  }
  return {
    ...(Object.keys(sourceLineRemaining).length ? { sourceLineRemaining } : {}),
    ...(deliveryNotesInvoiced.length ? { deliveryNotesInvoiced } : {}),
  };
}

/** BT-14 (order confirmation number) and BT-16 (delivery note numbers) of a document being finalised. */
export async function chainReferencesFor(
  ctx: ReadCtx,
  doc: SalesDoc,
): Promise<{ salesOrderReference?: string; deliveryNoteNumbers?: string[] }> {
  if (!INVOICE_FAMILY_TYPES.includes(doc.type) && doc.type !== "delivery_note" && doc.type !== "proforma") return {};
  const notes: string[] = [];
  let order: string | undefined;
  const seen = new Set<string>();
  const visit = async (id: Id<"salesDocuments"> | undefined, depth: number) => {
    if (!id || seen.has(id) || depth > 10) return;
    seen.add(id);
    const d = await ctx.db.get(id);
    if (!d) return;
    if (d.type === "order_confirmation" && d.number && !order) order = d.number;
    if (d.type === "delivery_note" && d.number && depth === 1) notes.push(d.number);
    await visit(d.originId, depth + 1);
    for (const s of d.sourceDocumentIds ?? []) await visit(s, depth + 1);
  };
  await visit(doc.originId, 1);
  for (const s of doc.sourceDocumentIds ?? []) await visit(s, 1);
  return {
    ...(order ? { salesOrderReference: order } : {}),
    ...(notes.length && doc.type !== "delivery_note" ? { deliveryNoteNumbers: [...notes].sort() } : {}),
  };
}

/**
 * Recomputes the chain of `doc` and moves every member to its derived status (QUO-08/09/12/13, INV-32). Idempotent:
 * only changed statuses and caches are written (each write audited with `action`).
 */
export async function recomputeChainOf(ctx: ModelCtx, doc: SalesDoc, action: string): Promise<void> {
  const { entries, progress } = await progressOf(ctx, doc);
  for (const e of entries) {
    const p = progress.get(e.doc._id);
    if (!p || e.doc.status === "draft") continue;
    const patch: Record<string, unknown> = {};
    const event = progressEvent(chainDoc(e), p.progress);
    if (event) {
      const t = transition(e.doc.type, e.doc.status, event);
      if (t.ok && t.value) patch.status = t.value;
    }
    if (e.doc.type === "quote" || e.doc.type === "order_confirmation") {
      if (e.doc.coverage?.coveredBp !== p.coveredBp) {
        patch.coverage = { prepaidByGroup: e.doc.coverage?.prepaidByGroup ?? [], coveredBp: p.coveredBp };
      }
      for (const l of e.lines) {
        const q = p.lines.get(l._id);
        if (!q) continue;
        if ((l.invoicedQtyMilli ?? 0) !== q.invoicedQtyMilli || (l.deliveredQtyMilli ?? 0) !== q.deliveredQtyMilli) {
          await auditedPatch(
            ctx,
            "documentLines",
            l._id,
            { invoicedQtyMilli: q.invoicedQtyMilli, deliveredQtyMilli: q.deliveredQtyMilli },
            { action },
          );
        }
      }
    }
    if (Object.keys(patch).length > 0) {
      await auditedPatch(ctx, "salesDocuments", e.doc._id, patch as never, {
        action,
        label: e.doc.number ?? DOC_TYPE_LABEL_DE[e.doc.type],
      });
    }
  }
}

/** Whether `doc` takes part in a chain (has a source or derived documents). */
export async function inChain(ctx: ReadCtx, doc: SalesDoc): Promise<boolean> {
  if (doc.originId || doc.chainRootId || doc.sourceDocumentIds?.length) return true;
  const first = await ctx.db
    .query("salesDocuments")
    .withIndex("by_chainRoot", (q) => q.eq("chainRootId", doc._id))
    .first();
  return first !== null;
}

/** Chain overview for the detail page and `GET /{type}/{id}/chain` (DOC-34). */
export async function chainOverview(ctx: ReadCtx, doc: SalesDoc) {
  const { entries, progress } = await progressOf(ctx, doc);
  return entries
    .map((e) => ({
      _id: e.doc._id,
      type: e.doc.type,
      status: e.doc.status,
      number: e.doc.number ?? null,
      documentDate: e.doc.documentDate ?? null,
      grossCents: e.doc.totals.grossCents,
      currency: e.doc.currency,
      originId: e.doc.originId ?? null,
      sourceDocumentIds: e.doc.sourceDocumentIds ?? [],
      revision: e.doc.revision ?? null,
      coveredBp: progress.get(e.doc._id)?.coveredBp ?? 0,
      isCurrent: e.doc._id === doc._id,
      createdAt: e.doc._creationTime,
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** The document (finalised, from any chain) or a 404 in the conversion functions. */
export async function sourceDocument(ctx: ReadCtx, id: Id<"salesDocuments">): Promise<SalesDoc> {
  const d = await ctx.db.get(id);
  if (!d) throw appError("not_found", "Dokument nicht gefunden.");
  return d;
}
