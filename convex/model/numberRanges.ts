import { documentPath } from "../../src/domain/documents/doc-types";
import {
  normalizeNumber,
  periodKey,
  seedRange,
  validateFormat,
  type YearMonth,
} from "../../src/domain/numbering/format";
import { type DocumentedGap, parseDocumentedGap, registerGaps } from "../../src/domain/numbering/gaps";
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

/**
 * F09 IMP-005 / F01 SET-065 (EC-014): continues a default range after the sevdesk import with the format and next
 * value the owner confirmed. Never below the current counter or an issued number (SET-059), no collision with the
 * register incl. the imported numbers (SET-060, E-IMP-12). Audited with the reason „Import“.
 */
export async function continueRangeAfterImport(
  ctx: ModelCtx,
  input: { rangeKey: string; format: string; resetPolicy: Doc<"numberRanges">["resetPolicy"]; next: number },
  today: YearMonth,
): Promise<void> {
  const seed = seedRange(input.rangeKey);
  if (!seed) throw appError("invalid_input", `Unbekannter Nummernkreis ${input.rangeKey}.`);
  const format = validateFormat(input.format, input.resetPolicy);
  if (!format.ok) throw appError("invalid_input", format.error.message, { field: `numberRanges.${input.rangeKey}` });
  if (!Number.isSafeInteger(input.next) || input.next < 1) throw appError("invalid_input", "Ungültige nächste Nummer.");
  const reason = "Import (Fortsetzung der sevdesk-Nummern)";
  const range = (await listDefaultRanges(ctx)).find((r) => r.docTypes[0] === seed.key);
  try {
    await assertNoCollision(
      ctx,
      { format: input.format, resetPolicy: input.resetPolicy, startValue: input.next, next: input.next },
      today,
    );
  } catch (e) {
    const number = (e as { data?: { number?: string } }).data?.number ?? "";
    throw appError("invalid_input", `Die nächste Nummer ${number} wäre nicht eindeutig.`, {
      reason: "E_IMP_12",
      number,
    });
  }
  if (!range) {
    await auditedInsert(
      ctx,
      "numberRanges",
      {
        docTypes: [...seed.docTypes],
        name: seed.name,
        format: input.format,
        resetPolicy: input.resetPolicy,
        startValue: input.next,
        active: true,
        isDefault: true,
      },
      { action: "settings.number_range.create", label: seed.name, reason },
    );
    return;
  }
  const key = periodKey(input.resetPolicy, today);
  const counter = await counterFor(ctx, range._id, key);
  const max = await maxIssuedCounter(ctx, range._id, key);
  const decision = validateNextValue(
    { ...(counter ? { counterNext: counter.next } : {}), ...(max === undefined ? {} : { maxIssuedCounter: max }) },
    input.next,
    reason,
  );
  if (!decision.ok) throw appError("invalid_input", decision.error.message, { reason: codeOf(decision.error.code) });
  if (counter) {
    await auditedPatch(
      ctx,
      "numberCounters",
      counter._id,
      { next: input.next },
      {
        action: "settings.number_range.update",
        label: range.name,
        reason,
      },
    );
  } else {
    await auditedInsert(
      ctx,
      "numberCounters",
      { rangeId: range._id, periodKey: key, next: input.next },
      {
        action: "settings.number_range.update",
        label: range.name,
        reason,
      },
    );
  }
  await auditedPatch(
    ctx,
    "numberRanges",
    range._id,
    { format: input.format, resetPolicy: input.resetPolicy },
    { action: "settings.number_range.update", label: range.name, reason },
  );
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

/**
 * QUO-06 suffix numbering: a quote revision gets `{base}-V{n}` without consuming a counter value; the number goes into
 * the register like every other issued number (uniqueness RI-02, T-QUO-004). `new_number` mode uses
 * `assignCounterNumber` instead.
 */
export async function registerDerivedNumber(
  ctx: ModelCtx,
  input: {
    number: string;
    rangeId?: Id<"numberRanges">;
    docType: string;
    documentId: string;
    action: string;
  },
): Promise<void> {
  const normalized = normalizeNumber(input.number);
  const taken = await ctx.db
    .query("numberRegister")
    .withIndex("by_normalized", (q) => q.eq("normalized", normalized))
    .first();
  if (taken) {
    throw appError("conflict", `Die Nummer ${input.number} ist bereits vergeben.`, { reason: "NUMBER_COLLISION" });
  }
  await auditedInsert(
    ctx,
    "numberRegister",
    {
      number: input.number,
      normalized,
      ...(input.rangeId ? { rangeId: input.rangeId } : {}),
      docType: input.docType,
      documentId: input.documentId,
      assignedAt: ctx.now(),
      status: "issued",
    },
    { action: input.action, label: input.number },
  );
}

// ── SET-063 register viewer and gap report (DOC-39 links here) ───────────────────────────────────────────────────

const REGISTER_LIMIT = 5000;
const SALES_TYPES = new Set([
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
  "cancellation",
  "correction",
  "quote",
  "order_confirmation",
  "delivery_note",
  "proforma",
  "reminder",
]);

function registerLink(docType: string, documentId: string | undefined): string | null {
  if (!documentId) return null;
  if (SALES_TYPES.has(docType)) return documentPath(docType as Parameters<typeof documentPath>[0], documentId);
  if (docType === "contact") return `/kontakte/${documentId}`;
  if (docType === "product") return `/produkte/${documentId}`;
  return null;
}

export async function registerView(
  ctx: ReadCtx,
  f: { rangeId: Id<"numberRanges">; periodKey?: string; status?: Doc<"numberRegister">["status"] },
) {
  const range = await ctx.db.get(f.rangeId);
  if (!range) throw appError("not_found", "Nummernkreis nicht gefunden.");
  const all = await ctx.db
    .query("numberRegister")
    .withIndex("by_range", (q) => q.eq("rangeId", f.rangeId))
    .take(REGISTER_LIMIT + 1);
  const periods = [...new Set(all.map((r) => r.periodKey ?? ""))].filter(Boolean).sort().reverse();
  const inPeriod = f.periodKey ? all.filter((r) => r.periodKey === f.periodKey) : all;
  const documented: DocumentedGap[] = [];
  for (const c of await ctx.db
    .query("numberCounters")
    .withIndex("by_range_period", (q) => q.eq("rangeId", f.rangeId))
    .collect()) {
    for (const a of await ctx.db
      .query("auditLog")
      .withIndex("by_entity", (q) => q.eq("entity.table", "numberCounters").eq("entity.id", c._id))
      .collect()) {
      const gap = parseDocumentedGap(a.reason);
      if (gap) documented.push({ periodKey: c.periodKey, ...gap });
    }
  }
  return {
    range: { name: range.name, format: range.format, startValue: range.startValue },
    periods,
    truncated: all.length > REGISTER_LIMIT,
    rows: inPeriod
      .filter((r) => !f.status || r.status === f.status)
      .sort((a, b) => (b.counter ?? 0) - (a.counter ?? 0) || b.assignedAt - a.assignedAt)
      .map((r) => ({
        number: r.number,
        docType: r.docType,
        periodKey: r.periodKey ?? null,
        counter: r.counter ?? null,
        assignedAt: r.assignedAt,
        status: r.status,
        imported: r.imported === true,
        link: registerLink(r.docType, r.documentId),
      })),
    gaps: registerGaps(inPeriod, range.startValue, documented),
  };
}

/** DOC-39: the register row of a document number (range, period, status) for the detail page. */
export async function registerEntryOf(ctx: ReadCtx, number: string) {
  const row = await ctx.db
    .query("numberRegister")
    .withIndex("by_normalized", (q) => q.eq("normalized", normalizeNumber(number)))
    .first();
  if (!row) return null;
  const range = row.rangeId ? await ctx.db.get(row.rangeId) : null;
  return {
    number: row.number,
    assignedAt: row.assignedAt,
    status: row.status,
    rangeId: row.rangeId ?? null,
    rangeName: range?.name ?? null,
    periodKey: row.periodKey ?? null,
    imported: row.imported === true,
  };
}
