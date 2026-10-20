/**
 * Retention classes (F12 §4.7, rule table `retention-2026.1`, PRV-001; 01 GOBD-20). Pure.
 *
 * `retentionUntil` = 31.12. of (trigger year + N). The trigger year is the document/booking date, the filing period,
 * the superseded date of a Verfahrensdokumentation version or the `at` of an audit entry (see RECORD_RETENTION).
 *
 * § 147 Abs. 3 AO i. d. F. BEG IV (BGBl. 2024 I Nr. 323): Buchungsbelege 8 years from 01.01.2025 for every record whose
 * retention had not expired by then; books, Jahresabschlüsse and Verfahrensdokumentation stay 10 years; Handels- und
 * Geschäftsbriefe 6 years. The row is looked up by the date the period is computed (`asOf`), so a record still kept on
 * 01.01.2025 gets the shortened period.
 */
import type { CalendarDate } from "../time/calendar-date";
import { defineRuleTable, lookupRule } from "./rule-table";

export const RETENTION_RULE_VERSION = "retention-2026.1";

export type RetentionClass = "books10" | "vouchers8" | "letters6" | "none";

export type RetentionYears = Readonly<Record<Exclude<RetentionClass, "none">, number>>;

export const RETENTION_YEARS = defineRuleTable<RetentionYears>("retention_years", [
  {
    validFrom: "1977-01-01",
    validTo: "2024-12-31",
    value: { books10: 10, vouchers8: 10, letters6: 6 },
    source: "§ 147 Abs. 3 AO a. F., § 257 Abs. 4 HGB a. F. (Buchungsbelege 10 Jahre)",
  },
  {
    validFrom: "2025-01-01",
    value: { books10: 10, vouchers8: 8, letters6: 6 },
    source: "§ 147 Abs. 3 AO, § 257 Abs. 4 HGB i. d. F. BEG IV (BGBl. 2024 I Nr. 323)",
  },
]);

/** §4.7 record types → class (tables, or `salesDocuments:<type>` handled by the document helpers). */
export const RECORD_RETENTION: Readonly<Record<string, RetentionClass>> = {
  journalEntries: "books10",
  manualEntries: "books10",
  ledgerAccounts: "books10",
  periods: "books10",
  openingBalances: "books10",
  openingItems: "books10",
  assets: "books10",
  taxFilings: "books10",
  verfahrensdokuVersions: "books10",
  auditLog: "books10",
  integrityCheckpoints: "books10",
  vatIdChecks: "books10",
  imports: "books10",
  salesDocuments: "vouchers8",
  documentArtifacts: "vouchers8",
  vouchers: "vouchers8",
  bankTransactions: "vouchers8",
  bankStatements: "vouchers8",
  cashEntries: "vouchers8",
  cashClosings: "vouchers8",
  payments: "vouchers8",
  sendLog: "letters6",
  sepaMandates: "letters6",
  notifications: "none",
  devMailbox: "none",
  apiAccessLog: "none",
};

export const RETENTION_CLASS_LABEL_DE: Readonly<Record<RetentionClass, string>> = {
  books10: "Bücher und Aufzeichnungen (10 Jahre)",
  vouchers8: "Buchungsbelege (8 Jahre)",
  letters6: "Handels- und Geschäftsbriefe (6 Jahre)",
  none: "Keine Aufbewahrungspflicht",
};

export function retentionYears(cls: Exclude<RetentionClass, "none">, asOf: CalendarDate): number {
  const r = lookupRule(RETENTION_YEARS, asOf);
  if (!r.ok) throw new Error(`retention rule missing for ${asOf}`);
  return r.value.value[cls];
}

/** 31.12. of (trigger year + N); `null` for class `none` (deletable). `asOf` defaults to the trigger date. */
export function retentionUntilFor(cls: RetentionClass, trigger: string, asOf?: string): string | null {
  if (cls === "none") return null;
  const evalDate = (asOf ?? trigger) as CalendarDate;
  return `${Number(trigger.slice(0, 4)) + retentionYears(cls, evalDate)}-12-31`;
}

/** PRV-002 / E-PRV-01: deleting before `retentionUntil` (inclusive) is refused. */
export const isRetained = (retentionUntil: string | null | undefined, today: string): boolean =>
  typeof retentionUntil === "string" && today <= retentionUntil;

export const retentionMessage = (record: string, until: string): string => {
  const [y, m, d] = until.split("-");
  return `${record} ist bis ${d}.${m}.${y} aufbewahrungspflichtig und kann nicht gelöscht werden.`;
};
