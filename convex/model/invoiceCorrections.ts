import { type GroupAmount, remainderCorrectionGroups, sumGroups } from "../../src/domain/documents/advances";
import { buildSnapshot } from "../../src/domain/documents/build-snapshot";
import {
  type CancelTarget,
  type CreditChange,
  cancellationGuard,
  cancellationSnapshotInput,
  correctionTargetGuard,
  creditDeltaLines,
  revertCredit,
} from "../../src/domain/documents/corrections";
import type { DraftLine } from "../../src/domain/documents/draft";
import { retentionClassFor, retentionUntil } from "../../src/domain/documents/finalize";
import { isAdvanceType, isChainType } from "../../src/domain/documents/relations";
import { objectionIssue } from "../../src/domain/documents/self-billing";
import {
  canonicalSnapshotJson,
  type DocumentSnapshot,
  PREVIEW_NUMBER,
  snapshotHash,
} from "../../src/domain/documents/snapshot";
import type { Issue } from "../../src/domain/result";
import type { DraftValues } from "../../src/domain/schemas/documents";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { isCalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import { assertClockOk } from "./clock";
import { onDocumentCancelled as dunningOnCancelled } from "./dunning";
import { chainMembers, groupsOfDoc, setRegisterStatus, storedSnapshot } from "./invoiceChains";
import { postJournalEntry } from "./journal";
import { assignCounterNumber } from "./numberRanges";
import {
  createDraft,
  documentLines,
  draftFromDoc,
  getDocument,
  nextStatus,
  resolveNotifications,
} from "./salesDocuments";
import { reverseSelfBillingVoucher } from "./selfBilling";
import { activeCredits, settlementOf } from "./settlement";
import { offerReopenAfterStorno } from "./timeEntries";
import type { ModelCtx, ReadCtx } from "./types";
import { emitDocumentEvent } from "./webhooks";

/**
 * Storno, Rechnungskorrektur, Rechnungsberichtigung and the advance → final chain actions (F04 §4.7/§4.8,
 * INV-03…15, 10 EC-070…080). The only writer of these flows; the finalisation of correction/advance/final drafts is
 * the generic pipeline in salesDocuments.ts with the hooks of invoiceChains.ts.
 *
 * - `cancelDocument`: Storno of an unpaid invoice-family document (or an unrefunded credit) — mirror snapshot,
 *   own number, original `cancelled`, register `cancelled_by_storno`, receivable closed, journal reversal (S12) —
 *   all in one transaction (INV-10/11/15, RI-06).
 * - `createCorrectionDraft`: Rechnungskorrektur (negative delta, INV-12) or Rechnungsberichtigung (INV-13) draft.
 * - `createChainDraft`: next Abschlagsrechnung or the Schlussrechnung of a chain (INV-03/06/07).
 * - `reduceAdvanceToReceived`: EC-071 — the mandatory Rechnungskorrektur of a partially paid advance down to the
 *   received amount before the final invoice.
 */

type SalesDoc = Doc<"salesDocuments">;

const ISSUED = (d: Pick<SalesDoc, "status">) => d.status !== "draft";
const ACTIVE = (d: Pick<SalesDoc, "status">) => d.status !== "draft" && d.status !== "cancelled";
const label = (d: Pick<SalesDoc, "number" | "type">) => d.number ?? `Entwurf (${d.type})`;

// ── Storno (INV-10/11/15) ────────────────────────────────────────────────────────────────────────────────────────

export async function cancelTargetOf(ctx: ReadCtx, doc: SalesDoc): Promise<CancelTarget> {
  const settlement = await settlementOf(ctx, doc);
  const by = doc.cancellation?.byDocumentId ? await ctx.db.get(doc.cancellation.byDocumentId) : null;
  const final = doc.deductedInId ? await ctx.db.get(doc.deductedInId) : null;
  const credits = doc.type === "correction" ? [] : await activeCredits(ctx, doc);
  return {
    type: doc.type,
    status: doc.status,
    ...(doc.number ? { number: doc.number } : {}),
    ...(doc.correctionKind ? { correctionKind: doc.correctionKind } : {}),
    payableCents: settlement.payableCents,
    hasPayments: settlement.hasPayments,
    ...(by?.number ? { cancelledBy: by.number } : {}),
    ...(final && ACTIVE(final) && final.number ? { deductedIn: final.number } : {}),
    activeCorrections: credits.map((c) => c.number ?? ""),
  };
}

export interface CancelOptions {
  reason?: string | undefined;
  /** F04 §4.2.8: the mirror cancellation of a self-billing Gutschrift after the supplier's objection. */
  selfBillingObjection?: boolean | undefined;
  /** Default: today (Europe/Berlin). Not before the original, not in the future. */
  documentDate?: string | undefined;
  /** EC-DOC-110: Storno without XML — only for an unsent original whose artifacts are blocked. */
  einvoiceFallback?: boolean | undefined;
}

export interface CancelPreview {
  guard: Issue | null;
  snapshot: DocumentSnapshot | null;
  original: { id: Id<"salesDocuments">; number: string; documentDate: string; type: SalesDoc["type"] };
  documentDate: string;
  /** EC-DOC-116 dispatch notice of the preview dialog. */
  notice: string;
  /** EC-DOC-116: the customer may hold the invoice (exported or marked) → the success step offers „Exportieren“. */
  exportSuggested: boolean;
  /** EC-DOC-110: unsent original with blocked files → „Ohne E-Rechnung stornieren“ may be offered. */
  artifactsBlocked: boolean;
}

function stornoDate(original: SalesDoc, o: CancelOptions, today: string): string {
  const date = o.documentDate ?? today;
  if (!isCalendarDate(date) || date > today) {
    throw appError("invalid_input", "Das Datum der Stornorechnung darf nicht in der Zukunft liegen.", {
      field: "documentDate",
    });
  }
  if (original.documentDate && date < original.documentDate) {
    throw appError("invalid_input", "Das Datum der Stornorechnung darf nicht vor dem Rechnungsdatum liegen.", {
      field: "documentDate",
    });
  }
  return date;
}

function dispatchNotice(d: SalesDoc): string {
  if (d.sentAt !== undefined) {
    return "Die Rechnung wurde als versendet markiert. Bitte die Stornorechnung ebenfalls versenden und als versendet markieren.";
  }
  if (d.firstExportedAt !== undefined) {
    return "Die Rechnung wurde exportiert, aber nicht als versendet markiert. Der Kunde könnte sie bereits erhalten haben – bitte die Stornorechnung ebenfalls übermitteln, sonst bleibt die ausgewiesene Steuer nach § 14c UStG geschuldet.";
  }
  return "Die Rechnung wurde nicht versendet; die Stornorechnung muss nicht versendet werden.";
}

function mirrorOf(
  original: DocumentSnapshot,
  number: string,
  documentDate: string,
  reason?: string,
  einvoiceFallback = false,
) {
  return buildSnapshot(
    cancellationSnapshotInput(original, {
      number,
      documentDate,
      layoutVersionId: original.layoutVersionId,
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
      ...(einvoiceFallback ? { einvoiceFallback: true } : {}),
    }),
  );
}

/** EC-DOC-110 / EC-006: the XML fallback is only for an unsent original whose files could never be produced. */
function assertFallbackAllowed(doc: SalesDoc, o: CancelOptions): void {
  if (!o.einvoiceFallback) return;
  if (doc.artifactStatus !== "blocked" || doc.sentAt !== undefined) {
    throw appError(
      "conflict",
      "Eine Stornorechnung ohne E-Rechnung ist nur möglich, wenn die Dateien der Rechnung nicht erzeugt werden konnten und sie nicht versendet wurde.",
      { reason: "einvoice_fallback_not_allowed" },
    );
  }
}

export const EINVOICE_FALLBACK_NOTE =
  "Storno ohne E-Rechnung: Die Dateien der Rechnung waren blockiert und die XML der Stornorechnung ist ungültig (EC-006).";

/** The Storno preview (mirror with PREVIEW-0000, guard result); writes nothing. */
export async function cancelPreview(
  ctx: ReadCtx,
  id: Id<"salesDocuments">,
  o: CancelOptions,
  now: number,
): Promise<CancelPreview> {
  const doc = await getDocument(ctx, id);
  const guard = cancellationGuard(await cancelTargetOf(ctx, doc));
  const today = berlinCalendarDate(now);
  const documentDate = o.documentDate ?? today;
  const snap = await storedSnapshot(ctx, doc);
  const built =
    !guard && snap ? mirrorOf(snap, PREVIEW_NUMBER, documentDate, o.reason, o.einvoiceFallback === true) : null;
  return {
    guard: guard ?? (built && !built.ok ? { code: built.error.code, message: built.error.message } : null),
    snapshot: built?.ok ? built.value : null,
    original: { id: doc._id, number: doc.number ?? "", documentDate: doc.documentDate ?? "", type: doc.type },
    documentDate,
    notice: dispatchNotice(doc),
    exportSuggested: doc.sentAt !== undefined || doc.firstExportedAt !== undefined,
    artifactsBlocked: doc.artifactStatus === "blocked" && doc.sentAt === undefined,
  };
}

/** INV-10: creates and finalises the Stornorechnung atomically; returns its id and number. */
export async function cancelDocument(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  o: CancelOptions,
): Promise<{ id: Id<"salesDocuments">; number: string }> {
  await assertClockOk(ctx); // AUD-019 / EC-027: no business date while the clock is off by > 60 s
  const original = await getDocument(ctx, id);
  const guard = cancellationGuard(await cancelTargetOf(ctx, original), {
    selfBillingObjection: o.selfBillingObjection === true,
  });
  if (guard) throw appError("conflict", guard.message, { reason: guard.code });
  assertFallbackAllowed(original, o);
  const snap = await storedSnapshot(ctx, original);
  if (!snap) throw appError("conflict", "Die Rechnung hat keinen festgeschriebenen Stand.");
  const now = ctx.now();
  const documentDate = stornoDate(original, o, berlinCalendarDate(now));
  const reason = o.reason?.trim() ?? "";
  const nextOriginalStatus = nextStatus(original, "cancel");

  // The Storno row exists as a draft only inside this transaction (it is created finalised, §4.2.6).
  const stornoId = await auditedInsert(
    ctx,
    "salesDocuments",
    {
      type: "cancellation",
      status: "draft",
      ...(original.contactId ? { contactId: original.contactId } : {}),
      contactName: snap.buyer.name,
      ...(original.supplyDate ? { supplyDate: original.supplyDate } : {}),
      supplyDateMode: "explicit",
      currency: original.currency,
      ...(original.fxRateToEur ? { fxRateToEur: original.fxRateToEur } : {}),
      priceMode: original.priceMode,
      taxCase: original.taxCase,
      paymentTerms: original.paymentTerms,
      showEpcQr: false,
      language: original.language,
      einvoice: {},
      totals: original.totals,
      retentionClass: retentionClassFor("cancellation"),
      tags: [],
      customFields: {},
      correctsId: original._id,
      createdBy: ctx.actor,
      channel: ctx.actorContext.channel === "cron" ? "system" : ctx.actorContext.channel,
      version: 1,
    },
    { action: "document.cancel", label: `Storno zu ${label(original)}` },
  );
  const [year, month] = documentDate.split("-").map(Number) as [number, number];
  const assigned = await assignCounterNumber(ctx, {
    docType: "cancellation",
    date: { year, month },
    documentId: stornoId,
    action: "document.cancel",
  });
  const built = mirrorOf(snap, assigned.number, documentDate, reason, o.einvoiceFallback === true);
  if (!built.ok) throw appError("validation_failed", built.error.message, { reason: built.error.code });
  const mirror = built.value;
  const snapshotId = await auditedInsert(
    ctx,
    "documentSnapshots",
    {
      documentId: stornoId,
      json: canonicalSnapshotJson(mirror),
      snapshotHash: await snapshotHash(mirror),
      ruleVersions: { ...mirror.ruleVersions },
      layoutVersionId: mirror.layoutVersionId,
      createdAt: now,
    },
    { action: "document.cancel", label: assigned.number },
  );
  const t = mirror.totals;
  await auditedPatch(
    ctx,
    "salesDocuments",
    stornoId,
    {
      status: "finalized",
      number: assigned.number,
      numberRangeId: assigned.rangeId,
      documentDate,
      einvoice: {
        format: mirror.einvoice.format,
        ...(mirror.einvoice.decision ? { decision: mirror.einvoice.decision } : {}),
        decidedAt: now,
        ...(mirror.einvoice.format === "none" ? { validation: "not_required" as const } : {}),
      },
      totals: {
        netCents: t.netCents,
        vatCents: t.vatCents,
        grossCents: t.grossCents,
        advancesDeductedGrossCents: t.advancesDeductedGrossCents,
        payableCents: t.payableCents,
        byGroup: t.byGroup.map((g) => ({
          category: g.category,
          rateBp: g.rateBp,
          netCents: g.baseCents,
          vatCents: g.vatCents,
        })),
      },
      openAmountCents: 0,
      snapshotId,
      artifactStatus: "pending",
      artifactAttempts: 0,
      finalizedAt: now,
      finalizedBy: ctx.actor,
      finalizedFromVersion: 1,
      retentionUntil: retentionUntil("cancellation", documentDate),
    },
    {
      action: "document.cancel",
      label: assigned.number,
      ...(reason || o.einvoiceFallback
        ? { reason: [reason, o.einvoiceFallback ? EINVOICE_FALLBACK_NOTE : ""].filter(Boolean).join(" · ") }
        : {}),
    },
  );

  // The original: cancelled, receivable closed, register row, chain effects (RI-06, EC-077).
  await auditedPatch(
    ctx,
    "salesDocuments",
    original._id,
    {
      status: nextOriginalStatus,
      cancellation: { at: now, reason: reason || "Storno", byDocumentId: stornoId },
      openAmountCents: 0,
    },
    { action: "document.cancelled", label: `${label(original)} → ${assigned.number}`, ...(reason ? { reason } : {}) },
  );
  await setRegisterStatus(ctx, original.number, "cancelled_by_storno");
  await emitDocumentEvent(ctx, original._id, "cancelled", { status: original.status }); // 05 §5.3 invoice.cancelled
  // REC-16 / SND-21: the export to-dos of the original close with its Storno.
  for (const kind of ["export_and_send", "exported_not_marked"]) await resolveNotifications(ctx, original._id, kind);
  await dunningOnCancelled(ctx, original._id); // EC-077: the dunning case closes, reminders stay archived
  await offerReopenAfterStorno(ctx, original); // F11 E-PRJ-25: offer the billed time entries as „wieder abrechenbar“
  if (original.type === "correction" && original.correctionKind === "credit" && original.correctsId) {
    // INV-15: the credited invoice gets back what the credit absorbed.
    const credited = await getDocument(ctx, original.correctsId);
    const back = revertCredit({
      openCents: credited.openAmountCents ?? credited.totals.payableCents,
      status: credited.paymentStatus ?? "open",
      appliedCents: original.creditAppliedCents ?? 0,
    });
    if (credited.status !== "cancelled") {
      await auditedPatch(
        ctx,
        "salesDocuments",
        credited._id,
        { openAmountCents: back.openCents, paymentStatus: back.status as SalesDoc["paymentStatus"] },
        { action: "document.credit_reverted", label: `${label(credited)} ← ${assigned.number}` },
      );
    }
  }
  if (original.type === "final_invoice") {
    for (const d of original.deductions ?? []) {
      const a = await ctx.db.get(d.advanceId);
      if (a?.deductedInId === original._id) {
        await auditedPatch(
          ctx,
          "salesDocuments",
          a._id,
          { deductedInId: undefined },
          {
            action: "document.advance_released",
            label: `${d.advanceNumber} ← ${assigned.number}`,
          },
        );
      }
    }
  }
  // S12: reversal of the original's entries in the Storno's period (nothing for an advance, S9).
  await postJournalEntry(ctx, {
    kind: "invoice_cancelled",
    documentId: stornoId,
    documentNumber: assigned.number,
    originalDocumentId: original._id,
    date: documentDate,
  });
  return { id: stornoId, number: assigned.number };
}

// ── self-billing objection (F04 §4.2.8, §4.9 step 5, INV-16) ─────────────────────────────────────────────────────

/**
 * „Widerspruch erfassen“: the supplier objects to our Gutschrift (§ 14 Abs. 2 Satz 3 UStG — the Gutschrift loses its
 * effect as an invoice). Recorded with its date and text; the Gutschrift is cancelled by a mirror cancellation dated
 * on the objection date and its purchase voucher is reversed. One transaction: a paid voucher blocks everything.
 */
export async function recordObjection(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  input: { date: string; text: string },
): Promise<{ cancellationId: Id<"salesDocuments">; number: string }> {
  const doc = await getDocument(ctx, id);
  const issue = objectionIssue({
    type: doc.type,
    status: doc.status,
    documentDate: doc.documentDate ?? "",
    date: input.date,
    text: input.text,
    today: berlinCalendarDate(ctx.now()),
  });
  if (issue) throw appError("invalid_input", issue, { reason: "OBJECTION_INVALID" });
  const text = input.text.trim();
  const reason = `Widerspruch vom ${input.date.split("-").reverse().join(".")}: ${text}`;
  await reverseSelfBillingVoucher(ctx, doc, reason);
  const r = await cancelDocument(ctx, id, { reason, documentDate: input.date, selfBillingObjection: true });
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    { objection: { date: input.date, text, recordedAt: ctx.now() } },
    { action: "document.objection", label: `${label(doc)} → ${r.number}`, reason },
  );
  return { cancellationId: r.id, number: r.number };
}

