import type {
  InvoiceCorrectedEvent,
  InvoiceFinalisedEvent,
  SalesTaxCase,
  VatGroup,
} from "../../src/domain/accounting/events";
import { type ChainAdvance, type GroupAmount, sumGroups } from "../../src/domain/documents/advances";
import { applyCredit, detectRectifiedFields } from "../../src/domain/documents/corrections";
import type { DocumentContext, DraftDocument, ResolvedDraft } from "../../src/domain/documents/draft";
import {
  type ChainContext,
  chainOrderLabel,
  type DocumentRelations,
  groupsOfSnapshot,
  isAdvanceType,
  isChainType,
  type OriginalContext,
} from "../../src/domain/documents/relations";
import type { DocumentSnapshot } from "../../src/domain/documents/snapshot";
import { rectificationView } from "../../src/domain/documents/validate/chain";
import { er03RefDate } from "../../src/domain/einvoice/er03";
import type { Doc, Id } from "../_generated/dataModel";
import { auditedPatch } from "./audit";
import { activeCredits, settlementOf } from "./settlement";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Advance/partial/final chains and the originals of Storno/corrections (F04 §4.7/§4.8, INV-03…15) — the parts the
 * generic finalisation in salesDocuments.ts calls: the read context (`loadRelations`), the extra fields of the
 * finalisation patch (`chainFinalizePatch`), the side effects on related documents (`afterChainFinalize`) and the
 * journal event (`chainJournalEvent`). Does not import salesDocuments.ts (it is imported by it).
 *
 * Payment state is read through `settlementOf()` (convex/model/settlement.ts) only — the hook the payments slice
 * replaces.
 */

type SalesDoc = Doc<"salesDocuments">;

const ISSUED = (d: Pick<SalesDoc, "status">) => d.status !== "draft";
const ACTIVE = (d: Pick<SalesDoc, "status">) => d.status !== "draft" && d.status !== "cancelled";

export const groupsOfDoc = (d: Pick<SalesDoc, "totals">): GroupAmount[] =>
  d.totals.byGroup.map((g) => ({ category: g.category, rateBp: g.rateBp, netCents: g.netCents, vatCents: g.vatCents }));

export async function storedSnapshot(ctx: ReadCtx, d: Pick<SalesDoc, "snapshotId">): Promise<DocumentSnapshot | null> {
  if (!d.snapshotId) return null;
  const s = await ctx.db.get(d.snapshotId);
  return s ? (JSON.parse(s.json) as DocumentSnapshot) : null;
}

const isStored = (d: Pick<SalesDoc, "_id">) => (d._id as string) !== "new";

// ── chain reads ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Root + every document whose `chainRootId` is the root (the doc itself included when stored). */
export async function chainMembers(
  ctx: ReadCtx,
  doc: SalesDoc,
): Promise<{ root: SalesDoc | null; members: SalesDoc[] }> {
  const rootId = doc.chainRootId ?? (isStored(doc) ? doc._id : null);
  const root = doc.chainRootId ? await ctx.db.get(doc.chainRootId) : doc;
  if (!rootId) return { root, members: [doc] };
  const rest = await ctx.db
    .query("salesDocuments")
    .withIndex("by_chainRoot", (q) => q.eq("chainRootId", rootId))
    .collect();
  const all = new Map<string, SalesDoc>();
  if (root) all.set(root._id, root.chainRootId === undefined && root._id === doc._id ? doc : root);
  for (const d of rest) all.set(d._id, d._id === doc._id ? doc : d);
  all.set(doc._id, doc);
  return { root, members: [...all.values()] };
}

/** The order/quote reference of the chain (root document or the standalone `chainOrder`). */
function chainOrderOf(root: SalesDoc | null, doc: SalesDoc) {
  if (root && (root.type === "quote" || root.type === "order_confirmation") && root.number && root.documentDate) {
    return {
      label: chainOrderLabel(root.type),
      number: root.number,
      date: root.documentDate,
      groups: groupsOfDoc(root),
    };
  }
  const order = (root ?? doc).chainOrder ?? doc.chainOrder;
  return order ? { label: chainOrderLabel("standalone"), number: order.number, date: order.date } : null;
}

