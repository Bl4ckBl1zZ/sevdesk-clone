/**
 * Invoicing and delivery progress of a document chain (F04 §4.3.3, QUO-10, QUO-11, QUO-13, INV-05, INV-32).
 *
 * Every derived line references the line it was converted from (`sourceLineId`); quantities of finalised,
 * non-cancelled invoices climb that reference chain (invoice → delivery note → order → quote), so each quote/order
 * line knows its `invoicedQtyMilli`, and finalised delivery notes give `deliveredQtyMilli`. The caches and the
 * statuses (`partially_invoiced` / `invoiced`, delivery notes and proforma `invoiced`) are recomputed from scratch for
 * the whole chain whenever a derived document is finalised or cancelled — they are derived, never edited (03 §11).
 */
import { INVOICE_FAMILY_TYPES, type LifecycleEvent, type SalesDocStatus } from "./lifecycle";
import type { SalesDocType } from "./snapshot";

export interface ChainLine {
  readonly id: string;
  readonly kind: "item" | "heading" | "text" | "subtotal";
  readonly quantityMilli?: number | undefined;
  readonly optional?: boolean | undefined;
  readonly sourceLineId?: string | undefined;
  readonly lineNetCents?: number | undefined;
}

export interface ChainDoc {
  readonly id: string;
  readonly type: SalesDocType;
  readonly status: SalesDocStatus;
  readonly number?: string | undefined;
  readonly originId?: string | undefined;
  readonly sourceDocumentIds?: readonly string[] | undefined;
  /** Delivery note „Erhalten“ (decides the status after a reverted invoice, §4.2.3). */
  readonly received?: boolean | undefined;
  /** Marked as sent (orders/delivery notes return to `sent`, else `finalized`). */
  readonly sent?: boolean | undefined;
  readonly lines: readonly ChainLine[];
}

export type Progress = "none" | "partial" | "full";

export interface DocProgress {
  readonly lines: ReadonlyMap<string, { readonly invoicedQtyMilli: number; readonly deliveredQtyMilli: number }>;
  readonly progress: Progress;
  /** Invoiced share of the net amount in basis points (03 `coverage.coveredBp`); 10,000 when fully invoiced. */
  readonly coveredBp: number;
  /** The invoice numbers that contain this document (delivery notes, proforma). */
  readonly invoicedBy: readonly string[];
}

/** Documents that count: finalised (any non-draft status) and not cancelled. */
const counts = (d: ChainDoc) => d.status !== "draft" && d.status !== "cancelled";
const isInvoice = (d: ChainDoc) => INVOICE_FAMILY_TYPES.includes(d.type);

/** All documents a document was derived from (origin and collective sources, transitively). */
export function ancestorsOf(id: string, byId: ReadonlyMap<string, ChainDoc>): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const d = byId.get(stack.pop() as string);
    if (!d) continue;
    for (const p of [d.originId, ...(d.sourceDocumentIds ?? [])]) {
      if (p && !out.has(p)) {
        out.add(p);
        stack.push(p);
      }
    }
  }
  return out;
}

export function chainProgress(docs: readonly ChainDoc[]): Map<string, DocProgress> {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const lineById = new Map<string, ChainLine>();
  for (const d of docs) for (const l of d.lines) lineById.set(l.id, l);
  const invoiced = new Map<string, number>();
  const delivered = new Map<string, number>();
  const climb = (start: string | undefined, qty: number, into: Map<string, number>) => {
    const seen = new Set<string>();
    let id = start;
    while (id && !seen.has(id)) {
      seen.add(id);
      into.set(id, (into.get(id) ?? 0) + qty);
      id = lineById.get(id)?.sourceLineId;
    }
  };
  const counted = docs.filter(counts);
  for (const d of counted) {
    const into = isInvoice(d) ? invoiced : d.type === "delivery_note" ? delivered : null;
    if (!into) continue;
    for (const l of d.lines) {
      if (l.kind === "item" && !l.optional && l.sourceLineId) climb(l.sourceLineId, l.quantityMilli ?? 0, into);
    }
  }
  const ancestors = new Map(counted.map((d) => [d.id, ancestorsOf(d.id, byId)]));
  const out = new Map<string, DocProgress>();
  for (const d of docs) {
    const derived = counted.filter((x) => isInvoice(x) && ancestors.get(x.id)?.has(d.id));
    const items = d.lines.filter((l) => l.kind === "item" && !l.optional);
    const lines = new Map(
      items.map((l) => [
        l.id,
        { invoicedQtyMilli: invoiced.get(l.id) ?? 0, deliveredQtyMilli: delivered.get(l.id) ?? 0 },
      ]),
    );
    const hasFinal = derived.some((x) => x.type === "final_invoice");
    const allCovered =
      items.length > 0 && items.every((l) => (lines.get(l.id)?.invoicedQtyMilli ?? 0) >= (l.quantityMilli ?? 0));
    let progress: Progress = "none";
    if (d.type === "delivery_note" || d.type === "proforma") progress = derived.length > 0 ? "full" : "none";
    else if (hasFinal || allCovered) progress = "full";
    else if (derived.length > 0) progress = "partial";
    out.set(d.id, {
      lines,
      progress,
      coveredBp: progress === "full" ? 10_000 : coveredShare(items, lines),
      invoicedBy: derived.map((x) => x.number ?? x.id),
    });
  }
  return out;
}

