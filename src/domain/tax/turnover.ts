/**
 * Turnover monitors (F08 TAX-012/013/017; 01 KU-01, UVA-07, AO-01, ER-03, UVA-06). Pure: the model layer reads the
 * finalised documents, this module decides what each contributes and evaluates the thresholds of the rule tables.
 *
 * - Gesamtumsatz (§ 19 Abs. 2 UStG): net Entgelte in EUR (DOC-56) of every finalised invoice-family document,
 *   Storno and Rechnungskorrektur included with their sign. Final invoices count only the part not already counted
 *   by their deducted advances. Assigned to the calendar year of the supply (end of the supply period).
 * - OSS (§ 3c Abs. 4 UStG): net EUR of B2C distance sales of goods into another EU state plus electronic services
 *   (§ 3a Abs. 5) to consumers in another EU state — other B2C services stay taxable in Germany and do not count.
 */
import { fcToEurCents, parseFxRate } from "../money/convert";
import { formatEuro } from "../money/format";
import { type Issue, issue } from "../result";
import { lookupEinvoiceObligation } from "../rules/einvoice-obligation";
import { isEuVatCountry } from "../rules/eu-vat-countries";
import { lookupRule } from "../rules/rule-table";
import {
  BOOKKEEPING_DUTY_LIMITS,
  IST_TAXATION_LIMIT,
  KLEINUNTERNEHMER_LIMITS,
  OSS_THRESHOLD,
} from "../rules/thresholds";
import type { CalendarDate } from "../time/calendar-date";

// LEGAL-OPEN: 01 KU-01 [UNSURE] — § 19 Abs. 2 UStG counts vereinnahmte Entgelte; the monitor uses invoiced net
// amounts per supply year (the crossing is evaluated on the supply date, 01 open item 2). Fixed-asset sales are
// excluded once assets exist (F08 AST, P2); until then no document line is an asset sale.

export const TURNOVER_DOC_TYPES = [
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
  "correction",
  "cancellation",
] as const;

export interface TurnoverDoc {
  readonly type: string;
  readonly status: string;
  readonly documentDate?: string | undefined;
  /** Last day of the supply (date, period end or month end). */
  readonly supplyEnd?: string | undefined;
  readonly netCents: number;
  readonly currency: string;
  readonly fxRateToEur?: { readonly rate: string } | undefined;
  /** Final invoices: Σ net of the deducted advances (document currency). */
  readonly deductedNetCents?: number | undefined;
}

export function toEurCents(cents: number, d: Pick<TurnoverDoc, "currency" | "fxRateToEur">): number {
  if (d.currency === "EUR" || !d.fxRateToEur) return cents;
  const rate = parseFxRate(d.fxRateToEur.rate);
  return rate.ok ? fcToEurCents(cents, rate.value) : cents;
}

/** Calendar year a document's turnover belongs to (supply end, else document date). */
export function turnoverYear(d: Pick<TurnoverDoc, "supplyEnd" | "documentDate">): number | null {
  const date = d.supplyEnd ?? d.documentDate;
  return date ? Number(date.slice(0, 4)) : null;
}

/** Contribution of one document to the Gesamtumsatz (EUR cents, signed); 0 for drafts and other types. */
export function gesamtumsatzContribution(d: TurnoverDoc): number {
  if (d.status === "draft" || !(TURNOVER_DOC_TYPES as readonly string[]).includes(d.type)) return 0;
  const net = d.type === "final_invoice" ? d.netCents - (d.deductedNetCents ?? 0) : d.netCents;
  return toEurCents(net, d);
}

export function gesamtumsatzOfYear(docs: readonly TurnoverDoc[], year: number): number {
  return docs.reduce((s, d) => (turnoverYear(d) === year ? s + gesamtumsatzContribution(d) : s), 0);
}

// ── OSS (UVA-07, TAX-017, DOC-45, EC-057) ──────────────────────────────────────────────────────────────────────

