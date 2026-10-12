import { periodKey, seedRange, validateFormat, type YearMonth } from "../../src/domain/numbering/format";
import {
  assignNumber,
  checkDeactivateRange,
  checkDeleteRange,
  collisionIssue,
  NUMBERED_TYPE_LABEL_DE,
  simulateCollision,
  simulationBounds,
  validateNextValue,
} from "../../src/domain/numbering/register";
import type { NumberRangeCreateValues, NumberRangesValues } from "../../src/domain/schemas/settings";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedDelete, auditedInsert, auditedPatch } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Number ranges (03 §1, F01 SET-006, SET-055…064, §4.3). Formats, reset policy and next values; the register of
 * issued numbers (`numberRegister` 🔒) guards every change: no counter below an issued number (SET-059), no format
 * that re-creates an issued number (SET-060), no deletion of a used range (SET-062). Sales-document numbers are
 * assigned in the finalisation transaction (SET-061, P1) with `assignCounterNumber`, which contacts, products,
 * assets and internal vouchers use as well (SET-064).
 */
export async function listRanges(ctx: ReadCtx): Promise<Doc<"numberRanges">[]> {
  return ctx.db.query("numberRanges").collect();
}

export async function listDefaultRanges(ctx: ReadCtx): Promise<Doc<"numberRanges">[]> {
  return (await listRanges(ctx)).filter((r) => r.isDefault && r.active);
}

async function counterFor(ctx: ReadCtx, rangeId: Id<"numberRanges">, key: string) {
  return ctx.db
    .query("numberCounters")
    .withIndex("by_range_period", (q) => q.eq("rangeId", rangeId).eq("periodKey", key))
    .unique();
}

/** The value the next number would get in the current period (counter or start value). */
export async function nextValue(ctx: ReadCtx, range: Doc<"numberRanges">, today: YearMonth): Promise<number> {
  return (await counterFor(ctx, range._id, periodKey(range.resetPolicy, today)))?.next ?? range.startValue;
}

/** Highest counter value registered for the range in a period (SET-059 minimum), undefined if none. */
async function maxIssuedCounter(ctx: ReadCtx, rangeId: Id<"numberRanges">, key: string): Promise<number | undefined> {
  const rows = await ctx.db
    .query("numberRegister")
    .withIndex("by_range", (q) => q.eq("rangeId", rangeId).eq("periodKey", key))
    .collect();
  const counters = rows.map((r) => r.counter).filter((c): c is number => c !== undefined);
  return counters.length ? Math.max(...counters) : undefined;
}

export async function issuedCount(ctx: ReadCtx, rangeId: Id<"numberRanges">): Promise<number> {
  const first = await ctx.db
    .query("numberRegister")
    .withIndex("by_range", (q) => q.eq("rangeId", rangeId))
    .first();
  return first ? 1 : 0;
}

/**
 * SET-060 (EC-008): simulates the next 10,000 numbers of the current and the next period and throws
 * `FORMAT_COLLISION` if one is already in the register. Reads only the register rows inside the simulated
 * lexicographic range (index scan), so the check stays cheap with a large register.
 */
export async function assertNoCollision(
  ctx: ReadCtx,
  range: { format: string; resetPolicy: Doc<"numberRanges">["resetPolicy"]; startValue: number; next: number },
  today: YearMonth,
): Promise<void> {
  const { lo, hi } = simulationBounds(range, today);
  const rows = await ctx.db
    .query("numberRegister")
    .withIndex("by_normalized", (q) => q.gte("normalized", lo).lte("normalized", hi))
    .collect();
  const hit = simulateCollision(range, today, new Set(rows.map((r) => r.normalized)));
  if (hit) {
    const i = collisionIssue(hit.number);
    throw appError("invalid_input", i.message, { reason: "FORMAT_COLLISION", number: hit.number });
  }
}

const codeOf = (code: string) => code.toUpperCase();

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
      await assertNoCollision(ctx, { ...r, startValue: r.next }, today);
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
    const key = periodKey(r.resetPolicy, today);
    const counter = await counterFor(ctx, range._id, key);
    // SET-059: never below the next free number (counter or register); raising leaves a documented gap.
    const decision = validateNextValue(
      {
        ...(counter ? { counterNext: counter.next } : {}),
        ...(await maxIssuedCounter(ctx, range._id, key).then((m) => (m === undefined ? {} : { maxIssuedCounter: m }))),
      },
      r.next,
      input.reason,
    );
    if (!decision.ok) {
      throw appError("invalid_input", decision.error.message, {
        reason: codeOf(decision.error.code),
        field: `ranges.${r.key}.next`,
      });
    }
    const changed =
      r.format !== range.format ||
      r.resetPolicy !== range.resetPolicy ||
      r.next !== (counter?.next ?? range.startValue);
    if (changed) await assertNoCollision(ctx, { ...r, startValue: counter ? range.startValue : r.next }, today);
    if (counter && r.next !== counter.next) {
      const gap = decision.value.gap;
      await auditedPatch(
        ctx,
        "numberCounters",
        counter._id,
        { next: r.next },
        {
          action: "settings.number_range.update",
          label: range.name,
          reason: `${input.reason?.trim() ?? ""}${gap ? ` (Lücke ${gap.from}–${gap.to})` : ""}`,
        },
      );
    }
    await auditedPatch(
      ctx,
      "numberRanges",
      range._id,
      { format: r.format, resetPolicy: r.resetPolicy, ...(counter ? {} : { startValue: r.next }) },
      { action: "settings.number_range.update", label: range.name },
    );
  }
}

