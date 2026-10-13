/**
 * Storno, Rechnungskorrektur and Rechnungsberichtigung (F04 §4.8, INV-10…INV-15, UST-30/UST-31, RI-06/RI-07). Pure.
 *
 * - Storno (`cancellation`) only for unpaid invoices: a full mirror of the original snapshot (all lines with negated
 *   quantities, same rates, same supply date, seller and buyer block of the original, BT-25/26).
 * - Rechnungskorrektur (`correction`, `credit`): a negative delta of the original; Σ(original + credits) ≥ 0 per VAT
 *   group (RI-07). More money is a new invoice (INV-14). It reduces the original's open amount; any excess becomes
 *   a refund owed on the correction (§4.2.5).
 * - Rechnungsberichtigung (`correction`, `rectification`): formal data only — identical amounts per VAT group,
 *   TypeCode 384, no journal entry; the corrected items are listed (UST-31 retroactive effect).
 */
import { canonicalize } from "../audit/canonical";
import { type Issue, issue } from "../result";
import { type GroupAmount, sumGroups } from "./advances";
import type { SnapshotInput, SnapshotInputLine } from "./build-snapshot";
import type { DraftLine } from "./draft";
import { formatAmount } from "./i18n";
import type { DocumentSnapshot, SalesDocType } from "./snapshot";
import { type Finding, finding } from "./validate/finding";

const INVOICE_FAMILY: readonly SalesDocType[] = ["invoice", "advance_invoice", "partial_invoice", "final_invoice"];
const ISSUED = ["finalized", "sent"];

// ── guards ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CancelTarget {
  readonly type: SalesDocType;
  readonly status: string;
  readonly number?: string | undefined;
  readonly correctionKind?: "credit" | "rectification" | undefined;
  readonly payableCents: number;
  /**
   * Payments (net of reversals) or, for a credit correction, refunds/offsets are allocated. Decided by the model
   * layer from `paymentStatus`/`openAmountCents` (the payments slice extends that check).
   */
  readonly hasPayments: boolean;
  /** Number of the Storno that already cancelled it. */
  readonly cancelledBy?: string | undefined;
  /** Advance/partial: the non-cancelled final invoice that deducted it. */
  readonly deductedIn?: string | undefined;
  /** Numbers of finalised, non-cancelled credit corrections of this document. */
  readonly activeCorrections?: readonly string[] | undefined;
}

export type CancelBlockCode =
  | "illegal_transition"
  | "storno_of_storno"
  | "already_cancelled"
  | "storno_paid_invoice"
  | "storno_advance_deducted"
  | "storno_has_corrections"
  | "correction_refund_allocated";

/** INV-10/INV-11/INV-15: null = the document may be cancelled by a Storno. */
export function cancellationGuard(t: CancelTarget): Issue<CancelBlockCode> | null {
  const nr = t.number ?? "";
  if (t.type === "cancellation") return issue("storno_of_storno", "Eine Stornorechnung kann nicht storniert werden.");
  if (t.status === "cancelled") {
    return issue(
      "already_cancelled",
      `Rechnung ${nr} wurde bereits durch ${t.cancelledBy ?? "eine Stornorechnung"} storniert.`,
      {
        number: nr,
        storno: t.cancelledBy ?? "",
      },
    );
  }
  const isCredit = t.type === "correction" && t.correctionKind === "credit";
  if (!ISSUED.includes(t.status) || (!INVOICE_FAMILY.includes(t.type) && !isCredit)) {
    return issue(
      "illegal_transition",
      "Nur fertiggestellte Rechnungen und Rechnungskorrekturen können storniert werden.",
    );
  }
  if (isCredit) {
    return t.hasPayments
      ? issue(
          "correction_refund_allocated",
          "Diese Rechnungskorrektur ist bereits erstattet oder verrechnet und kann nicht storniert werden.",
        )
      : null;
  }
  if (t.deductedIn) {
    return issue(
      "storno_advance_deducted",
      `Abschlagsrechnung ${nr} ist in Schlussrechnung ${t.deductedIn} verrechnet. Bitte zuerst die Schlussrechnung stornieren oder korrigieren.`,
      { number: nr, final: t.deductedIn },
    );
  }
  if (t.hasPayments) {
    return issue(
      "storno_paid_invoice",
      `Rechnung ${nr} ist (teil)bezahlt. Stornieren ist nur bei unbezahlten Rechnungen möglich. Erstellen Sie eine Rechnungskorrektur und erfassen Sie die Erstattung – oder lösen Sie zuerst die Zahlungszuordnung, falls sie falsch ist.`,
      { number: nr },
    );
  }
  if (t.activeCorrections?.length) {
    return issue(
      "storno_has_corrections",
      `Zu Rechnung ${nr} gibt es Rechnungskorrekturen (${t.activeCorrections.join(", ")}). Ein Storno würde mehr aufheben, als offen ist: Bitte zuerst die Rechnungskorrekturen stornieren oder den Rest per Rechnungskorrektur mindern.`,
      { number: nr, corrections: t.activeCorrections.join(", ") },
    );
  }
  return null;
}

