import type { FinalisedDocRef } from "../../src/domain/tax/ku-history";
import type { ReadCtx } from "./types";

/**
 * Document history consulted by settings guards. Sales documents (P1, F03/F04) and DATEV exports (F09) do not
 * exist yet, so both return their empty values; the features that add the tables replace these bodies in the same
 * PR (the settings guards and their tests stay unchanged).
 *
 *   finalisedDocumentsForKu → SET-034 (KU history lock, retroactive entries)
 *   datevExportCount        → SET-044 / SET-E22 (account length lock, consultant-number warning)
 */
export async function finalisedDocumentsForKu(_ctx: ReadCtx): Promise<FinalisedDocRef[]> {
  return [];
}

export async function datevExportCount(_ctx: ReadCtx): Promise<number> {
  return 0;
}