/** SET-055: an additional (non-default) range for one or more document types. */
export async function createRange(
  ctx: ModelCtx,
  input: NumberRangeCreateValues,
  today: YearMonth,
): Promise<Id<"numberRanges">> {
  const format = validateFormat(input.format, input.resetPolicy);
  if (!format.ok) throw appError("invalid_input", format.error.message, { field: "format" });
  await assertNoCollision(ctx, { ...input, next: input.startValue }, today);
  return auditedInsert(
    ctx,
    "numberRanges",
    {
      docTypes: [...input.docTypes],
      name: input.name,
      format: input.format,
      resetPolicy: input.resetPolicy,
      startValue: input.startValue,
      active: true,
      isDefault: false,
    },
    { action: "settings.number_range.create", label: input.name },
  );
}

const ref = (r: Doc<"numberRanges">) => ({
  id: r._id as string,
  docTypes: r.docTypes,
  active: r.active,
  isDefault: r.isDefault,
});

/** SET-062: deactivate (never the only active default of a type); a deactivated range is never a default. */
export async function deactivateRange(ctx: ModelCtx, rangeId: Id<"numberRanges">): Promise<void> {
  const range = await ctx.db.get(rangeId);
  if (!range) throw appError("not_found");
  const e = checkDeactivateRange(ref(range), (await listRanges(ctx)).map(ref));
  if (e) throw appError("invalid_input", e.message, { reason: codeOf(e.code) });
  await auditedPatch(
    ctx,
    "numberRanges",
    rangeId,
    { active: false, isDefault: false },
    { action: "settings.number_range.deactivate", label: range.name },
  );
}

/** SET-062: delete only an unused range (`RANGE_IN_USE` otherwise). */
export async function deleteRange(ctx: ModelCtx, rangeId: Id<"numberRanges">): Promise<void> {
  const range = await ctx.db.get(rangeId);
  if (!range) throw appError("not_found");
  const e = checkDeleteRange(ref(range), await issuedCount(ctx, rangeId), (await listRanges(ctx)).map(ref));
  if (e) throw appError("invalid_input", e.message, { reason: codeOf(e.code) });
  await auditedDelete(ctx, "numberRanges", rangeId, { action: "settings.number_range.delete", label: range.name });
}

/**
 * SET-064 / §4.3: assigns the next number of the active default range of `docType` inside the caller's transaction
 * (contacts, products and assets on creation; internal vouchers at booking; sales documents at finalisation, P1).
 * Convex's serialisable transactions make counter + register race-free. Each write is audited with the caller's
 * action (e.g. `contact.create`), so the register replays like every other table (RI-15).
 */
export async function assignCounterNumber(
  ctx: ModelCtx,
  input: { docType: string; date: YearMonth; documentId?: string; action: string },
): Promise<{ number: string; rangeId: Id<"numberRanges"> }> {
  const range = (await listDefaultRanges(ctx)).find((r) => r.docTypes.includes(input.docType));
  if (!range) {
    throw appError(
      "invalid_input",
      `Für ${NUMBERED_TYPE_LABEL_DE[input.docType] ?? input.docType} ist kein aktiver Nummernkreis eingerichtet.`,
      { reason: "RANGE_DEFAULT_REQUIRED" },
    );
  }
  const key = periodKey(range.resetPolicy, input.date);
  const counter = await counterFor(ctx, range._id, key);
  const draft = assignNumber(range, counter?.next, input.date, new Set());
  if (!draft.ok) throw appError("invalid_input", draft.error.message, { reason: codeOf(draft.error.code) });
  const taken = await ctx.db
    .query("numberRegister")
    .withIndex("by_normalized", (q) => q.eq("normalized", draft.value.normalized))
    .first();
  if (taken) {
    throw appError(
      "conflict",
      `Die Nummer ${draft.value.number} ist bereits vergeben. Bitte den Nummernkreis prüfen.`,
      {
        reason: "NUMBER_COLLISION",
      },
    );
  }
  const { number, normalized, counter: value, next } = draft.value;
  if (counter) {
    await auditedPatch(ctx, "numberCounters", counter._id, { next }, { action: input.action, label: range.name });
  } else {
    await auditedInsert(
      ctx,
      "numberCounters",
      { rangeId: range._id, periodKey: key, next },
      { action: input.action, label: range.name },
    );
  }
  await auditedInsert(
    ctx,
    "numberRegister",
    {
      number,
      normalized,
      rangeId: range._id,
      docType: input.docType,
      ...(input.documentId ? { documentId: input.documentId } : {}),
      periodKey: key,
      counter: value,
      assignedAt: ctx.now(),
      status: "issued",
    },
    { action: input.action, label: number },
  );
  return { number, rangeId: range._id };
}
