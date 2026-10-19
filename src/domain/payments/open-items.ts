/**
 * Open items (OPOS), aging buckets, as-of view and overdue derivation (F05 PAY-001…PAY-003, PAY-007, PAY-043;
 * 02 §6: overdue is derived at read time, never stored). Pure; `asOf` is a Europe/Berlin calendar date.
 *
 * As-of (PAY-003): documents with `documentDate ≤ asOf`, payment rows with `date ≤ asOf`. A reversal is a row of its
 * own with negated amounts and its own date, so a payment reversed after the as-of date still counts (T05-002).
 */
import { type CsvVariant, formatCsv } from "../csv/export";
import { OPEN_ITEM_COLUMNS } from "../csv/lists";
import { type CalendarDate, daysBetween } from "../time/calendar-date";

export const DEFAULT_AGING_EDGES = [30, 60, 90] as const;

export interface OpenItemDocument {
  id: string;
  kind: "salesDocument" | "opening_item";
  number: string;
  contactId?: string;
  contactName: string;
  documentDate: string;
  dueDate?: string;
  payableCents: number;
  /** Applied Rechnungskorrekturen up to the as-of date (F04 §4.2.5): reduce the open amount, not the amount column. */
  creditedCents?: number;
  currency: string;
  /** `correction` = a credit correction with an open refund (negative item, PAY-033 b). */
  docType?: string;
}

export interface SettlementRow {
  targetKind: "salesDocument" | "opening_item" | "contactCredit";
  targetId: string;
  date: string;
  /** amountCents + Σ differences (RI-09); for contactCredit rows the signed credit movement. */
  settlesCents: number;
  /** Money moved (for the „Bezahlt“ column; excludes differences). */
  amountCents: number;
}

export interface OpenItem extends OpenItemDocument {
  paidCents: number;
  openCents: number;
  daysOverdue: number;
  overdue: boolean;
  bucket: string;
}

export interface CreditBalance {
  contactId: string;
  contactName: string;
  balanceCents: number;
}

export interface OpenItemsResult {
  asOf: string;
  items: OpenItem[];
  credits: CreditBalance[];
  totals: {
    openCents: number;
    overdueCents: number;
    dueWithin7Cents: number;
    creditCents: number;
    buckets: { key: string; label: string; openCents: number; count: number }[];
  };
}

/** Bucket keys/labels for the edges [30, 60, 90]: nicht fällig, 1–30, 31–60, 61–90, > 90 (PAY-002). */
export function agingBuckets(edges: readonly number[] = DEFAULT_AGING_EDGES): { key: string; label: string }[] {
  const out = [{ key: "not_due", label: "nicht fällig" }];
  let from = 1;
  for (const e of edges) {
    out.push({ key: `${from}-${e}`, label: `${from}–${e}` });
    from = e + 1;
  }
  out.push({ key: `gt${from - 1}`, label: `> ${from - 1}` });
  return out;
}

export function agingBucket(daysOverdue: number, edges: readonly number[] = DEFAULT_AGING_EDGES): string {
  if (daysOverdue <= 0) return "not_due";
  let from = 1;
  for (const e of edges) {
    if (daysOverdue <= e) return `${from}-${e}`;
    from = e + 1;
  }
  return `gt${from - 1}`;
}

/** Days past the due date on `asOf` (0 when not yet due or no due date). */
export const daysOverdue = (dueDate: string | undefined, asOf: string): number =>
  dueDate ? Math.max(0, daysBetween(dueDate as CalendarDate, asOf as CalendarDate)) : 0;

/** PAY-043 / 02 §6: overdue = open or partially paid and `dueDate < today`. */
export const isOverdue = (p: { paymentStatus?: string; dueDate?: string }, today: string): boolean =>
  (p.paymentStatus === "open" || p.paymentStatus === "partially_paid") && p.dueDate !== undefined && p.dueDate < today;

export function computeOpenItems(input: {
  documents: readonly OpenItemDocument[];
  rows: readonly SettlementRow[];
  asOf: string;
  edges?: readonly number[];
  contactNames?: ReadonlyMap<string, string>;
}): OpenItemsResult {
  const edges = input.edges ?? DEFAULT_AGING_EDGES;
  const asOf = input.asOf;
  const settled = new Map<string, { settles: number; paid: number }>();
  const credit = new Map<string, number>();
  for (const r of input.rows) {
    if (r.date > asOf) continue;
    if (r.targetKind === "contactCredit") {
      credit.set(r.targetId, (credit.get(r.targetId) ?? 0) + r.settlesCents);
      continue;
    }
    const k = `${r.targetKind}:${r.targetId}`;
    const s = settled.get(k) ?? { settles: 0, paid: 0 };
    s.settles += r.settlesCents;
    s.paid += r.amountCents;
    settled.set(k, s);
  }
  const buckets = agingBuckets(edges).map((b) => ({ ...b, openCents: 0, count: 0 }));
  const items: OpenItem[] = [];
  let openCents = 0;
  let overdueCents = 0;
  let dueWithin7Cents = 0;
  for (const d of input.documents) {
    if (d.documentDate > asOf) continue;
    const s = settled.get(`${d.kind}:${d.id}`) ?? { settles: 0, paid: 0 };
    const open = d.payableCents - (d.creditedCents ?? 0) - s.settles;
    if (open === 0) continue;
    // An open refund (negative item, PAY-033 b) is owed by us: never overdue, no aging.
    const days = open > 0 ? daysOverdue(d.dueDate, asOf) : 0;
    const bucket = agingBucket(days, edges);
    const overdue = open > 0 && d.dueDate !== undefined && d.dueDate < asOf;
    items.push({ ...d, paidCents: s.paid, openCents: open, daysOverdue: days, overdue, bucket });
    openCents += open;
    if (overdue) overdueCents += open;
    if (open > 0 && d.dueDate && !overdue && daysBetween(asOf as CalendarDate, d.dueDate as CalendarDate) <= 7) {
      dueWithin7Cents += open;
    }
    const b = buckets.find((x) => x.key === bucket);
    if (b) {
      b.openCents += open;
      b.count++;
    }
  }
  const credits = [...credit.entries()]
    .filter(([, c]) => c !== 0)
    .map(([contactId, balanceCents]) => ({
      contactId,
      contactName: input.contactNames?.get(contactId) ?? "",
      balanceCents,
    }));
  items.sort((a, b) => (a.dueDate ?? a.documentDate).localeCompare(b.dueDate ?? b.documentDate));
  return {
    asOf,
    items,
    credits,
    totals: {
      openCents,
      overdueCents,
      dueWithin7Cents,
      creditCents: credits.reduce((s, c) => s + c.balanceCents, 0),
      buckets,
    },
  };
}

/**
 * PAY-006 OPOS CSV through the shared list exporter (F09 EXP-021): „CSV (Excel)" by default — `;`, decimal comma,
 * UTF-8 with BOM and the formula-injection guard (EXP-022) — or „CSV (technisch)".
 */
export function openItemsCsv(r: OpenItemsResult, variant: CsvVariant = "excel"): string {
  return formatCsv(OPEN_ITEM_COLUMNS, r.items, variant);
}
