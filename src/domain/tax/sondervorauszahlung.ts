/**
 * Dauerfristverlängerung and Sondervorauszahlung (F08 TAX-002, UVA-02; § 46–48 UStDV). Pure.
 *
 * Monthly filers with Dauerfristverlängerung pay 1/11 of the prior year's advance payments by 10 February (USt 1 H,
 * Kz 38); the amount is offset in the December return (Kz 39). Basis = Σ of the prior year's Kz 83 (latest filing per
 * month) — positive values only (Überschüsse are no Vorauszahlungen, decided default ⚠ § 47 UStDV) — plus the
 * Sondervorauszahlung that was deducted in the prior December (the form asks for the sum „zuzüglich der angerechneten
 * Sondervorauszahlung“). Quarterly filers pay no Sondervorauszahlung.
 */
import { formatCents, roundHalfAway } from "../money";
import { err, type Issue, issue, ok, type Result } from "../result";
import type { FilingPeriodKind } from "./ustva";

export interface SondervorauszahlungInput {
  year: number;
  /** UStVA period kind of `year`. */
  period: FilingPeriodKind;
  dauerfrist: boolean;
  /** Kz 83 of each prior-year period (latest non-superseded filing). */
  priorYearKz83Cents: readonly number[];
  /** Kz 39 deducted in the prior year's December return. */
  priorYearSondervorauszahlungCents?: number;
}

export interface Sondervorauszahlung {
  basisCents: number;
  /** Kz 38 (cents, half-up). */
  amountCents: number;
  explanation: string;
}

export type SvzIssue = Issue<"not_monthly" | "no_dauerfrist">;

export function computeSondervorauszahlung(input: SondervorauszahlungInput): Result<Sondervorauszahlung, SvzIssue> {
  if (input.period !== "monthly") {
    return err(
      issue(
        "not_monthly",
        "Bei vierteljährlicher Abgabe ist keine Sondervorauszahlung zu leisten (§ 47 Abs. 2 UStDV).",
      ),
    );
  }
  if (!input.dauerfrist) {
    return err(issue("no_dauerfrist", "Ohne Dauerfristverlängerung ist keine Sondervorauszahlung zu leisten."));
  }
  const positive = input.priorYearKz83Cents.filter((c) => c > 0).reduce((s, c) => s + c, 0);
  const basis = positive + Math.max(0, input.priorYearSondervorauszahlungCents ?? 0);
  const amount = Number(roundHalfAway(BigInt(basis), 11n));
  return ok({
    basisCents: basis,
    amountCents: amount,
    explanation: `1/11 der Vorauszahlungen ${input.year - 1} (${formatCents(basis)} €) = ${formatCents(amount)} € (Kz 38).`,
  });
}

/** E-UVA-09: December return of a monthly filer with Dauerfrist but no recorded Sondervorauszahlung. */
export const SVZ_MISSING_NOTICE = "Sondervorauszahlung nicht erfasst – Kz 39 bleibt leer.";
