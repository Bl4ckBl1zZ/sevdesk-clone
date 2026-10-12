/**
 * DATEV keys (F01 SET-044, §5.3; DATEV-01/02): consultant and client number for the EXTF header and the account
 * length that fixes the personal-account ranges. The account length is locked after the first export (SET-E22).
 */
import { err, type Issue, issue, ok, type Result } from "../result";

export interface DatevKeys {
  consultantNumber?: number | undefined;
  clientNumber?: number | undefined;
  accountLength: number;
}

const intIn = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

export function validateDatevKeys(k: DatevKeys): Issue[] {
  const out: Issue[] = [];
  if (k.consultantNumber !== undefined && !intIn(k.consultantNumber, 1001, 9_999_999)) {
    out.push(issue("DATEV_CONSULTANT_INVALID", "Beraternummer: 1001 bis 9999999."));
  }
  if (k.clientNumber !== undefined && !intIn(k.clientNumber, 1, 99_999)) {
    out.push(issue("DATEV_CLIENT_INVALID", "Mandantennummer: 1 bis 99999."));
  }
  if (!intIn(k.accountLength, 4, 9))
    out.push(issue("DATEV_ACCOUNT_LENGTH_INVALID", "Sachkontenlänge: 4 bis 9 Stellen."));
  return out;
}

/** §5.3: debtors 10^L … 7·10^L − 1, creditors 7·10^L … 10^(L+1) − 1. */
export function personalAccountRanges(accountLength: number) {
  const base = 10 ** accountLength;
  return {
    debtors: { from: base, to: 7 * base - 1 },
    creditors: { from: 7 * base, to: 10 * base - 1 },
  };
}

/** SET-E22: changes after `exportCount` DATEV exports. */
export function checkDatevKeyChange(
  before: DatevKeys,
  after: DatevKeys,
  exportCount: number,
): Result<{ warnings: string[] }> {
  if (exportCount === 0) return ok({ warnings: [] });
  if (after.accountLength !== before.accountLength) {
    return err(
      issue(
        "DATEV_ACCOUNT_LENGTH_LOCKED",
        "Die Sachkontenlänge kann nach dem ersten DATEV-Export nicht mehr geändert werden.",
      ),
    );
  }
  const changed = after.consultantNumber !== before.consultantNumber || after.clientNumber !== before.clientNumber;
  return ok({ warnings: changed ? ["Frühere Exporte enthalten die alte Berater-/Mandantennummer."] : [] });
}
