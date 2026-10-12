/**
 * E-Rechnung issuing obligation by supply date (01 ER-03, F04 App. D rules R8–R11; § 14 UStG i. d. F.
 * Wachstumschancengesetz, transition § 27 Abs. 38 UStG). Date-effective data — the decision function never
 * hard-codes the 2027/2028 dates or the 800.000 € threshold.
 */

import type { Result } from "../result";
import type { CalendarDate } from "../time/calendar-date";
import { defineRuleTable, lookupRule, type RuleMissing, type RuleRow } from "./rule-table";

export type EinvoiceObligation =
  /** Paper allowed; other electronic formats (PDF) only with consent (§ 27 Abs. 38 Nr. 1 UStG). */
  | { readonly mode: "transition_consent" }
  /** As above if the issuer's prior-year Gesamtumsatz ≤ threshold, else E-Rechnung (§ 27 Abs. 38 Nr. 2 UStG). */
  | { readonly mode: "turnover_threshold"; readonly priorYearLimitCents: number }
  /** E-Rechnung mandatory (§ 14 Abs. 1 UStG). */
  | { readonly mode: "mandatory" };

export const EINVOICE_OBLIGATION = defineRuleTable<EinvoiceObligation>("einvoice_obligation", [
  {
    validFrom: "2007-01-01",
    validTo: "2026-12-31",
    value: { mode: "transition_consent" },
    source: "§ 27 Abs. 38 Nr. 1 UStG (Übergangsregelung für Umsätze bis 31.12.2026)",
  },
  {
    validFrom: "2027-01-01",
    validTo: "2027-12-31",
    value: { mode: "turnover_threshold", priorYearLimitCents: 80_000_000 },
    source: "§ 27 Abs. 38 Nr. 2 UStG (Vorjahresgesamtumsatz ≤ 800.000 €)",
  },
  {
    validFrom: "2028-01-01",
    value: { mode: "mandatory" },
    source: "§ 14 Abs. 1 UStG i. d. F. Wachstumschancengesetz (BGBl. 2024 I Nr. 108)",
  },
]);

export const lookupEinvoiceObligation = (supplyDate: CalendarDate): Result<RuleRow<EinvoiceObligation>, RuleMissing> =>
  lookupRule(EINVOICE_OBLIGATION, supplyDate);
