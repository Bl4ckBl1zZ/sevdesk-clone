/** Cost centres (F01 SET-097, §5.12): number, name, default flag, archive; exported as DATEV KOST1 (DATEV-02). */
import { err, issue, ok, type Result } from "../result";

const NUMBER = /^[A-Za-z0-9]{1,36}$/;
export const DATEV_LEGACY_KOST_LENGTH = 8;

export function validateCostCenter(
  input: { id?: string; number: string; name: string },
  existing: readonly { id: string; number: string }[],
): Result<{ warnings: string[] }> {
  const number = input.number.trim();
  if (
    !NUMBER.test(number) ||
    existing.some((c) => c.id !== input.id && c.number.toLowerCase() === number.toLowerCase())
  ) {
    return err(issue("COST_CENTER_INVALID", "Kostenstellennummer: 1–36 Buchstaben/Ziffern, eindeutig."));
  }
  if (input.name.trim().length < 1 || input.name.trim().length > 60) {
    return err(issue("COST_CENTER_NAME", "Bezeichnung: 1 bis 60 Zeichen."));
  }
  return ok({
    warnings: number.length > DATEV_LEGACY_KOST_LENGTH ? ["Ältere DATEV-Versionen akzeptieren nur 8 Zeichen."] : [],
  });
}
