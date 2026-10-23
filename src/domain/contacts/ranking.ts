import type { CalendarDate } from "../time/calendar-date";
import { computeContactStats, type StatsDocument } from "./stats";

/**
 * F02 CON-153: the list columns „Offen“ and „Umsatz (Jahr)“ are sortable over all contacts, and the top-customers
 * widget uses the same ranking. Figures follow CON-150 (§5.9): persons count for their organisation, merged contacts
 * for the winner (`rootOf`), revenue = net EUR of the invoice family this calendar year, open = Σ open amounts.
 */
export interface RankedDocument extends StatsDocument {
  readonly contactId: string;
}

export interface ContactFigures {
  readonly contactId: string;
  readonly revenueYearCents: number;
  readonly openCents: number;
}

export function contactRanking(
  docs: readonly RankedDocument[],
  rootOf: (contactId: string) => string,
  today: CalendarDate,
): Map<string, ContactFigures> {
  const byRoot = new Map<string, RankedDocument[]>();
  for (const d of docs) {
    const root = rootOf(d.contactId);
    byRoot.set(root, [...(byRoot.get(root) ?? []), d]);
  }
  const out = new Map<string, ContactFigures>();
  for (const [contactId, list] of byRoot) {
    const s = computeContactStats(list, today);
    out.set(contactId, { contactId, revenueYearCents: s.revenueThisYearCents, openCents: s.openCents });
  }
  return out;
}

export type RankingSort = "open" | "revenueYear";

export function sortRanking<R extends ContactFigures & { readonly displayName: string }>(
  rows: readonly R[],
  by: RankingSort,
  dir: "asc" | "desc",
  limit?: number,
): R[] {
  const key = (r: R) => (by === "open" ? r.openCents : r.revenueYearCents);
  const sorted = [...rows].sort(
    (a, b) => (dir === "asc" ? key(a) - key(b) : key(b) - key(a)) || a.displayName.localeCompare(b.displayName, "de"),
  );
  return limit === undefined ? sorted : sorted.slice(0, limit);
}
