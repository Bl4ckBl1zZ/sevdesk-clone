/**
 * Voucher lines and totals (F06 VOU-002, VOU-003, VOU-005, VOU-022, VOU-028; EC-VOU-03/04/31).
 *
 *  - `computeLine`: net ↔ gross per price mode. Net mode: VAT = round_half_up(net × rate). Gross mode (receipts,
 *    Kleinbetragsrechnungen, VOU-005): VAT = round_half_up(gross × rate / (1 + rate)), net = gross − VAT. The VAT may be
 *    overridden within ±1 cent to match the supplier's document (EC-VOU-04).
 *  - self-assessment rules (VOU-022): the supplier shows net only; `selfAssessedVatCents = round(net × rate)` with the
 *    German rate of the supply date, `vatCents = 0`.
 *  - `voucherTotals`: Σ lines per rate; never computed independently of the lines (EC-VOU-31 by construction).
 *  - `convertLinesToEur`: per line `netEur = round_half_up(net ÷ rate)`, `vatEur = round_half_up(vat ÷ rate)` with
 *    the 03 `FxRate` convention „1 EUR = x FC“; EUR totals = Σ EUR lines (MISC-08).
 * Pure; integer cents only.
 */
import { type FxRate, fcToEurCents, parseFxRate, vatCents as vatOf } from "../money";
import { vatInGross } from "../payments/split";
import { err, type Issue, issue, ok, type Result } from "../result";
import {
  isSelfAssessment,
  type PriceMode,
  type RateTotal,
  type TaxRule,
  type VoucherLine,
  type VoucherTotals,
  type VoucherTotalsEur,
} from "./types";

export const VAT_TOLERANCE_CENTS = 1;

export interface LineInput {
  /** The amount the user typed: net in net mode, gross in gross mode (signed: credit notes are negative). */
  amountCents: number;
  vatRateBp: number;
  /** Optional VAT as printed on the supplier's document (±1 cent of the computed value). */
  vatCents?: number;
}

export interface ComputedLine {
  netCents: number;
  vatCents: number;
  grossCents: number;
  selfAssessedVatCents?: number;
}

/** VOU-002/VOU-022: one line's amounts for the price mode and tax rule. */
export function computeLine(input: LineInput, priceMode: PriceMode, taxRule: TaxRule): ComputedLine {
  if (isSelfAssessment(taxRule)) {
    // The document shows net only; the German VAT is computed by us and owed by us (§13b / §1a).
    const net = input.amountCents;
    return { netCents: net, vatCents: 0, grossCents: net, selfAssessedVatCents: vatOf(net, input.vatRateBp) };
  }
  if (taxRule === "kleinunternehmer_supplier" || taxRule === "exempt_income" || taxRule === "not_taxable") {
    return { netCents: input.amountCents, vatCents: 0, grossCents: input.amountCents };
  }
  if (priceMode === "net") {
    const net = input.amountCents;
    const vat = input.vatCents ?? vatOf(net, input.vatRateBp);
    return { netCents: net, vatCents: vat, grossCents: net + vat };
  }
  const gross = input.amountCents;
  const vat = input.vatCents ?? vatInGross(gross, input.vatRateBp);
  return { netCents: gross - vat, vatCents: vat, grossCents: gross };
}

/** EC-VOU-04: the stored VAT of a line deviates more than 1 cent from net × rate. */
export function checkLineVat(
  line: Pick<VoucherLine, "netCents" | "vatCents" | "vatRateBp">,
  position: number,
): Issue<"line_vat_mismatch"> | null {
  const expected = vatOf(line.netCents, line.vatRateBp);
  if (Math.abs(expected - line.vatCents) <= VAT_TOLERANCE_CENTS) return null;
  const rate = (line.vatRateBp / 100).toLocaleString("de-DE");
  return issue("line_vat_mismatch", `Der USt-Betrag in Position ${position} passt nicht zum Steuersatz ${rate} %.`, {
    position,
    rateBp: line.vatRateBp,
  });
}

/** Totals = Σ lines, VAT breakdown per rate in first-appearance order (VOU-003). */
export function voucherTotals(lines: readonly (ComputedLine & Pick<VoucherLine, "vatRateBp">)[]): VoucherTotals {
  const byRate: RateTotal[] = [];
  let net = 0;
  let vat = 0;
  let self = 0;
  for (const l of lines) {
    net += l.netCents;
    vat += l.vatCents;
    self += l.selfAssessedVatCents ?? 0;
    const row = byRate.find((r) => r.rateBp === l.vatRateBp);
    if (row) {
      row.netCents += l.netCents;
      row.vatCents += l.vatCents;
    } else byRate.push({ rateBp: l.vatRateBp, netCents: l.netCents, vatCents: l.vatCents });
  }
  return { netCents: net, vatCents: vat, grossCents: net + vat, selfAssessedVatCents: self, byRate };
}

