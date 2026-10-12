/**
 * IBAN validation (F02 CON-093, F04 `iban_invalid`), wrapping the pure `ibantools` package
 * (country length + BBAN structure + ISO 7064 mod 97 check).
 */
import { electronicFormatIBAN, friendlyFormatIBAN, isValidIBAN } from "ibantools";
import { err, type Issue, issue, ok, type Result } from "../result";

export interface Iban {
  /** Electronic format, e.g. "DE89370400440532013000" (stored). */
  readonly iban: string;
  /** Groups of four, e.g. "DE89 3704 0044 0532 0130 00" (printed). */
  readonly display: string;
  readonly countryCode: string;
}

export function parseIban(input: string): Result<Iban, Issue<"iban_invalid">> {
  const electronic = electronicFormatIBAN(input) ?? "";
  if (!isValidIBAN(electronic)) {
    return err(issue("iban_invalid", `Die IBAN ${input.trim()} ist ungültig.`, { iban: input.trim() }));
  }
  return ok({
    iban: electronic,
    display: friendlyFormatIBAN(electronic) ?? electronic,
    countryCode: electronic.slice(0, 2),
  });
}