// ── correction drafts (INV-12/13/14) ─────────────────────────────────────────────────────────────────────────────

function headerOf(o: SalesDoc, type: DraftValues["type"]): Omit<DraftValues, "lines"> {
  return {
    type,
    ...(o.contactId ? { contactId: o.contactId } : {}),
    ...(o.deliveryAddress ? { deliveryAddress: o.deliveryAddress } : {}),
    ...(o.supplyDate ? { supplyDate: o.supplyDate as DraftValues["supplyDate"] } : {}),
    supplyDateMode: "explicit",
    currency: o.currency,
    ...(o.fxRateToEur && o.fxRateToEur.source !== "transaction"
      ? { fxRateToEur: o.fxRateToEur as DraftValues["fxRateToEur"] }
      : {}),
    priceMode: o.priceMode,
    ...(o.taxCaseOverridden
      ? { taxCaseOverride: { taxCase: o.taxCase as never, reason: o.taxCaseOverridden.reason } }
      : {}),
    ...(o.buyerReference ? { buyerReference: o.buyerReference } : {}),
    ...(o.orderReference ? { orderReference: o.orderReference } : {}),
    ...(o.contractReference ? { contractReference: o.contractReference } : {}),
    paymentTerms: o.paymentTerms,
    ...(o.paymentMethodId ? { paymentMethodId: o.paymentMethodId } : {}),
    ...(o.bankAccountId ? { bankAccountId: o.bankAccountId } : {}),
    showEpcQr: o.showEpcQr,
    ...(o.kleinbetrag ? { kleinbetrag: true } : {}),
    ...(o.propertyRelated ? { propertyRelated: true } : {}),
    ...(o.constructionWork ? { constructionWork: true } : {}),
    language: o.language,
    ...(o.einvoice.format ? { einvoiceFormat: o.einvoice.format } : {}),
  };
}