export interface OssBuyer {
  readonly isConsumer: boolean;
  readonly isPublicAuthority?: boolean | undefined;
  /** A valid foreign VAT ID makes the buyer a business (§ 3a Abs. 2, CON-E26). */
  readonly hasValidVatId?: boolean | undefined;
  readonly countryCode: string;
}

export interface OssLine {
  readonly productType?: "good" | "service" | undefined;
  readonly placeOfSupplyRule?: string | undefined;
  /** Net amount of the line in EUR cents. */
  readonly netEurCents: number;
}

/** Net EUR of the document that counts towards the EU-wide OSS threshold (0 if none). */
export function ossRelevantNetCents(input: {
  readonly buyer: OssBuyer;
  readonly deliveryCountry?: string | undefined;
  readonly lines: readonly OssLine[];
  readonly date: CalendarDate;
}): number {
  const b = input.buyer;
  if (!b.isConsumer || b.isPublicAuthority || b.hasValidVatId) return 0;
  const foreignEu = (c: string) => c !== "DE" && (c === "XI" || isEuVatCountry(c, input.date));
  const dest = (input.deliveryCountry ?? b.countryCode).toUpperCase();
  const seat = b.countryCode.toUpperCase();
  let sum = 0;
  for (const l of input.lines) {
    if (l.productType === "good" && foreignEu(dest)) sum += l.netEurCents;
    else if (l.productType !== "good" && l.placeOfSupplyRule === "electronic" && foreignEu(seat)) sum += l.netEurCents;
  }
  return sum;
}

/**
 * TAX-017: finalising a document with OSS-relevant sales is blocked once the prior year exceeded the threshold or
 * the current year would exceed it with this document. Documents without OSS-relevant sales are never blocked.
 */
export function ossBlock(input: {
  readonly thisNetEurCents: number;
  readonly priorYearEurCents: number;
  readonly currentYearEurCents: number;
  readonly date: CalendarDate;
}): Issue | null {
  if (input.thisNetEurCents <= 0) return null;
  const rule = lookupRule(OSS_THRESHOLD, input.date);
  if (!rule.ok) return null;
  const limit = rule.value.value.limitCents;
  const after = input.currentYearEurCents + input.thisNetEurCents;
  if (input.priorYearEurCents <= limit && after <= limit) return null;
  return issue(
    "oss_threshold_exceeded",
    `Ihre EU-Fernverkäufe an Privatkunden überschreiten ${formatEuro(limit)}. Das OSS-Verfahren wird erst in einer späteren Version unterstützt; diese Rechnung kann nicht mit deutscher Umsatzsteuer ausgestellt werden.`,
    { limit: formatEuro(limit), priorYear: input.priorYearEurCents, currentYear: after },
  );
}

// ── KU monitor and 800k monitors (TAX-012, TAX-013) ────────────────────────────────────────────────────────────

export interface MonitorBar {
  readonly key: "ku_prior_year" | "ku_current_year" | "oss";
  readonly year: number;
  readonly amountCents: number;
  readonly limitCents: number;
  /** Basis points of the limit (10 000 = 100 %). */
  readonly bp: number;
  readonly level: "ok" | "warn_80" | "warn_95" | "exceeded";
}

const bar = (key: MonitorBar["key"], year: number, amountCents: number, limitCents: number): MonitorBar => {
  const bp = limitCents > 0 ? Math.floor((Math.max(0, amountCents) * 10_000) / limitCents) : 0;
  const level = amountCents > limitCents ? "exceeded" : bp >= 9500 ? "warn_95" : bp >= 8000 ? "warn_80" : "ok";
  return { key, year, amountCents, limitCents, bp, level };
};

/**
 * TAX-012 dashboard bars: the prior year against 25 000 € (relevant for this year's KU status), the current year
 * against 100 000 € (25 000 € in the founding year). Limits come from the rule table at `today`.
 */