/** UST-30 §5.1.6: a correction always targets a finalised invoice-family document (never a correction/Storno). */
export function correctionTargetGuard(
  t: Pick<CancelTarget, "type" | "status" | "number" | "cancelledBy">,
): Issue<"correction_target_invalid" | "already_cancelled"> | null {
  if (t.status === "cancelled" && INVOICE_FAMILY.includes(t.type)) {
    return issue(
      "already_cancelled",
      `Rechnung ${t.number ?? ""} wurde bereits durch ${t.cancelledBy ?? "eine Stornorechnung"} storniert.`,
      { number: t.number ?? "", storno: t.cancelledBy ?? "" },
    );
  }
  if (!INVOICE_FAMILY.includes(t.type) || !ISSUED.includes(t.status)) {
    return issue(
      "correction_target_invalid",
      "Korrekturen sind nur zu fertiggestellten Rechnungen möglich (nicht zu Korrekturen oder Stornorechnungen).",
    );
  }
  return null;
}

// ── Storno mirror ───────────────────────────────────────────────────────────────────────────────────────────────

/** INV-10: the Storno snapshot input — a full mirror of the original snapshot. */
export function cancellationSnapshotInput(
  original: DocumentSnapshot,
  p: {
    readonly number: string;
    readonly documentDate: string;
    readonly layoutVersionId: string;
    readonly reason?: string;
  },
): SnapshotInput {
  const lines: SnapshotInputLine[] = original.lines.map((l) => {
    if (l.kind === "heading" || l.kind === "text") return { kind: l.kind, text: l.text };
    if (l.kind === "subtotal") return { kind: "subtotal", text: l.text };
    return {
      kind: "item",
      name: l.name,
      ...(l.description ? { description: l.description } : {}),
      quantityMilli: -l.quantityMilli,
      unitCode: l.unitCode,
      ...(l.unitLabel ? { unitLabel: l.unitLabel } : {}),
      unitPriceMicros: l.unitPriceMicros,
      ...(l.discount
        ? { discount: l.discount.kind === "amount" ? { kind: "amount", cents: -l.discount.cents } : l.discount }
        : {}),
      vatCategory: l.vatCategory,
      vatRateBp: l.vatRateBp,
      ...(l.vatRuleRowId ? { vatRuleRowId: l.vatRuleRowId } : {}),
      ...(l.exemptionReasonCode ? { exemptionReasonCode: l.exemptionReasonCode } : {}),
      ...(l.exemptionReasonText ? { exemptionReasonText: l.exemptionReasonText } : {}),
      ...(l.period ? { period: l.period } : {}),
      ...(l.itemNumber ? { itemNumber: l.itemNumber } : {}),
      ...(l.buyerItemNumber ? { buyerItemNumber: l.buyerItemNumber } : {}),
      ...(l.optional ? { optional: true } : {}),
      ...(l.isLaborCost ? { isLaborCost: true } : {}),
    };
  });
  const t = original.totals;
  const adj = original.adjustment;
  const adjustment = adj
    ? {
        type: adj.type,
        reason: adj.reason,
        ...(adj.reasonCode ? { reasonCode: adj.reasonCode } : {}),
        ...(adj.percentBp !== undefined
          ? { percentBp: adj.percentBp }
          : { amountCents: -(adj.type === "allowance" ? t.allowanceTotalCents : t.chargeTotalCents) }),
      }
    : undefined;
  const prefix = original.payment.paymentReference.endsWith(original.number)
    ? original.payment.paymentReference.slice(0, -original.number.length)
    : "";
  const r = original.references;
  const hadXml = original.einvoice.format !== "none";
  return {
    type: "cancellation",
    number: p.number,
    documentDate: p.documentDate,
    ...(original.supplyDate ? { supplyDate: original.supplyDate } : {}),
    language: original.language,
    currency: original.currency,
    ...(original.fx ? { fx: original.fx } : {}),
    priceMode: original.priceMode,
    taxCase: original.taxCase,
    flags: {
      ...(original.flags.propertyRelated ? { propertyRelated: true } : {}),
      ...(original.flags.constructionWork ? { constructionWork: true } : {}),
    },
    seller: original.seller,
    buyer: original.buyer,
    ...(original.delivery ? { delivery: original.delivery } : {}),
    references: {
      ...(r.buyerReference ? { buyerReference: r.buyerReference } : {}),
      ...(r.contractReference ? { contractReference: r.contractReference } : {}),
      ...(r.orderReference ? { orderReference: r.orderReference } : {}),
      ...(r.salesOrderReference ? { salesOrderReference: r.salesOrderReference } : {}),
      ...(r.deliveryNoteNumbers ? { deliveryNoteNumbers: r.deliveryNoteNumbers } : {}),
      ...(r.projectReference ? { projectReference: r.projectReference } : {}),
    },
    original: { number: original.number, date: original.documentDate },
    texts: p.reason?.trim() ? { headText: `Grund der Stornierung: ${p.reason.trim()}` } : {},
    lines,
    ...(adjustment ? { adjustment } : {}),
    ...(original.deductions?.length
      ? {
          deductions: original.deductions.map((d) => ({
            ...d,
            byGroup: d.byGroup.map((x) => ({
              ...x,
              netCents: -x.netCents,
              vatCents: -x.vatCents,
              grossCents: -x.grossCents,
            })),
            deductedGrossCents: -d.deductedGrossCents,
          })),
        }
      : {}),
    payment: {
      method: original.payment.method,
      ...(original.payment.methodText ? { methodText: original.payment.methodText } : {}),
      dueDays: original.payment.dueDays,
      ...(original.payment.bankAccount ? { bankAccount: original.payment.bankAccount } : {}),
      ...(prefix ? { paymentReferencePrefix: prefix } : {}),
      showEpcQr: original.payment.showEpcQr,
    },
    // ER-03 rule R1 (EC-DOC-88/89): a Storno of an E-Rechnung is an E-Rechnung; otherwise the original's decision
    // (the reference date is the original's) and always the original's format family (§4.6.3).
    einvoice: {
      format: original.einvoice.format,
      ...(hadXml
        ? { decision: "MUST_E" as const }
        : original.einvoice.decision
          ? { decision: original.einvoice.decision }
          : {}),
    },
    layoutVersionId: p.layoutVersionId,
  };
}