/** Σ net × min(invoiced, qty) / qty over Σ net, in basis points (integer arithmetic). */
function coveredShare(
  items: readonly ChainLine[],
  lines: ReadonlyMap<string, { readonly invoicedQtyMilli: number }>,
): number {
  let total = 0n;
  let covered = 0n;
  for (const l of items) {
    const qty = BigInt(Math.abs(l.quantityMilli ?? 0));
    const net = BigInt(Math.abs(l.lineNetCents ?? 0));
    if (qty === 0n) continue;
    const inv = BigInt(Math.min(Math.abs(lines.get(l.id)?.invoicedQtyMilli ?? 0), Math.abs(l.quantityMilli ?? 0)));
    total += net;
    covered += (net * inv) / qty;
  }
  if (total === 0n) return 0;
  return Number((covered * 10_000n) / total);
}

/** The lifecycle event that moves a document to its recomputed progress status, or null if nothing changes. */
export function progressEvent(d: ChainDoc, p: Progress): LifecycleEvent | null {
  switch (d.type) {
    case "quote": {
      if (d.status !== "accepted" && d.status !== "partially_invoiced" && d.status !== "invoiced") return null;
      if (p === "full") return d.status === "invoiced" ? null : "invoiced_fully";
      if (p === "partial") return d.status === "partially_invoiced" ? null : "invoiced_partially";
      return d.status === "accepted" ? null : "invoice_reverted";
    }
    case "order_confirmation": {
      if (!["finalized", "sent", "partially_invoiced", "invoiced"].includes(d.status)) return null;
      if (p === "full") return d.status === "invoiced" ? null : "invoiced_fully";
      if (p === "partial") return d.status === "partially_invoiced" ? null : "invoiced_partially";
      if (d.status !== "partially_invoiced" && d.status !== "invoiced") return null;
      return d.sent ? "invoice_reverted" : "invoice_reverted_unsent";
    }
    case "delivery_note": {
      if (p === "full") return ["finalized", "sent", "accepted"].includes(d.status) ? "invoiced_fully" : null;
      if (d.status !== "invoiced") return null;
      return d.received ? "invoice_reverted" : d.sent ? "invoice_reverted_sent" : "invoice_reverted_unsent";
    }
    case "proforma":
      // §4.2.4: invoiced once an invoice converted from it is finalised; EC-DOC-102 blocks a second conversion.
      return p === "full" && (d.status === "finalized" || d.status === "sent") ? "invoiced_fully" : null;
    default:
      return null;
  }
}

/**
 * Quantity not yet invoiced (or delivered) per item line of `docId`, for the conversion dialog proposal (QUO-10,
 * INV-05) and the `quantity_exceeds_source` guard; never negative.
 */
export function remainingQuantities(
  progress: ReadonlyMap<string, DocProgress>,
  doc: ChainDoc,
  what: "invoiced" | "delivered",
): Record<string, number> {
  const p = progress.get(doc.id);
  const out: Record<string, number> = {};
  for (const l of doc.lines) {
    if (l.kind !== "item") continue;
    const done = p?.lines.get(l.id);
    const used = what === "invoiced" ? (done?.invoicedQtyMilli ?? 0) : (done?.deliveredQtyMilli ?? 0);
    out[l.id] = Math.max(0, (l.quantityMilli ?? 0) - used);
  }
  return out;
}