async function chainAdvanceOf(ctx: ReadCtx, a: SalesDoc, current: SalesDoc): Promise<ChainAdvance> {
  const settlement = await settlementOf(ctx, a);
  const credits = await activeCredits(ctx, a);
  const final = a.deductedInId && a.deductedInId !== current._id ? await ctx.db.get(a.deductedInId) : null;
  return {
    id: a._id,
    type: a.type as ChainAdvance["type"],
    number: a.number ?? "",
    date: a.documentDate ?? "",
    status: a.status,
    currency: a.currency,
    taxCase: a.taxCase,
    openCents: settlement.openCents,
    groups: groupsOfDoc(a),
    corrections: sumGroups(...credits.map(groupsOfDoc)),
    differences: [],
    ...(settlement.paidOn ? { paidOn: settlement.paidOn } : {}),
    ...(final && ACTIVE(final) ? { deductedIn: { id: final._id, number: final.number ?? "" } } : {}),
  };
}

export async function chainContext(ctx: ReadCtx, doc: SalesDoc): Promise<ChainContext | undefined> {
  const { root, members } = await chainMembers(ctx, doc);
  const order = chainOrderOf(root, doc);
  if (!order) return undefined;
  const others = members.filter((d) => d._id !== doc._id);
  const advances = others.filter((d) => isAdvanceType(d.type) && ISSUED(d));
  const myTime = doc.finalizedAt ?? Number.POSITIVE_INFINITY;
  const index = isAdvanceType(doc.type) ? advances.filter((d) => (d.finalizedAt ?? 0) < myTime).length + 1 : 0;
  const earlier: GroupAmount[][] = [];
  for (const a of advances.filter(ACTIVE)) {
    earlier.push(sumGroups(groupsOfDoc(a), ...(await activeCredits(ctx, a)).map(groupsOfDoc)));
  }
  const chainAdvances: ChainAdvance[] = [];
  for (const a of advances.sort((x, y) => (x.finalizedAt ?? 0) - (y.finalizedAt ?? 0))) {
    chainAdvances.push(await chainAdvanceOf(ctx, a, doc));
  }
  const otherFinal = others.find((d) => d.type === "final_invoice" && ACTIVE(d));
  return {
    rootId: root?._id ?? doc._id,
    orderLabel: order.label,
    orderNumber: order.number,
    orderDate: order.date,
    index,
    ...("groups" in order && order.groups ? { orderGroups: order.groups } : {}),
    earlierAdvances: earlier,
    final: { advances: chainAdvances, ...(otherFinal ? { otherFinal: { number: otherFinal.number ?? "" } } : {}) },
  };
}

export async function originalContext(ctx: ReadCtx, doc: SalesDoc): Promise<OriginalContext | undefined> {
  if (!doc.correctsId) return undefined;
  const o = await ctx.db.get(doc.correctsId);
  const snap = o ? await storedSnapshot(ctx, o) : null;
  if (!o || !snap) return undefined;
  const credits = (await activeCredits(ctx, o)).filter((c) => c._id !== doc._id);
  const corrections = (
    await ctx.db
      .query("salesDocuments")
      .withIndex("by_correctsId", (q) => q.eq("correctsId", o._id))
      .collect()
  )
    .filter((c) => c.type === "correction" && c._id !== doc._id && ACTIVE(c) && c.number && c.documentDate)
    .sort((a, b) => (a.finalizedAt ?? 0) - (b.finalizedAt ?? 0));
  return {
    id: o._id,
    type: o.type,
    status: o.status,
    number: snap.number,
    documentDate: snap.documentDate,
    ...(o.correctionKind ? { correctionKind: o.correctionKind } : {}),
    currency: snap.currency,
    groups: groupsOfSnapshot(snap),
    hadXml: snap.einvoice.format !== "none",
    format: snap.einvoice.format,
    er03RefDate: er03RefDate({ docType: o.type, documentDate: snap.documentDate, supplyDate: snap.supplyDate }),
    earlierCredits: credits.map(groupsOfDoc),
    earlierCorrections: corrections.map((c) => ({ number: c.number ?? "", date: c.documentDate ?? "" })),
    snapshot: snap,
  };
}

