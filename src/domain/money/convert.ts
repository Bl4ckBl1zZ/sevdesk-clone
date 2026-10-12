/**
 * Price-mode conversion of stored unit prices (F04 App. E.3 step 6, F03 PRD-011) and foreign-currency → EUR
 * (MISC-08, F04 EC-DOC-52). Document totals in gross mode never use these helpers — they follow App. E.3 steps 1–5.
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import { roundHalfAway } from "./rounding";
import { type Cents, type Micros, toCents } from "./units";

const BP = 10_000n;

/** Display/default conversion: net = round_half_away(gross × 10⁴ / (10⁴ + rate)) at 4 decimals. */
export const grossToNetMicros = (grossMicros: number, rateBp: number): Micros =>
  Number(roundHalfAway(BigInt(grossMicros) * BP, BP + BigInt(rateBp))) as Micros;

/** gross = round_half_away(net × (10⁴ + rate) / 10⁴) at 4 decimals. */
export const netToGrossMicros = (netMicros: number, rateBp: number): Micros =>
  Number(roundHalfAway(BigInt(netMicros) * (BP + BigInt(rateBp)), BP)) as Micros;

/** FX rate "1 EUR = x FC" as a decimal string with ≤ 6 decimals (03 §0 `FxRate.rate`), scaled by 10⁶. */
export interface FxRate {
  readonly scaled: bigint;
  readonly text: string;
}

const FX_SCALE = 1_000_000n;

export function parseFxRate(text: string): Result<FxRate, Issue<"fx_rate_invalid">> {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  const scaled = m ? BigInt((m[1] ?? "") + (m[2] ?? "").padEnd(6, "0")) : 0n;
  if (scaled <= 0n) {
    return err(
      issue(
        "fx_rate_invalid",
        "Der Umrechnungskurs muss eine positive Dezimalzahl mit höchstens 6 Nachkommastellen sein.",
      ),
    );
  }
  return ok({ scaled, text: text.trim() });
}

/** EUR cents = round_half_away(foreign cents ÷ rate) — e.g. VAT in EUR per group (EC-DOC-52). */
export const fcToEurCents = (foreignCents: number, rate: FxRate): Cents =>
  toCents(roundHalfAway(BigInt(foreignCents) * FX_SCALE, rate.scaled));
