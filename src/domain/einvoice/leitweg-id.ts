/**
 * Leitweg-ID (ER-20, F02 §5.5, F04 INV-22/EC-DOC-76): `Grob(2–12 digits)[-Fein(≤ 30 alphanumerics)]-Prüfziffer(2)`,
 * checked with ISO 7064 Mod 97-10 (letters A=10 … Z=35; the whole number mod 97 must equal 1).
 */
import { err, type Issue, issue, ok, type Result } from "../result";

export type LeitwegIdIssueCode = "leitweg_id_missing" | "leitweg_id_invalid" | "leitweg_id_checksum";

const FORMAT = /^(\d{2,12})(-[A-Z0-9]{1,30})?-(\d{2})$/;
const BASE = /^\d{2,12}(-[A-Z0-9]{1,30})?$/;

/** Remainder of the digit string (letters expanded to 10…35) modulo 97, computed piecewise (no big numbers). */
function mod97(value: string): number {
  let rest = 0;
  for (const ch of value) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest;
}

/** Check digits for a new ID from "Grob[-Fein]": 98 − ((number with "00" appended) mod 97). */
export function leitwegCheckDigits(grobFein: string): string {
  const base = grobFein.trim().toUpperCase();
  if (!BASE.test(base)) throw new RangeError(`leitweg_id_invalid: "${grobFein}"`);
  return String(98 - mod97(`${base.replaceAll("-", "")}00`)).padStart(2, "0");
}

export function validateLeitwegId(input: string | undefined | null): Result<string, Issue<LeitwegIdIssueCode>> {
  const value = (input ?? "").trim().toUpperCase();
  if (value === "") {
    return err(issue("leitweg_id_missing", "Für öffentliche Auftraggeber ist die Leitweg-ID Pflicht."));
  }
  if (!FORMAT.test(value)) {
    return err(
      issue(
        "leitweg_id_invalid",
        "Die Leitweg-ID hat nicht das Format Grobadressierung-Feinadressierung-Prüfziffer (z. B. 04011000-1234512345-06).",
      ),
    );
  }
  if (mod97(value.replaceAll("-", "")) !== 1) {
    return err(issue("leitweg_id_checksum", "Die Prüfziffer der Leitweg-ID stimmt nicht."));
  }
  return ok(value);
}
