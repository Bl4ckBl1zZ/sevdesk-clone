/**
 * Bulk actions on voucher drafts (F06 VOU-101): set account / tax rule / cost centre / tags on many drafts, delete
 * drafts, and „Sammelbuchung“ — a background job that books every draft without blocking errors. A bulk run never
 * acknowledges ⚑ warnings on the owner's behalf: such drafts are skipped and listed for the individual check. Pure.
 */
import { err, type Issue, issue, ok, type Result } from "../result";

export const BULK_VOUCHER_MAX = 500;

export interface BulkDraftPatch {
  account?: string;
  /** `null` removes the cost centre from every line. */
  costCenterId?: string | null;
  addTagIds?: readonly string[];
}

export function applyBulkPatch<L extends { account: string; costCenterId?: string }, T extends string>(
  draft: { lines: readonly L[]; tags: readonly T[] },
  patch: BulkDraftPatch,
): { lines: L[]; tags: T[] } {
  const lines = draft.lines.map((l) => {
    const next = { ...l };
    if (patch.account) next.account = patch.account;
    if (patch.costCenterId === null) delete next.costCenterId;
    else if (patch.costCenterId) next.costCenterId = patch.costCenterId;
    return next;
  });
  const tags = [...new Set([...draft.tags, ...((patch.addTagIds ?? []) as readonly T[])])];
  return { lines, tags };
}

/** VOU-101 / T06-131: why a draft is not booked by the bulk job (null = it is booked). */
export function bulkFinalizeSkipReason(check: {
  errors: readonly { code: string; message: string }[];
  warnings: readonly { code: string; message: string; acknowledge: boolean }[];
}): string | null {
  if (check.errors.length > 0) return check.errors.map((e) => e.message).join(" ");
  const flagged = check.warnings.filter((w) => w.acknowledge);
  if (flagged.length > 0) return `Bitte einzeln prüfen und bestätigen: ${flagged.map((w) => w.message).join(" ")}`;
  return null;
}

export function checkBulkSelection(ids: readonly string[]): Result<string[], Issue<"bulk_selection">> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return err(issue("bulk_selection", "Bitte mindestens einen Beleg auswählen."));
  if (unique.length > BULK_VOUCHER_MAX) {
    return err(issue("bulk_selection", `Höchstens ${BULK_VOUCHER_MAX} Belege auf einmal.`));
  }
  return ok(unique);
}
