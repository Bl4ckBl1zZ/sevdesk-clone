/**
 * „Vollständig geprüft“ and „Papier vernichtbar“ (F06 VOU-123, GOBD-08, GOBD-10; BMF GoBD Rz. 136 ff.).
 *
 * The flag records who compared the capture with the paper original and when. Paper originals may only be destroyed
 * under a documented scanning procedure: the list filter „Papier vernichtbar“ exists only while a released
 * Verfahrensdokumentation contains the chapter „Belegeingang und ersetzendes Scannen“ (field `scanProcedure`), and
 * it shows booked vouchers whose capture was checked. Pure.
 */

export interface CheckedVoucher {
  status: string;
  checkedComplete?: { at: number; actor: string };
}

/** The released Verfahrensdokumentation (its frozen `sourceJson`) documents the scanning procedure. */
export function scanningProcedureReleased(sourceJson: string | undefined | null): boolean {
  if (!sourceJson) return false;
  try {
    const parsed = JSON.parse(sourceJson) as { inputs?: Record<string, unknown> };
    const text = parsed.inputs?.scanProcedure;
    return typeof text === "string" && text.trim().length > 0;
  } catch {
    return false;
  }
}

/** VOU-123: the paper original of this voucher may be destroyed (checked, booked, procedure released). */
export const paperDestructible = (v: CheckedVoucher, procedureReleased: boolean): boolean =>
  procedureReleased && !!v.checkedComplete && v.status !== "draft";
