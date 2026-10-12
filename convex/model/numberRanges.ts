import { periodKey, seedRange, validateFormat, type YearMonth } from "../../src/domain/numbering/format";
import type { NumberRangesValues } from "../../src/domain/schemas/settings";
import type { Doc } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Number ranges (03 §1, F01 SET-006, SET-055…060). P0 = configuration: format, reset policy and the next value
 * per default range. Numbers are assigned only in the finalisation transaction (SET-061, P1); until then no
 * counter exists and "next" is the range's `startValue`.
 */
export async function listDefaultRanges(ctx: ReadCtx): Promise<Doc<"numberRanges">[]> {
  return (await ctx.db.query("numberRanges").collect()).filter((r) => r.isDefault && r.active);
}

/** The value the next number would get in the current period (counter or start value). */
export async function nextValue(ctx: ReadCtx, range: Doc<"numberRanges">, today: YearMonth): Promise<number> {
  const counter = await ctx.db
    .query("numberCounters")
    .withIndex("by_range_period", (q) =>
      q.eq("rangeId", range._id).eq("periodKey", periodKey(range.resetPolicy, today)),
    )
    .unique();
  return counter?.next ?? range.startValue;
}

/** Saves the default ranges keyed by their first document type (seeded on first save, SET-006/SET-053). */
export async function saveRanges(ctx: ModelCtx, input: NumberRangesValues, today: YearMonth): Promise<void> {
  const existing = await listDefaultRanges(ctx);
  for (const r of input.ranges) {
    const seed = seedRange(r.key);
    if (!seed) throw appError("invalid_input", `Unbekannter Nummernkreis ${r.key}.`);
    const format = validateFormat(r.format, r.resetPolicy);
    if (!format.ok) throw appError("invalid_input", format.error.message, { field: `ranges.${r.key}.format` });
    const range = existing.find((x) => x.docTypes[0] === seed.key);
    if (!range) {
      await auditedInsert(
        ctx,
        "numberRanges",
        {
          docTypes: [...seed.docTypes],
          name: seed.name,
          format: r.format,
          resetPolicy: r.resetPolicy,
          startValue: r.next,
          active: true,
          isDefault: true,
        },
        { action: "settings.number_range.create", label: seed.name },
      );
      continue;
    }
    const counter = await ctx.db
      .query("numberCounters")
      .withIndex("by_range_period", (q) => q.eq("rangeId", range._id).eq("periodKey", periodKey(r.resetPolicy, today)))
      .unique();
    if (counter) {
      // SET-059: never below the next free number; raising leaves a documented gap (reason mandatory).
      if (r.next < counter.next) {
        throw appError(
          "invalid_input",
          `Die nächste Nummer kann nicht unter ${counter.next} gesetzt werden, weil Nummern nie doppelt vergeben werden dürfen.`,
          { reason: "COUNTER_DECREASE" },
        );
      }
      if (r.next > counter.next) {
        if (!input.reason?.trim()) {
          throw appError("invalid_input", "Bitte begründen, warum Nummern übersprungen werden (Lückenprotokoll).", {
            reason: "REASON_REQUIRED",
          });
        }
        await auditedPatch(
          ctx,
          "numberCounters",
          counter._id,
          { next: r.next },
          { action: "settings.number_range.update", label: range.name, reason: input.reason.trim() },
        );
      }
    }
    // TODO(P1, SET-060): simulate the next 10,000 numbers against numberRegister once the register exists.
    await auditedPatch(
      ctx,
      "numberRanges",
      range._id,
      { format: r.format, resetPolicy: r.resetPolicy, ...(counter ? {} : { startValue: r.next }) },
      { action: "settings.number_range.update", label: range.name },
    );
  }
}