export interface StatedTotals {
  /** „Belegsumme“ entered by the user or BT-112 of an E-Rechnung. */
  grossCents?: number;
  /** BG-23 VAT breakdown of an E-Rechnung. */
  byRate?: RateTotal[];
}

const euro = (c: number) =>
  `${(c / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** EC-VOU-03: Σ lines per rate must equal the document's breakdown (and the stated gross). */
export function checkStatedTotals(
  totals: VoucherTotals,
  stated: StatedTotals | undefined,
): Issue<"sum_mismatch"> | null {
  if (!stated) return null;
  const mismatch = (sum: number, total: number) =>
    issue("sum_mismatch", `Die Summe der Positionen (${euro(sum)}) weicht von der Belegsumme (${euro(total)}) ab.`, {
      sumCents: sum,
      totalCents: total,
    });
  if (stated.grossCents !== undefined && stated.grossCents !== totals.grossCents) {
    return mismatch(totals.grossCents, stated.grossCents);
  }
  for (const s of stated.byRate ?? []) {
    const row = totals.byRate.find((r) => r.rateBp === s.rateBp);
    const sum = (row?.netCents ?? 0) + (row?.vatCents ?? 0);
    if (!row || row.netCents !== s.netCents || row.vatCents !== s.vatCents)
      return mismatch(sum, s.netCents + s.vatCents);
  }
  for (const r of totals.byRate) {
    if (stated.byRate && !stated.byRate.some((s) => s.rateBp === r.rateBp)) {
      return mismatch(r.netCents + r.vatCents, 0);
    }
  }
  return null;
}

export interface EurLine {
  netEurCents: number;
  vatEurCents: number;
  /** Self-assessed VAT in EUR = round(netEur × rate) (VOU-022 on the EUR base). */
  selfAssessedVatEurCents: number;
}

export type FxIssue = Issue<"fx_rate_missing" | "fx_rate_invalid">;

/**
 * VOU-028 / MISC-08: per-line EUR conversion. `statedVatEurCents` (E-Rechnung BT-111) takes precedence for the
 * VAT: the difference to the computed EUR VAT is put on the line with the largest VAT (EC-VOU-32 warning).
 */
export function convertLinesToEur(
  lines: readonly (ComputedLine & Pick<VoucherLine, "vatRateBp">)[],
  currency: string,
  fx: { rate: string } | undefined,
  statedVatEurCents?: number,
): Result<{ lines: EurLine[]; totals: VoucherTotalsEur; warning?: Issue<"bt111_differs"> }, FxIssue> {
  if (currency === "EUR") {
    const out = lines.map((l) => ({
      netEurCents: l.netCents,
      vatEurCents: l.vatCents,
      selfAssessedVatEurCents: l.selfAssessedVatCents ?? 0,
    }));
    return ok({ lines: out, totals: sumEur(out) });
  }
  if (!fx) return err(issue("fx_rate_missing", "Bitte Umrechnungskurs angeben oder Kursquelle wählen."));
  const parsed = parseFxRate(fx.rate);
  if (!parsed.ok) return parsed;
  const rate: FxRate = parsed.value;
  const out = lines.map((l) => {
    const netEur = fcToEurCents(l.netCents, rate);
    return {
      netEurCents: netEur,
      vatEurCents: fcToEurCents(l.vatCents, rate),
      selfAssessedVatEurCents: l.selfAssessedVatCents !== undefined ? vatOf(netEur, l.vatRateBp) : 0,
    };
  });
  let warning: Issue<"bt111_differs"> | undefined;
  if (statedVatEurCents !== undefined) {
    const computed = out.reduce((s, l) => s + l.vatEurCents, 0);
    const diff = statedVatEurCents - computed;
    if (diff !== 0 && out.length > 0) {
      let target = 0;
      out.forEach((l, i) => {
        if (Math.abs(l.vatEurCents) > Math.abs((out[target] as EurLine).vatEurCents)) target = i;
      });
      (out[target] as EurLine).vatEurCents += diff;
      warning = issue(
        "bt111_differs",
        `USt in EUR laut Rechnung (${euro(statedVatEurCents)}) weicht von der Umrechnung (${euro(computed)}) ab. Es gilt der Rechnungswert.`,
        { givenCents: statedVatEurCents, computedCents: computed },
      );
    }
  }
  return ok({ lines: out, totals: sumEur(out), ...(warning ? { warning } : {}) });
}

function sumEur(lines: readonly EurLine[]): VoucherTotalsEur {
  const net = lines.reduce((s, l) => s + l.netEurCents, 0);
  const vat = lines.reduce((s, l) => s + l.vatEurCents, 0);
  return {
    netCents: net,
    vatCents: vat,
    grossCents: net + vat,
    selfAssessedVatCents: lines.reduce((s, l) => s + l.selfAssessedVatEurCents, 0),
  };
}

export { euro as formatEuroDe };
