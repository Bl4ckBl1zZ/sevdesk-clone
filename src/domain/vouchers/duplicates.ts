/**
 * Duplicate detection for vouchers (F06 VOU-050…053, EC-160, EC-VOU-24/25; GOBD-02).
 *
 *  - exact: identical SHA-256 of an original file (VOU-050) — handled at file capture;
 *  - E-Rechnung identity (VOU-051): same (seller VAT ID or normalised name, BT-1 number, BT-2 date) → strong;
 *  - fuzzy (VOU-052): *stark* same supplier key + same normalised number; *wahrscheinlich* same supplier key, same
 *    gross, document date ± 3 days; *möglich* same gross, same date, name similarity ≥ 0.85 (Jaro-Winkler).
 * Pairs dismissed with „Keine Dublette“ (VOU-053, `duplicateDismissals`) are never reported again. Pure.
 */
import { type CalendarDate, daysBetween, formatGermanDate } from "../time/calendar-date";
import { jaroWinkler, normaliseSupplierName, supplierKeys } from "./supplier-key";

export type DuplicateLevel = "strong" | "probable" | "possible";

export interface DuplicateCandidate {
  id: string;
  /** Display number (BE-… or the supplier's number). */
  label?: string;
  supplierName?: string;
  supplierVatId?: string;
  supplierIban?: string;
  documentNumber?: string;
  documentDate: string;
  grossCents: number;
  /** Dismissed partner ids (both directions are checked). */
  duplicateDismissals?: readonly string[];
  /** Original file hashes. */
  sha256s?: readonly string[];
}

export interface DuplicateFinding {
  id: string;
  level: DuplicateLevel;
  reason: string;
  label?: string;
}

/** VOU-052 number normalisation: uppercase, no spaces/dashes/slashes, leading zeros stripped. */
export function normaliseDocumentNumber(n: string): string {
  return n
    .toUpperCase()
    .replace(/[\s\-/_.]/g, "")
    .replace(/^0+(?=.)/, "");
}

const LEVEL_ORDER: Record<DuplicateLevel, number> = { strong: 0, probable: 1, possible: 2 };

const dismissed = (a: DuplicateCandidate, b: DuplicateCandidate) =>
  (a.duplicateDismissals ?? []).includes(b.id) || (b.duplicateDismissals ?? []).includes(a.id);

/** All duplicate findings of `voucher` among `others`, strongest first. */
export function findDuplicates(voucher: DuplicateCandidate, others: readonly DuplicateCandidate[]): DuplicateFinding[] {
  const keys = new Set(
    supplierKeys({ vatId: voucher.supplierVatId, iban: voucher.supplierIban, name: voucher.supplierName }),
  );
  const nameNorm = voucher.supplierName ? normaliseSupplierName(voucher.supplierName) : "";
  const numberNorm = voucher.documentNumber ? normaliseDocumentNumber(voucher.documentNumber) : "";
  const out: DuplicateFinding[] = [];
  for (const o of others) {
    if (o.id === voucher.id || dismissed(voucher, o)) continue;
    const label = o.label ?? o.documentNumber;
    const push = (level: DuplicateLevel, reason: string) =>
      out.push({ id: o.id, level, reason, ...(label ? { label } : {}) });
    if (voucher.sha256s?.some((h) => o.sha256s?.includes(h))) {
      push("strong", "identische Datei");
      continue;
    }
    const oKeys = supplierKeys({ vatId: o.supplierVatId, iban: o.supplierIban, name: o.supplierName });
    const sameSupplier = oKeys.some((k) => keys.has(k));
    const oNumber = o.documentNumber ? normaliseDocumentNumber(o.documentNumber) : "";
    if (sameSupplier && numberNorm && oNumber === numberNorm) {
      push(
        "strong",
        o.documentDate === voucher.documentDate ? "gleiche Rechnung (Nummer und Datum)" : "gleiche Belegnummer",
      );
      continue;
    }
    const days = Math.abs(daysBetween(voucher.documentDate as CalendarDate, o.documentDate as CalendarDate));
    if (sameSupplier && o.grossCents === voucher.grossCents && days <= 3) {
      push("probable", `gleicher Lieferant und Betrag, Datum ${formatGermanDate(o.documentDate as CalendarDate)}`);
      continue;
    }
    if (
      o.grossCents === voucher.grossCents &&
      days === 0 &&
      nameNorm &&
      o.supplierName &&
      jaroWinkler(nameNorm, normaliseSupplierName(o.supplierName)) >= 0.85
    ) {
      push("possible", "gleicher Betrag und Tag, ähnlicher Lieferantenname");
    }
  }
  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

/** EC-VOU-24 (strong, blocks finalisation) and EC-VOU-25 (probable/possible, ⚑ warning) messages. */
export function duplicateMessage(f: DuplicateFinding): string {
  const number = f.label ?? "einem anderen Beleg";
  return f.level === "strong"
    ? `Dieser Beleg ist vermutlich eine Dublette von ${number}. Bitte als Dublette markieren oder bestätigen, dass es keine ist.`
    : `Mögliche Dublette von ${number} (${f.reason}).`;
}
