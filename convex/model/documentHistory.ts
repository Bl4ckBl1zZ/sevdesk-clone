import type { FinalisedDocRef } from "../../src/domain/tax/ku-history";
import { turnoverRows } from "./turnover";
import type { ReadCtx } from "./types";

/**
 * Document history consulted by settings guards.
 *
 *   finalisedDocumentsForKu → SET-034 (KU history lock, retroactive entries): every finalised invoice-family
 *                             document, Storno and correction with the date its KU status was resolved by (supply)
 *   datevExportCount        → SET-044 / SET-E22 (account length lock, consultant-number warning) — the DATEV
 *                             export history (F09 EXP-009, `datevExports`)
 */
export async function finalisedDocumentsForKu(ctx: ReadCtx): Promise<FinalisedDocRef[]> {
  const out: FinalisedDocRef[] = [];
  for (const r of await turnoverRows(ctx, undefined, { withOss: false })) {
    const date = r.supplyEnd ?? r.documentDate;
    if (!date) continue;
    const doc = await ctx.db.get(r.id);
    out.push({ id: r.id, number: doc?.number ?? "", date });
  }
  return out;
}

export async function datevExportCount(ctx: ReadCtx): Promise<number> {
  return (await ctx.db.query("datevExports").take(1)).length;
}