const toValuesLines = (lines: readonly DraftLine[]): DraftValues["lines"] =>
  lines.map((l) => {
    const { vatCategory: _c, vatRateBp: _r, ...rest } = l as DraftLine & { vatCategory?: unknown; vatRateBp?: unknown };
    return rest as DraftValues["lines"][number];
  });

export interface CorrectionInput {
  kind: "credit" | "rectification";
  /** Credit only: changed item lines (1-based among item lines); none = the full amount (§4.8). */
  changes?: readonly CreditChange[] | undefined;
}

/** INV-12/13: a correction draft prefilled from the original (credit = negative delta, rectification = full copy). */
export async function createCorrectionDraft(
  ctx: ModelCtx,
  originalId: Id<"salesDocuments">,
  input: CorrectionInput,
): Promise<Id<"salesDocuments">> {
  const original = await getDocument(ctx, originalId);
  const by = original.cancellation?.byDocumentId ? await ctx.db.get(original.cancellation.byDocumentId) : null;
  const guard = correctionTargetGuard({
    type: original.type,
    status: original.status,
    ...(original.number ? { number: original.number } : {}),
    ...(by?.number ? { cancelledBy: by.number } : {}),
  });
  if (guard) throw appError("conflict", guard.message, { reason: guard.code });
  const origLines = draftFromDoc(original, await documentLines(ctx, originalId)).lines;
  const credit = input.kind === "credit";
  const lines = credit ? creditDeltaLines(origLines, input.changes ?? []) : origLines;
  if (lines.length === 0) {
    throw appError("invalid_input", "Keine Position wurde gemindert. Bitte Menge oder Preis verringern.", {
      reason: "correction_not_reducing",
    });
  }
  const discount = original.documentDiscount;
  const values: DraftValues = {
    ...headerOf(original, "correction"),
    ...(credit ? { showEpcQr: false } : {}),
    ...(discount && (!credit || discount.kind === "percent") ? { documentDiscount: discount } : {}),
    ...(original.subject && !credit ? { subject: original.subject } : {}),
    ...(original.headText && !credit ? { headText: original.headText } : {}),
    ...(original.footText && !credit ? { footText: original.footText } : {}),
    lines: toValuesLines(lines),
  };
  const id = await createDraft(ctx, values);
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    {
      correctsId: original._id,
      correctionKind: input.kind,
      ...(original.billingAddressId ? { billingAddressId: original.billingAddressId } : {}),
    },
    {
      action: "document.create_correction",
      label: `${credit ? "Rechnungskorrektur" : "Rechnungsberichtigung"} zu ${label(original)}`,
    },
  );
  return id;
}

