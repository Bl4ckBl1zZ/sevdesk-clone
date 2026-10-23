/**
 * EUR valuation of a foreign-currency pocket (F07 BNK-028, MISC-08; F08 §4.2.7 R1/R2, EC-144, E-ACC-26). Every
 * line on the pocket's ledger account carries its EUR amount and the foreign amount (`amountFx`); the pocket's
 * EUR cost basis is the running sum of both (moving average, the decided default). An outflow is valued at the
 * average cost; the difference to the EUR actually received is the realised FX result. Pure; amounts are integers
 * (EUR cents, foreign minor units), rounding half-up (EN 16931, `roundHalfAway` on positive values).
 *
 * The basis is only usable when it is complete: a line without its foreign amount (e.g. an opening balance entered
 * without EUR valuation) makes the average unknown — then nothing is guessed (no ECB fallback exists yet; LEGAL-OPEN
 * F07 BNK-028 ECB rate source).
 */
import { roundHalfAway } from "../money";
import { err, type Issue, issue, ok, type Result } from "../result";

export interface PocketLine {
  /** Signed EUR amount on the pocket's ledger account (debit − credit). */
  eurCents: number;
  /** Signed foreign amount (minor units); undefined = not valued in the foreign currency. */
  fxMinor?: number;
}

export interface PocketBasis {
  eurCents: number;
  fxMinor: number;
  complete: boolean;
}

export const FX_MESSAGES = {
  incomplete:
    "Der EUR-Anschaffungswert des Fremdwährungskontos ist unvollständig (Zugang ohne EUR-Bewertung). Bitte zuerst die Zugänge buchen (z. B. den Umtausch aus EUR).",
  exceeds: "Der Abgang übersteigt den bewerteten Bestand des Fremdwährungskontos.",
} as const;

export function pocketBasis(lines: readonly PocketLine[]): PocketBasis {
  let eur = 0;
  let fx = 0;
  let complete = true;
  for (const l of lines) {
    eur += l.eurCents;
    if (l.fxMinor === undefined) {
      if (l.eurCents !== 0) complete = false;
    } else fx += l.fxMinor;
  }
  return { eurCents: eur, fxMinor: fx, complete };
}

/**
 * EUR cost of an outflow of `outFxMinor` (> 0) at the moving average. The outflow that empties the pocket takes the
 * whole remaining EUR basis, so rounding residues never stay behind (E-ACC-26: the last lot absorbs).
 */
export function outflowCost(basis: PocketBasis, outFxMinor: number): Result<number, Issue<"fx_basis">> {
  if (!basis.complete) return err(issue("fx_basis", FX_MESSAGES.incomplete));
  if (!Number.isSafeInteger(outFxMinor) || outFxMinor <= 0 || outFxMinor > basis.fxMinor || basis.eurCents < 0) {
    return err(issue("fx_basis", FX_MESSAGES.exceeds));
  }
  if (outFxMinor === basis.fxMinor) return ok(basis.eurCents);
  return ok(Number(roundHalfAway(BigInt(outFxMinor) * BigInt(basis.eurCents), BigInt(basis.fxMinor))));
}

/** Realised FX result of an outflow: EUR received − EUR cost (> 0 gain, < 0 loss). */
export const realisedFx = (eurReceivedCents: number, costCents: number): number => eurReceivedCents - costCents;
