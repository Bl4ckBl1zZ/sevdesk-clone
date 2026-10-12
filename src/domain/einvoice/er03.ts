/**
 * ER-03 decision function `requiresERechnung` (01 ER-03, F04 App. D, INV-18, T-TAB-03). First matching rule wins:
 *
 *  R0 non-invoice types → NOT_REQUIRED · R1 Storno/correction of an E-Rechnung → MUST_E · R2 B2G (DE) → MUST_E ·
 *  R3 consumer → NOT_REQUIRED · R4 recipient abroad → NOT_REQUIRED · R5 KU issuer → MAY_PAPER_OR_PDF ·
 *  R6 Kleinbetrag (EUR, never §13b) → MAY_PAPER_OR_PDF · R7 all § 4 Nr. 8–29 exempt → MAY_PAPER_OR_PDF ·
 *  R8–R11 by supply date via the `einvoice_obligation` rule table (transition / 800.000 € threshold / mandatory).
 *
 * The reference date is the supply end (`date`, `period.to`, last day of `month`); advance/partial invoices use the
 * document date and — when an expected supply date is set — also its end, and the stricter decision wins
 * (F04 9.5, LEGAL-OPEN: 01 open item 11). Cancellations/corrections use the original's reference date.
 */
import type { Er03Decision, SalesDocType, SupplyDate, TaxCase } from "../documents/snapshot";
import { supplyEnd } from "../documents/snapshot";
import { lookupEinvoiceObligation } from "../rules/einvoice-obligation";
import { isWithinKleinbetragLimit } from "../rules/thresholds";
import type { CalendarDate } from "../time/calendar-date";

export type Er03Warning = "turnover_provisional" | "turnover_missing";

export interface Er03Input {
  readonly docType: SalesDocType;
  readonly taxCase: TaxCase;
  /** Any line with category AE (§ 13b line-wise in domestic documents). */
  readonly hasAeLine?: boolean;
  readonly issuer: {
    readonly isKleinunternehmer: boolean;
    /** Gesamtumsatz of the calendar year before the reference date (SET-043; running total if not confirmed). */
    readonly priorYearTurnover: { readonly cents: number; readonly final: boolean } | null;
    readonly foundedOn?: string;
  };
  readonly recipient: {
    readonly countryCode: string;
    readonly isConsumer: boolean;
    readonly isPublicAuthority: boolean;
  };
  readonly refDate: string;
  /** Advance/partial invoices: end of the expected supply date, evaluated as a second reference date. */
  readonly expectedSupplyEnd?: string;
  readonly grossEurCents: number;
  readonly allExempt4Nr8to29?: boolean;
  /** Cancellation/correction: the original invoice. */
  readonly original?: { readonly hadXml: boolean; readonly refDate: string };
}

export interface Er03Result {
  readonly decision: Er03Decision;
  readonly ruleId: string;
  readonly reason: string;
  readonly warnings: readonly Er03Warning[];
}

const STRICTNESS: Record<Er03Decision, number> = {
  NOT_REQUIRED: 0,
  MAY_PAPER_OR_PDF: 1,
  PDF_NEEDS_CONSENT: 2,
  MUST_E: 3,
};

const NON_INVOICE: readonly SalesDocType[] = ["quote", "order_confirmation", "delivery_note", "proforma", "reminder"];

const r = (decision: Er03Decision, ruleId: string, reason: string, warnings: Er03Warning[] = []): Er03Result => ({
  decision,
  ruleId,
  reason,
  warnings,
});