// ── chains (INV-03/06/07, EC-070/071) ────────────────────────────────────────────────────────────────────────────

export interface ChainOverview {
  rootId: Id<"salesDocuments">;
  order: { number: string; date: string } | null;
  advances: {
    id: Id<"salesDocuments">;
    type: SalesDoc["type"];
    number: string;
    documentDate: string;
    status: SalesDoc["status"];
    invoicedCents: number;
    creditedCents: number;
    receivedCents: number;
    openCents: number;
    deductedInNumber: string | null;
    /** EC-071 resolution offered by the final-invoice wizard. */
    resolution: "settled" | "storno" | "reduce" | "cancelled" | "deducted";
  }[];
  finals: { id: Id<"salesDocuments">; number: string | null; status: SalesDoc["status"] }[];
  drafts: { id: Id<"salesDocuments">; type: SalesDoc["type"] }[];
  canCreateFinal: boolean;
}

/** Chain view for the detail page and the final-invoice wizard (received/open via `settlementOf`). */
export async function chainOverview(ctx: ReadCtx, doc: SalesDoc): Promise<ChainOverview | null> {
  if (!isChainType(doc.type)) return null;
  const { root, members } = await chainMembers(ctx, doc);
  const rootDoc = root ?? doc;
  const order =
    rootDoc.type === "quote" || rootDoc.type === "order_confirmation"
      ? rootDoc.number && rootDoc.documentDate
        ? { number: rootDoc.number, date: rootDoc.documentDate }
        : null
      : (rootDoc.chainOrder ?? null);
  const advances: ChainOverview["advances"] = [];
  for (const a of members
    .filter((d) => isAdvanceType(d.type) && ISSUED(d))
    .sort((x, y) => (x.finalizedAt ?? 0) - (y.finalizedAt ?? 0))) {
    const s = await settlementOf(ctx, a);
    const final = a.deductedInId ? await ctx.db.get(a.deductedInId) : null;
    const deducted = final && ACTIVE(final);
    advances.push({
      id: a._id,
      type: a.type,
      number: a.number ?? "",
      documentDate: a.documentDate ?? "",
      status: a.status,
      invoicedCents: a.totals.payableCents,
      creditedCents: s.creditedCents,
      receivedCents: s.receivedCents,
      openCents: a.status === "cancelled" ? 0 : s.openCents,
      deductedInNumber: deducted ? (final.number ?? null) : null,
      resolution:
        a.status === "cancelled"
          ? "cancelled"
          : deducted
            ? "deducted"
            : s.openCents <= 0
              ? "settled"
              : s.receivedCents === 0
                ? "storno"
                : "reduce",
    });
  }
  const finals = members
    .filter((d) => d.type === "final_invoice" && d.status !== "cancelled")
    .map((d) => ({ id: d._id, number: d.number ?? null, status: d.status }));
  return {
    rootId: rootDoc._id,
    order,
    advances,
    finals,
    drafts: members.filter((d) => d.status === "draft" && d._id !== doc._id).map((d) => ({ id: d._id, type: d.type })),
    canCreateFinal: finals.length === 0 && advances.some((a) => a.resolution !== "cancelled"),
  };
}

