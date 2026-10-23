import { err, type Issue, ok, type Result } from "../result";

/**
 * F01 SET-045 (MISC-02): SEPA creditor identifier (Gläubiger-Identifikationsnummer) of the company. German format
 * `DE` + 2 check digits + 3-character business code + 11-digit national ID (F01 §5). The check digits follow
 * EPC 262-08 (ISO 7064 MOD 97-10) over the national ID followed by the country code and `00`; the business code
 * (positions 5–7) is ignored. Used only once SEPA direct debit ships (deferred with F10); the field is validated now.
 */
export const CREDITOR_ID_INVALID_MESSAGE = "Die Gläubiger-Identifikationsnummer ist ungültig.";

const FORMAT = /^DE(\d{2})[A-Z0-9]{3}(\d{11})$/;

export function normalizeCreditorId(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/** Letters become two digits (A = 10 … Z = 35) as in the IBAN check. */
const digitsOf = (s: string) => [...s].map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join("");

function mod97(digits: string): number {
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest;
}

export function validateCreditorId(raw: string): Result<string, Issue<"CREDITOR_ID_INVALID">> {
  const id = normalizeCreditorId(raw);
  const m = FORMAT.exec(id);
  const check = m?.[1];
  const national = m?.[2];
  if (!check || !national || 98 - mod97(digitsOf(`${national}DE00`)) !== Number(check)) {
    return err({ code: "CREDITOR_ID_INVALID", message: CREDITOR_ID_INVALID_MESSAGE });
  }
  return ok(id);
}