// ── Rechnungskorrektur ──────────────────────────────────────────────────────────────────────────────────────────

/** A change of one original item line (1-based `position` among item lines). Absent fields stay as invoiced. */
export interface CreditChange {
  readonly position: number;
  readonly quantityMilli?: number | undefined;
  readonly unitPriceMicros?: number | undefined;
}

/**
 * INV-12: the negative delta lines of a Rechnungskorrektur. Without changes the whole invoice is credited
 * (Rechnungskorrektur über den vollen Betrag, §4.8). A reduced quantity → `−Δqty × price`; a reduced price →
 * `−qty × Δprice` („Preisminderung: …“); both → two lines. An amount discount cannot be split proportionally, so
 * such a line is reversed in full and re-added with the new values.
 */
export function creditDeltaLines(originalLines: readonly DraftLine[], changes: readonly CreditChange[]): DraftLine[] {
  const items = originalLines.filter((l) => l.kind === "item");
  const out: DraftLine[] = [];
  const full = changes.length === 0;
  items.forEach((l, i) => {
    const qty = l.quantityMilli ?? 0;
    const price = l.unitPriceMicros ?? 0;
    const c = changes.find((x) => x.position === i + 1);
    if (!full && !c) return;
    const newQty = full ? 0 : (c?.quantityMilli ?? qty);
    const newPrice = full ? price : (c?.unitPriceMicros ?? price);
    if (newQty === qty && newPrice === price) return;
    if (newQty === 0) {
      out.push({ ...l, quantityMilli: -qty });
      return;
    }
    if (l.discount?.kind === "amount") {
      out.push({ ...l, quantityMilli: -qty });
      out.push({ ...l, quantityMilli: newQty, unitPriceMicros: newPrice });
      return;
    }
    if (newQty !== qty) out.push({ ...l, quantityMilli: newQty - qty });
    if (newPrice !== price) {
      out.push({
        ...l,
        name: `Preisminderung: ${l.name ?? ""}`,
        quantityMilli: -newQty,
        unitPriceMicros: price - newPrice,
      });
    }
  });
  return out;
}