/**
 * „Weitere Abschlagsrechnung“ / „Schlussrechnung erstellen“: a draft of the chain of `fromId` with the header of the
 * chain's latest document. The final draft repeats the supply (the owner enters the full supply; an order root's
 * lines arrive with the conversion slice); its deductions are computed from the chain at finalisation.
 */
export async function createChainDraft(
  ctx: ModelCtx,
  fromId: Id<"salesDocuments">,
  type: "advance_invoice" | "final_invoice",
): Promise<Id<"salesDocuments">> {
  const from = await getDocument(ctx, fromId);
  if (!isChainType(from.type) || from.status === "draft") {
    throw appError("conflict", "Nur aus einer fertiggestellten Abschlagsrechnung möglich.", {
      reason: "illegal_transition",
    });
  }
  const overview = await chainOverview(ctx, from);
  if (!overview) throw appError("not_found");
  if (type === "final_invoice" && overview.finals.length > 0) {
    const f = overview.finals[0];
    throw appError("conflict", `Für diesen Auftrag gibt es bereits die Schlussrechnung ${f?.number ?? "(Entwurf)"}.`, {
      reason: "final_exists",
    });
  }
  const orderNumber = overview.order?.number ?? "";
  const values: DraftValues = {
    ...headerOf(from, type),
    ...(type === "final_invoice" ? { showEpcQr: from.showEpcQr } : {}),
    lines: [
      {
        kind: "item",
        productType: "service",
        name:
          type === "final_invoice"
            ? `Gesamtleistung laut Auftrag ${orderNumber}`.trim()
            : `Abschlag laut Auftrag ${orderNumber}`.trim(),
        quantityMilli: 1_000,
        unitCode: "C62",
        unitPriceMicros: 0,
        vatRateKey: "standard",
      },
    ],
  };
  const id = await createDraft(ctx, values);
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    { chainRootId: overview.rootId },
    {
      action: "document.create_chain_draft",
      label: `${type === "final_invoice" ? "Schlussrechnung" : "Abschlagsrechnung"} zu ${orderNumber || label(from)}`,
    },
  );
  return id;
}

