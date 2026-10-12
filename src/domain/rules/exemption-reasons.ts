/**
 * Exemption reasons for `exempt` products and lines (F03 PRD-024, §5.4; UST-10; EN 16931 BT-120/BT-121). Each row maps
 * a VATEX code to the § 4 UStG number printed in the `exempt_4` note ("Steuerfreie Leistung nach § 4 Nr. {nr} UStG").
 *
 * LEGAL-OPEN: F03 Q4 / README A17 — the VATEX mapping must be confirmed against the current CEF VATEX code list;
 * unknown codes are refused (`EXEMPTION_REASON_INVALID`) rather than guessed.
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import type { CalendarDate } from "../time/calendar-date";
import { defineRuleTable, lookupRule, type RuleTable } from "./rule-table";

export interface ExemptionReasonValue {
  /** § 4 UStG number incl. letter, e.g. "8 Buchst. a" or "14". */
  readonly ustgNr: string;
  readonly labelDe: string;
  /** Exempt supplies without input-tax deduction (UStVA Kz 48): the product shows the Vorsteueraufteilung hint. */
  readonly withoutInputTaxDeduction: boolean;
}

const FLOOR = "2007-01-01";

function reason(code: string, ustgNr: string, labelDe: string, source: string): RuleTable<ExemptionReasonValue> {
  return defineRuleTable<ExemptionReasonValue>(code, [
    { validFrom: FLOOR, value: { ustgNr, labelDe, withoutInputTaxDeduction: true }, source },
  ]);
}

const ART135 = "Art. 135 Abs. 1 MwStSystRL; CEF VATEX-Codeliste";
const ART132 = "Art. 132 Abs. 1 MwStSystRL; CEF VATEX-Codeliste";

export const EXEMPTION_REASONS = {
  "VATEX-EU-135-1A": reason("VATEX-EU-135-1A", "10", "Versicherungsumsätze", `§ 4 Nr. 10 UStG; ${ART135} Buchst. a`),
  "VATEX-EU-135-1B": reason(
    "VATEX-EU-135-1B",
    "8 Buchst. a",
    "Gewährung und Vermittlung von Krediten",
    `§ 4 Nr. 8 Buchst. a UStG; ${ART135} Buchst. b`,
  ),
  "VATEX-EU-135-1C": reason(
    "VATEX-EU-135-1C",
    "8 Buchst. g",
    "Übernahme von Verbindlichkeiten und Sicherheiten",
    `§ 4 Nr. 8 Buchst. g UStG; ${ART135} Buchst. c`,
  ),
  "VATEX-EU-135-1D": reason(
    "VATEX-EU-135-1D",
    "8 Buchst. d",
    "Einlagengeschäft, Kontokorrent, Zahlungs- und Überweisungsverkehr",
    `§ 4 Nr. 8 Buchst. d UStG; ${ART135} Buchst. d`,
  ),
  "VATEX-EU-135-1E": reason(
    "VATEX-EU-135-1E",
    "8 Buchst. b",
    "Umsätze von gesetzlichen Zahlungsmitteln",
    `§ 4 Nr. 8 Buchst. b UStG; ${ART135} Buchst. e`,
  ),
  "VATEX-EU-135-1F": reason(
    "VATEX-EU-135-1F",
    "8 Buchst. e",
    "Umsätze von Wertpapieren und Gesellschaftsanteilen",
    `§ 4 Nr. 8 Buchst. e und f UStG; ${ART135} Buchst. f`,
  ),
  "VATEX-EU-135-1L": reason(
    "VATEX-EU-135-1L",
    "12",
    "Vermietung und Verpachtung von Grundstücken",
    `§ 4 Nr. 12 UStG; ${ART135} Buchst. l`,
  ),
  "VATEX-EU-132-1C": reason(
    "VATEX-EU-132-1C",
    "14",
    "Heilbehandlungen im Bereich der Humanmedizin",
    `§ 4 Nr. 14 UStG; ${ART132} Buchst. c`,
  ),
  "VATEX-EU-132-1I": reason(
    "VATEX-EU-132-1I",
    "21",
    "Schul- und Bildungsleistungen",
    `§ 4 Nr. 21 UStG; ${ART132} Buchst. i`,
  ),
} as const satisfies Record<string, RuleTable<ExemptionReasonValue>>;

export type ExemptionReasonCode = keyof typeof EXEMPTION_REASONS;

export const isExemptionReasonCode = (code: string): code is ExemptionReasonCode =>
  Object.hasOwn(EXEMPTION_REASONS, code);

export function lookupExemptionReason(
  code: string,
  date: CalendarDate,
): Result<ExemptionReasonValue, Issue<"EXEMPTION_REASON_INVALID">> {
  const invalid = issue(
    "EXEMPTION_REASON_INVALID",
    "Unbekannter Befreiungsgrund. Bitte einen Befreiungsgrund aus der Liste wählen.",
    { code },
  );
  if (!isExemptionReasonCode(code)) return err(invalid);
  const row = lookupRule(EXEMPTION_REASONS[code], date);
  return row.ok ? ok(row.value.value) : err(invalid);
}