function evaluate(input: Er03Input, refDate: string): Er03Result {
  if (NON_INVOICE.includes(input.docType)) return r("NOT_REQUIRED", "R0", "Kein Rechnungsdokument.");
  const correction = input.docType === "cancellation" || input.docType === "correction";
  if (correction && input.original?.hadXml) {
    return r("MUST_E", "R1", "Korrektur einer E-Rechnung muss ebenfalls eine E-Rechnung sein (ER-04).");
  }
  const rec = input.recipient;
  if (rec.isPublicAuthority && rec.countryCode === "DE") {
    return r("MUST_E", "R2", "Öffentlicher Auftraggeber (B2G): XRechnung ist Pflicht.");
  }
  if (rec.isConsumer) return r("NOT_REQUIRED", "R3", "Privatkunde: keine E-Rechnungspflicht.");
  if (rec.countryCode !== "DE") return r("NOT_REQUIRED", "R4", "Empfänger im Ausland: keine E-Rechnungspflicht.");
  if (input.issuer.isKleinunternehmer) {
    return r(
      "MAY_PAPER_OR_PDF",
      "R5",
      "Kleinunternehmer: Ausstellung einer E-Rechnung nicht erforderlich (§ 34a UStDV).",
    );
  }
  const date = refDate as CalendarDate;
  const rc13b = input.taxCase === "reverse_charge_13b" || input.hasAeLine === true;
  const kleinbetrag = isWithinKleinbetragLimit(input.grossEurCents, date);
  if (!rc13b && kleinbetrag.ok && kleinbetrag.value) {
    return r("MAY_PAPER_OR_PDF", "R6", "Kleinbetragsrechnung bis 250 € (§ 33 UStDV).");
  }
  if (input.allExempt4Nr8to29) {
    return r("MAY_PAPER_OR_PDF", "R7", "Steuerfreie Umsätze nach § 4 Nr. 8–29 UStG: keine E-Rechnungspflicht.");
  }
  const obligation = lookupEinvoiceObligation(date);
  const mode = obligation.ok ? obligation.value.value : ({ mode: "mandatory" } as const);
  if (mode.mode === "transition_consent") {
    return r(
      "PDF_NEEDS_CONSENT",
      "R8",
      "Übergangszeit: Papier oder (mit Zustimmung) PDF zulässig (§ 27 Abs. 38 Nr. 1 UStG).",
    );
  }
  if (mode.mode === "turnover_threshold") {
    const priorYear = Number(refDate.slice(0, 4)) - 1;
    const foundedAfterPriorYear = input.issuer.foundedOn !== undefined && input.issuer.foundedOn > `${priorYear}-12-31`;
    const turnover = foundedAfterPriorYear ? { cents: 0, final: true } : input.issuer.priorYearTurnover;
    if (!turnover) {
      return r("MUST_E", "R10u", `Gesamtumsatz ${priorYear} fehlt – E-Rechnung vorsorglich Pflicht.`, [
        "turnover_missing",
      ]);
    }
    const warnings: Er03Warning[] = turnover.final ? [] : ["turnover_provisional"];
    if (turnover.cents <= mode.priorYearLimitCents) {
      return r(
        "PDF_NEEDS_CONSENT",
        "R9",
        `Vorjahresumsatz ≤ 800.000 €: Papier oder (mit Zustimmung) PDF zulässig (§ 27 Abs. 38 Nr. 2 UStG).`,
        warnings,
      );
    }
    return r("MUST_E", "R10", "Vorjahresumsatz über 800.000 €: E-Rechnung ist Pflicht.", warnings);
  }
  return r("MUST_E", "R11", "Ab 2028 ist die E-Rechnung für Inlandsumsätze an Unternehmer Pflicht.");
}

export function requiresERechnung(input: Er03Input): Er03Result {
  const correction = input.docType === "cancellation" || input.docType === "correction";
  const primary = evaluate(input, correction && input.original ? input.original.refDate : input.refDate);
  const isAdvance = input.docType === "advance_invoice" || input.docType === "partial_invoice";
  if (!isAdvance || !input.expectedSupplyEnd) return primary;
  // LEGAL-OPEN: 01 open item 11 — advance invoices: the stricter of document date and expected supply date.
  const second = evaluate(input, input.expectedSupplyEnd);
  return STRICTNESS[second.decision] > STRICTNESS[primary.decision] ? second : primary;
}

/** F04 App. D.1 reference date: supply end for invoices/finals/corrections, document date for advance/partial. */
export function er03RefDate(input: {
  readonly docType: SalesDocType;
  readonly documentDate: string;
  readonly supplyDate?: SupplyDate | undefined;
}): string {
  if (input.docType === "advance_invoice" || input.docType === "partial_invoice") return input.documentDate;
  return input.supplyDate ? supplyEnd(input.supplyDate) : input.documentDate;
}