/**
 * EC-071: the Rechnungskorrektur that reduces a partially paid advance to the amount received (per group
 * `allocate(open, gross_g)`, App. E.4 case E). Returns the correction draft; finalising it settles the advance.
 */
export async function reduceAdvanceToReceived(
  ctx: ModelCtx,
  advanceId: Id<"salesDocuments">,
): Promise<Id<"salesDocuments">> {
  const advance = await getDocument(ctx, advanceId);
  if (!isAdvanceType(advance.type) || !ACTIVE(advance)) {
    throw appError("conflict", "Nur offene Abschlags- oder Teilrechnungen können gemindert werden.", {
      reason: "illegal_transition",
    });
  }
  const s = await settlementOf(ctx, advance);
  if (s.openCents <= 0)
    throw appError("conflict", `${label(advance)} ist bereits ausgeglichen.`, { reason: "settled" });
  if (s.receivedCents === 0) {
    throw appError("conflict", `Auf ${label(advance)} ist keine Zahlung eingegangen. Bitte stornieren statt mindern.`, {
      reason: "advance_unpaid_use_storno",
    });
  }
  const credits = await activeCredits(ctx, advance);
  const groups: GroupAmount[] = sumGroups(groupsOfDoc(advance), ...credits.map(groupsOfDoc));
  const reduce = remainderCorrectionGroups(groups, s.openCents);
  const advLines = draftFromDoc(advance, await documentLines(ctx, advanceId)).lines;
  const lines: DraftValues["lines"] = reduce.map((g) => {
    const like = advLines.find(
      (l) =>
        l.kind === "item" &&
        (l as { vatRateBp?: number }).vatRateBp === g.rateBp &&
        (l as { vatCategory?: string }).vatCategory === g.category,
    );
    return {
      kind: "item",
      productType: "service",
      name: `Minderung auf den erhaltenen Betrag (${label(advance)})`,
      quantityMilli: -1_000,
      unitCode: "C62",
      unitPriceMicros: -g.netCents * 100,
      vatRateKey: like?.vatRateKey ?? "standard",
      ...(like?.vatCategoryOverride ? { vatCategoryOverride: like.vatCategoryOverride } : {}),
      ...(like?.exemptionReasonCode ? { exemptionReasonCode: like.exemptionReasonCode } : {}),
    } as DraftValues["lines"][number];
  });
  const values: DraftValues = { ...headerOf(advance, "correction"), priceMode: "net", showEpcQr: false, lines };
  const id = await createDraft(ctx, values);
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    {
      correctsId: advance._id,
      correctionKind: "credit",
      ...(advance.billingAddressId ? { billingAddressId: advance.billingAddressId } : {}),
    },
    { action: "document.create_correction", label: `Minderung ${label(advance)} auf den erhaltenen Betrag` },
  );
  return id;
}