const groupLabel = (x: GroupAmount) => (x.category === "S" ? `${x.rateBp / 100} %` : x.category);
const k = (x: GroupAmount) => `${x.category}/${x.rateBp}`;

/** UST-30 RI-07: a credit must reduce, and Σ(original + all credits) ≥ 0 per VAT group. */
export function creditCapFindings(
  original: readonly GroupAmount[],
  earlierCredits: readonly (readonly GroupAmount[])[],
  next: readonly GroupAmount[],
  currency = "EUR",
): Finding[] {
  const nextGross = next.reduce((s, x) => s + x.netCents + x.vatCents, 0);
  if (nextGross >= 0) {
    return [
      finding(
        "correction_not_reducing",
        "E",
        "UST-30",
        "pflichtangaben",
        "Eine Rechnungskorrektur muss den Rechnungsbetrag mindern. Für Nachberechnungen bitte eine neue Rechnung erstellen.",
        { field: "lines" },
      ),
    ];
  }
  const remaining = sumGroups(original, ...earlierCredits);
  const after = sumGroups(original, ...earlierCredits, next);
  const out: Finding[] = [];
  const touched = new Set(next.map(k));
  for (const key of touched) {
    const a = after.find((x) => k(x) === key);
    if (a && a.netCents >= 0 && a.vatCents >= 0) continue;
    if (!a) continue; // exactly zero
    const r = remaining.find((x) => k(x) === key);
    const left = r ? r.netCents + r.vatCents : 0;
    const group = groupLabel(a);
    out.push(
      finding(
        "correction_exceeds_original",
        "E",
        "UST-30",
        "pflichtangaben",
        `Die Korrekturen übersteigen den Rechnungsbetrag (${group}: noch ${formatAmount(left, currency, "de")} korrigierbar).`,
        { field: "lines", params: { group, remaining: left } },
      ),
    );
  }
  return out;
}

/** §4.2.5: the effect of a finalised credit on the original's open amount and payment status. */
export function applyCredit(i: {
  readonly openCents: number;
  readonly status: string;
  readonly creditGrossCents: number;
}): {
  originalOpenCents: number;
  originalStatus: string;
  correctionOpenCents: number;
  appliedCents: number;
} {
  const credit = Math.abs(i.creditGrossCents);
  const applied = Math.min(credit, Math.max(0, i.openCents));
  const open = i.openCents - applied;
  const status = open === 0 && applied > 0 ? (i.status === "open" ? "credited" : "paid") : i.status;
  return {
    originalOpenCents: open,
    originalStatus: status,
    correctionOpenCents: applied - credit,
    appliedCents: applied,
  };
}

/** INV-15: a Storno of a credit gives the original back what the credit absorbed. */
export function revertCredit(i: {
  readonly openCents: number;
  readonly status: string;
  readonly appliedCents: number;
}): {
  openCents: number;
  status: string;
} {
  const open = i.openCents + i.appliedCents;
  if (i.appliedCents === 0 || open <= 0) return { openCents: open, status: i.status };
  const status = i.status === "credited" ? "open" : i.status === "paid" ? "partially_paid" : i.status;
  return { openCents: open, status };
}

