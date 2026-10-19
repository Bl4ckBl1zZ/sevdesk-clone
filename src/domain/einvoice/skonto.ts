/**
 * BT-20 Skonto terms in the KoSIT syntax (XRechnung, F06 INB-043, T06-042):
 *   `#SKONTO#TAGE=14#PROZENT=2.00#` optionally followed by `BASISBETRAG=1190.00#`, one term per line.
 * Percent and base are machine decimals ("." separator); never parsed via floating point. Pure.
 */
import { parseDecimal } from "../money/parse";
import type { SkontoTerm } from "./received";

const TERM = /#SKONTO#TAGE=(\d{1,4})#PROZENT=(-?\d{1,3}(?:\.\d{1,2})?)#(?:BASISBETRAG=(-?\d+(?:\.\d{1,2})?)#)?/gi;

const machine = (s: string, scale: number): number | null => {
  const r = parseDecimal(s, { scale, decimalSeparator: ".", grouping: false, currencySymbol: false });
  return r.ok ? Number(r.value) : null;
};

export function parseSkontoTerms(text: string | undefined): SkontoTerm[] {
  if (!text) return [];
  const out: SkontoTerm[] = [];
  for (const m of text.matchAll(TERM)) {
    const days = Number(m[1]);
    const percentBp = machine(m[2] as string, 2);
    if (percentBp === null || percentBp <= 0) continue;
    const baseCents = m[3] !== undefined ? machine(m[3], 2) : null;
    out.push({ percentBp, days, ...(baseCents !== null ? { baseCents } : {}) });
  }
  return out;
}