/** `DocumentContext.relations` of a draft (F04 §5.1.6); `undefined` for plain invoices. */
export async function loadRelations(ctx: ReadCtx, doc: SalesDoc): Promise<DocumentRelations | undefined> {
  if (isChainType(doc.type)) {
    const chain = await chainContext(ctx, doc);
    return chain ? { chain } : {};
  }
  if (doc.type === "correction" || doc.type === "cancellation") {
    const original = await originalContext(ctx, doc);
    return original ? { original } : {};
  }
  return undefined;
}

// ── finalisation hooks ───────────────────────────────────────────────────────────────────────────────────────────

export interface ChainFinalizeInput {
  doc: SalesDoc;
  snapshot: DocumentSnapshot;
  draft: DraftDocument;
  dctx: DocumentContext;
  resolved: ResolvedDraft;
}

/**
 * Extra fields of the finalisation patch (one transaction with the snapshot): final-invoice deductions with the
 * advance ids and the totals after deduction (BT-113/BT-115); a credit's receivable effect (§4.2.5); a
 * Berichtigung's corrected items and no receivable (INV-13).
 */
export async function chainFinalizePatch(ctx: ReadCtx, i: ChainFinalizeInput): Promise<Partial<SalesDoc>> {
  const { doc, snapshot } = i;
  if (doc.type === "final_invoice") {
    const advances = i.dctx.relations?.chain?.final.advances ?? [];
    const deductions = (snapshot.deductions ?? []).map((d) => {
      const a = advances.find((x) => x.number === d.advanceNumber);
      return {
        advanceId: a?.id as Id<"salesDocuments">,
        advanceNumber: d.advanceNumber,
        advanceDate: d.advanceDate,
        byGroup: d.byGroup.map((g) => ({ ...g })),
        deductedGrossCents: d.deductedGrossCents,
        partiallyPaid: d.partiallyPaid,
      };
    });
    return {
      deductions,
      totals: {
        ...doc.totals,
        ...totalsOfSnapshot(snapshot),
      },
    };
  }
  if (doc.type !== "correction" || !doc.correctsId) return {};
  if (doc.correctionKind === "rectification") {
    const o = i.dctx.relations?.original;
    const rectified = o
      ? detectRectifiedFields(o.snapshot, rectificationView(i.draft, i.dctx, i.resolved, o.snapshot))
      : [];
    return { rectifiedFields: rectified, paymentStatus: undefined, openAmountCents: 0 };
  }
  const original = await ctx.db.get(doc.correctsId);
  if (!original) return {};
  const effect = applyCredit({
    openCents: original.openAmountCents ?? original.totals.payableCents,
    status: original.paymentStatus ?? "open",
    creditGrossCents: snapshot.totals.payableCents,
  });
  return {
    creditAppliedCents: effect.appliedCents,
    openAmountCents: effect.correctionOpenCents,
    paymentStatus: effect.correctionOpenCents < 0 ? "open" : undefined,
  };
}

const totalsOfSnapshot = (s: DocumentSnapshot) => ({
  netCents: s.totals.netCents,
  vatCents: s.totals.vatCents,
  grossCents: s.totals.grossCents,
  advancesDeductedGrossCents: s.totals.advancesDeductedGrossCents,
  payableCents: s.totals.payableCents,
});

