/**
 * Units (F01 SET-090/091, §5.7). Seeded system units and custom units whose code must be in the bundled
 * UN/ECE Rec 20/21 list (UST-07: the unit is printed and sent as BT-130). Units in use are only archived.
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import { UNIT_CODES } from "../rules/unit-codes";

export interface UnitSeed {
  code: string;
  label: { de: string; en: string };
}

const u = (code: string, de: string, en: string): UnitSeed => ({ code, label: { de, en } });

export const SEED_UNITS: readonly UnitSeed[] = [
  u("C62", "Stk.", "pc"),
  u("H87", "Stück", "piece"),
  u("LS", "pauschal", "lump sum"),
  u("E48", "Leistung", "service"),
  u("HUR", "Std.", "h"),
  u("MIN", "Min.", "min"),
  u("DAY", "Tag(e)", "day(s)"),
  u("E49", "Arbeitstag(e)", "working day(s)"),
  u("WEE", "Woche(n)", "week(s)"),
  u("MON", "Monat(e)", "month(s)"),
  u("QAN", "Quartal(e)", "quarter(s)"),
  u("ANN", "Jahr(e)", "year(s)"),
  u("KGM", "kg", "kg"),
  u("GRM", "g", "g"),
  u("TNE", "t", "t"),
  u("MTR", "m", "m"),
  u("CMT", "cm", "cm"),
  u("MMT", "mm", "mm"),
  u("KMT", "km", "km"),
  u("MTK", "m²", "m²"),
  u("MTQ", "m³", "m³"),
  u("LTR", "l", "l"),
  u("MLT", "ml", "ml"),
  u("KWH", "kWh", "kWh"),
  u("KWT", "kW", "kW"),
  u("SET", "Satz", "set"),
  u("PR", "Paar", "pair"),
  u("DZN", "Dutzend", "dozen"),
  u("P1", "%", "%"),
  u("XPK", "Packung", "pack"),
  u("XBX", "Karton", "box"),
  u("XPX", "Palette", "pallet"),
  u("XRO", "Rolle", "roll"),
  u("XBO", "Flasche", "bottle"),
  u("XSA", "Sack", "sack"),
];

export const isUnitCode = (code: string): boolean => UNIT_CODES.has(code);

const labelOk = (s: string) => s.trim().length >= 1 && s.trim().length <= 20;

/** SET-090: code from the bundled list, unique; German and English print labels 1–20 characters. */
export function validateUnit(unit: UnitSeed, existingCodes: readonly string[]): Result<void> {
  if (!isUnitCode(unit.code)) {
    return err(
      issue("UNIT_CODE_INVALID", `„${unit.code}“ ist kein gültiger Einheitencode nach UN/ECE Rec 20/21.`, {
        code: unit.code,
      }),
    );
  }
  if (existingCodes.includes(unit.code)) {
    return err(issue("UNIT_DUPLICATE", `Die Einheit ${unit.code} existiert bereits.`, { code: unit.code }));
  }
  if (!labelOk(unit.label.de) || !labelOk(unit.label.en)) {
    return err(issue("UNIT_LABEL_INVALID", "Bezeichnungen: 1 bis 20 Zeichen je Sprache."));
  }
  return ok(undefined);
}

/** SET-091: deletion only for unused custom units; otherwise archive. */
export function checkDeleteUnit(unit: { isSystem: boolean }, usageCount: number): Issue | null {
  if (unit.isSystem) {
    return issue("UNIT_SYSTEM", "Systemeinheiten können nicht gelöscht werden, nur umbenannt oder archiviert.");
  }
  if (usageCount > 0) return issue("UNIT_IN_USE", "Die Einheit wird verwendet und kann nur archiviert werden.");
  return null;
}
