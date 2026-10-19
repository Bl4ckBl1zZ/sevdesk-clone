/**
 * F04 DOC-35 „Duplizieren“: a new draft of the same type from any document except a cancellation (corrections and
 * reminders are excluded too — they only exist relative to their original). Advance/partial/final invoices become
 * plain `invoice` drafts. Dropped: number (never part of the values), every date, chain links, payments, acceptance,
 * frozen addresses, the tax-case override and the FX rate — contact data, rates and the tax case are re-resolved by
 * the normal draft save. Pure.
 */
import type { DraftValues } from "../schemas/documents";
import { type DraftType, INVOICE_DRAFT_TYPES, LETTER_TYPES } from "./doc-types";

const NOT_DUPLICABLE: ReadonlySet<string> = new Set(["cancellation", "correction", "reminder"]);
const TO_INVOICE: ReadonlySet<string> = new Set(["advance_invoice", "partial_invoice", "final_invoice"]);

export const DUPLICATE_REFUSED =
  "Stornorechnungen, Rechnungskorrekturen und Mahnungen können nicht dupliziert werden. Bitte einen neuen Beleg anlegen.";

export type DuplicateSource = Omit<DraftValues, "type"> & { type: string; correctionKind?: string };

export function duplicateValues(
  src: DuplicateSource,
): { ok: true; values: DraftValues } | { ok: false; message: string } {
  if (NOT_DUPLICABLE.has(src.type)) return { ok: false, message: DUPLICATE_REFUSED };
  const type = (TO_INVOICE.has(src.type) ? "invoice" : src.type) as DraftType;
  if (![...INVOICE_DRAFT_TYPES, ...LETTER_TYPES].includes(type as never))
    return { ok: false, message: DUPLICATE_REFUSED };
  const {
    correctionKind: _ck,
    documentDate: _dd,
    supplyDate: _sd,
    backdateReason: _br,
    validUntil: _vu,
    chainOrder: _co,
    taxCaseOverride: _tc,
    fxRateToEur: _fx,
    billingAddress: _ba,
    deliveryAddress: _da,
    ...rest
  } = src;
  const lines = src.lines.map(({ sourceLineId: _s, linePeriod: _p, productSyncedVersion: _v, ...l }) => l);
  return { ok: true, values: { ...rest, type, lines } };
}