/** Side effects on related documents after the finalisation patch (same transaction). */
export async function afterChainFinalize(ctx: ModelCtx, doc: SalesDoc): Promise<void> {
  const label = doc.number ?? "";
  if (doc.type === "final_invoice") {
    for (const d of doc.deductions ?? []) {
      await auditedPatch(
        ctx,
        "salesDocuments",
        d.advanceId,
        { deductedInId: doc._id },
        {
          action: "document.advance_deducted",
          label: `${d.advanceNumber} → ${label}`,
        },
      );
    }
    return;
  }
  if (doc.type !== "correction" || !doc.correctsId) return;
  const original = await ctx.db.get(doc.correctsId);
  if (!original) return;
  if (doc.correctionKind === "rectification") {
    await setRegisterStatus(ctx, original.number, "corrected");
    return;
  }
  const effect = applyCredit({
    openCents: original.openAmountCents ?? original.totals.payableCents,
    status: original.paymentStatus ?? "open",
    creditGrossCents: doc.totals.payableCents,
  });
  await auditedPatch(
    ctx,
    "salesDocuments",
    original._id,
    {
      openAmountCents: effect.originalOpenCents,
      paymentStatus: effect.originalStatus as SalesDoc["paymentStatus"],
    },
    { action: "document.credited", label: `${original.number ?? ""} ← ${label}` },
  );
}

/** `numberRegister.status` issued → cancelled_by_storno / corrected (03 §11). */
export async function setRegisterStatus(
  ctx: ModelCtx,
  number: string | undefined,
  status: "cancelled_by_storno" | "corrected",
): Promise<void> {
  if (!number) return;
  const row = await ctx.db
    .query("numberRegister")
    .withIndex("by_normalized", (q) => q.eq("normalized", number.toUpperCase()))
    .first();
  if (row?.status !== "issued") return;
  await auditedPatch(ctx, "numberRegister", row._id, { status }, { action: "document.register_status", label: number });
}

const vatGroupsOf = (s: DocumentSnapshot): VatGroup[] =>
  s.totals.byGroup.map((g) => ({
    category: g.category,
    rateBp: g.rateBp,
    netCents: g.baseCents,
    vatCents: g.vatCents,
  }));

/**
 * INV-31 journal events of the chain/correction types (F08 S9/S11/S13): advances and amount-based partials post
 * nothing at finalisation (Mindest-Ist on receipt, S9); the final invoice posts S11 with the received advance
 * amounts per rate; a credit posts S13 unless it corrects an advance (never posted); a Berichtigung posts nothing.
 */
export async function chainJournalEvent(
  ctx: ReadCtx,
  doc: SalesDoc,
  s: DocumentSnapshot,
): Promise<InvoiceFinalisedEvent | InvoiceCorrectedEvent | null> {
  const contactId = doc.contactId ?? "";
  if (isChainType(doc.type)) {
    if (!s.supplyDate) return null;
    const deductions = (doc.type === "final_invoice" ? (doc.deductions ?? []) : []).flatMap((d) =>
      d.byGroup.map((g) => ({
        advanceDocumentId: d.advanceId,
        rateBp: g.rateBp,
        netCents: g.netCents,
        vatCents: g.vatCents,
      })),
    );
    return {
      kind: "invoice_finalised",
      documentId: doc._id,
      documentNumber: s.number,
      documentType: doc.type as InvoiceFinalisedEvent["documentType"],
      date: s.documentDate,
      supplyDate: s.supplyDate,
      taxCase: s.taxCase as SalesTaxCase,
      contactId,
      counterpartyName: s.buyer.name,
      vatGroups: vatGroupsOf(s),
      ...(deductions.length ? { advanceDeductions: deductions } : {}),
    };
  }
  if (doc.type !== "correction" || doc.correctionKind === "rectification" || !doc.correctsId) return null;
  const original = await ctx.db.get(doc.correctsId);
  if (!original || isAdvanceType(original.type)) return null;
  return {
    kind: "invoice_corrected",
    documentId: doc._id,
    documentNumber: s.number,
    correctedDocumentId: original._id,
    date: s.documentDate,
    taxCase: s.taxCase as SalesTaxCase,
    contactId,
    counterpartyName: s.buyer.name,
    vatGroups: vatGroupsOf(s),
  };
}