export function kuMonitor(input: {
  readonly today: CalendarDate;
  readonly priorYearCents: number;
  readonly currentYearCents: number;
  readonly foundedOn?: string | undefined;
}): MonitorBar[] {
  const r = lookupRule(KLEINUNTERNEHMER_LIMITS, input.today);
  if (!r.ok) return [];
  const L = r.value.value;
  const year = Number(input.today.slice(0, 4));
  const founding = input.foundedOn?.slice(0, 4) === String(year);
  return [
    bar("ku_prior_year", year - 1, input.priorYearCents, L.priorYearLimitCents),
    bar("ku_current_year", year, input.currentYearCents, founding ? L.foundingYearLimitCents : L.currentYearLimitCents),
  ];
}

export interface EightHundredKInput {
  readonly today: CalendarDate;
  readonly priorYearCents: number;
  readonly currentYearCents: number;
  /** EÜR profit of the prior year, if known (§ 141 Abs. 1 Nr. 4 AO). */
  readonly priorYearProfitCents?: number | undefined;
  readonly taxationMethod: "soll" | "ist";
  readonly bookkeepingDuty: boolean;
}

export interface MonitorNotice {
  readonly code: "bookkeeping_duty_info" | "er03_mandatory_next_year" | "ist_limit_exceeded";
  readonly severity: "info" | "warning";
  readonly message: string;
}

/**
 * TAX-013: (a) § 141 AO / § 241a HGB → info only (the duty starts after the Finanzamt's notice); (b) ER-03: a prior
 * year above the e-invoice turnover threshold ends the transition relief for the following year; (c) § 20 UStG:
 * Ist-Versteuerung ends the following year. The current year is checked as well so the owner is warned before the
 * year closes (EC-029). All limits come from rule tables looked up for the year concerned.
 */
export function eightHundredKMonitor(i: EightHundredKInput): MonitorNotice[] {
  const out: MonitorNotice[] = [];
  const year = Number(i.today.slice(0, 4));
  const jan1 = (y: number) => `${y}-01-01` as CalendarDate;
  const duty = lookupRule(BOOKKEEPING_DUTY_LIMITS, jan1(year - 1));
  if (duty.ok && !i.bookkeepingDuty) {
    const L = duty.value.value;
    if (i.priorYearCents > L.turnoverCents || (i.priorYearProfitCents ?? 0) > L.profitCents) {
      out.push({
        code: "bookkeeping_duty_info",
        severity: "info",
        message: `Umsatz oder Gewinn ${year - 1} liegen über den Grenzen des § 141 AO (${formatEuro(L.turnoverCents)} / ${formatEuro(L.profitCents)}). Eine Buchführungspflicht beginnt erst nach Mitteilung durch das Finanzamt.`,
      });
    }
  }
  for (const [y, cents] of [
    [year - 1, i.priorYearCents],
    [year, i.currentYearCents],
  ] as const) {
    const ob = lookupEinvoiceObligation(jan1(y + 1));
    if (ob.ok && ob.value.value.mode === "turnover_threshold" && cents > ob.value.value.priorYearLimitCents) {
      out.push({
        code: "er03_mandatory_next_year",
        severity: "warning",
        message: `Gesamtumsatz ${y}: ${formatEuro(cents)} (über ${formatEuro(ob.value.value.priorYearLimitCents)}). Ab 01.01.${y + 1} müssen Sie B2B-Rechnungen im Inland als E-Rechnung ausstellen.`,
      });
    }
    const ist = lookupRule(IST_TAXATION_LIMIT, jan1(y + 1));
    if (i.taxationMethod === "ist" && ist.ok && cents > ist.value.value.priorYearLimitCents) {
      out.push({
        code: "ist_limit_exceeded",
        severity: "warning",
        message: `Gesamtumsatz ${y}: ${formatEuro(cents)} (über ${formatEuro(ist.value.value.priorYearLimitCents)}). Die Ist-Versteuerung (§ 20 UStG) ist ab ${y + 1} nicht mehr zulässig.`,
      });
    }
  }
  return out;
}