// ── Rechnungsberichtigung ───────────────────────────────────────────────────────────────────────────────────────

export const RECTIFIED_FIELD_LABELS: Readonly<Record<string, string>> = {
  "buyer.name": "Name des Leistungsempfängers",
  "buyer.address": "Anschrift des Leistungsempfängers",
  "buyer.vatId": "USt-IdNr. des Leistungsempfängers",
  "buyer.taxNumber": "Steuernummer des Leistungsempfängers",
  "seller.taxNumber": "Steuernummer des leistenden Unternehmers",
  "seller.vatId": "USt-IdNr. des leistenden Unternehmers",
  supplyDate: "Leistungsdatum",
  lines: "Menge und Art der Leistung",
  buyerReference: "Käuferreferenz",
  orderReference: "Bestellnummer",
  contractReference: "Vertragsnummer",
  delivery: "Lieferanschrift",
};

const same = (a: unknown, b: unknown) => canonicalize(a ?? null) === canonicalize(b ?? null);

/** INV-13: which formal items differ between the original and the corrected snapshot (keys of the label map). */
export function detectRectifiedFields(
  original: Pick<DocumentSnapshot, "buyer" | "seller" | "supplyDate" | "lines" | "references" | "delivery">,
  next: Pick<DocumentSnapshot, "buyer" | "seller" | "supplyDate" | "lines" | "references" | "delivery">,
): string[] {
  const out: string[] = [];
  const o = original;
  const n = next;
  if (!same(o.buyer.name, n.buyer.name) || !same(o.buyer.tradeName, n.buyer.tradeName)) out.push("buyer.name");
  if (!same(o.buyer.address, n.buyer.address) || !same(o.buyer.contactPerson, n.buyer.contactPerson))
    out.push("buyer.address");
  if (!same(o.buyer.vatId, n.buyer.vatId)) out.push("buyer.vatId");
  if (!same(o.buyer.taxNumber, n.buyer.taxNumber)) out.push("buyer.taxNumber");
  if (!same(o.seller.taxNumber, n.seller.taxNumber)) out.push("seller.taxNumber");
  if (!same(o.seller.vatId, n.seller.vatId)) out.push("seller.vatId");
  if (!same(o.supplyDate, n.supplyDate)) out.push("supplyDate");
  const lineView = (s: typeof o) =>
    s.lines.map((l) =>
      l.kind === "item"
        ? { n: l.name, d: l.description, q: l.quantityMilli, u: l.unitCode, p: l.unitPriceMicros, per: l.period }
        : l.kind,
    );
  if (!same(lineView(o), lineView(n))) out.push("lines");
  if (!same(o.references.buyerReference, n.references.buyerReference)) out.push("buyerReference");
  if (!same(o.references.orderReference, n.references.orderReference)) out.push("orderReference");
  if (!same(o.references.contractReference, n.references.contractReference)) out.push("contractReference");
  if (!same(o.delivery, n.delivery)) out.push("delivery");
  return out;
}

/** UST-30/UST-31: identical amounts per VAT group, and at least one formal item changed. */
export function rectificationFindings(
  original: readonly GroupAmount[],
  next: readonly GroupAmount[],
  changedFields: readonly string[],
): Finding[] {
  const a = sumGroups(original);
  const b = sumGroups(next);
  if (!same(a, b)) {
    return [
      finding(
        "rectification_amount_changed",
        "E",
        "UST-31",
        "pflichtangaben",
        "Eine Rechnungsberichtigung darf die Beträge nicht ändern. Für Betragsänderungen bitte Rechnungskorrektur oder Storno verwenden.",
        { field: "lines" },
      ),
    ];
  }
  if (changedFields.length === 0) {
    return [
      finding(
        "rectification_no_change",
        "E",
        "UST-30",
        "pflichtangaben",
        "Die Berichtigung enthält keine Änderung gegenüber der Originalrechnung.",
      ),
    ];
  }
  return [];
}
