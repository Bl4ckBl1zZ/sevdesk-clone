import { type FreshnessFinding, rulesFreshness } from "../../src/domain/rules/freshness";
import {
  checkOverride,
  type GroupedOverrides,
  groupOverrides,
  type OverrideInput,
  overrideLockIssue,
  ruleOverview,
  type StoredOverride,
} from "../../src/domain/rules/overrides";
import { ALL_RULE_TABLES } from "../../src/domain/rules/registry";
import type { CalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedDelete, auditedInsert } from "./audit";
import { notifyKind } from "./notifications";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Owner rule overrides (F01 SET-120…123, 03 §1 `ruleOverrides`). Rows are only inserted or (while unreferenced)
 * deleted, never updated; the domain lookups receive them through `loadRuleOverrides` (SET-122).
 */
const stored = (r: Doc<"ruleOverrides">): StoredOverride => ({
  id: r._id,
  ruleSet: r.ruleSet,
  tableId: r.tableId,
  validFrom: r.validFrom,
  ...(r.validTo ? { validTo: r.validTo } : {}),
  value: r.value,
  source: r.source,
});

export async function listRuleOverrides(ctx: ReadCtx): Promise<StoredOverride[]> {
  return (await ctx.db.query("ruleOverrides").collect()).map(stored);
}

/** SET-122: the overrides in the shape the domain lookups take (empty table → no change to any calculation). */
export async function loadRuleOverrides(ctx: ReadCtx): Promise<GroupedOverrides> {
  return groupOverrides(await listRuleOverrides(ctx));
}

/** SET-123: every rule row id referenced by a finalised document (its snapshot's `ruleVersions`). */
async function referencedRuleVersions(ctx: ReadCtx): Promise<Record<string, string>[]> {
  return (await ctx.db.query("documentSnapshots").collect()).map((s) => s.ruleVersions);
}

export async function ruleOverviewView(ctx: ReadCtx, today: CalendarDate) {
  const overrides = await listRuleOverrides(ctx);
  // Scans the snapshots only while overrides exist (the usual state is none). LIMIT: reads every snapshot's
  // ruleVersions; a `firstReferencedAt` stamp on the override at finalisation would make this O(overrides).
  const versions = overrides.length > 0 ? await referencedRuleVersions(ctx) : [];
  return {
    tables: ruleOverview(ALL_RULE_TABLES, overrides, today),
    overrides: overrides.map((o) => ({ ...o, locked: overrideLockIssue(o.id, versions) !== null })),
  };
}

export async function addRuleOverride(
  ctx: ModelCtx,
  input: OverrideInput,
): Promise<{ id: Id<"ruleOverrides">; warnings: string[] }> {
  const check = checkOverride(input, await listRuleOverrides(ctx));
  if (check.error || !check.value) {
    const e = check.error;
    throw appError("invalid_input", e?.message, { reason: e?.code ?? "VALUE_REQUIRED" });
  }
  const id = await auditedInsert(
    ctx,
    "ruleOverrides",
    {
      ruleSet: input.ruleSet,
      tableId: input.tableId,
      validFrom: input.validFrom,
      ...(input.validTo ? { validTo: input.validTo } : {}),
      value: check.value,
      source: input.source.trim(),
      addedAt: ctx.now(),
    },
    { action: "rule_override.add", label: `${input.tableId} ab ${input.validFrom}`, reason: input.source.trim() },
  );
  return { id, warnings: check.warnings.map((w) => w.message) };
}

/** SET-123: only an override no finalised document used may be deleted (audited); otherwise RULE_ROW_LOCKED. */
export async function deleteRuleOverride(ctx: ModelCtx, id: Id<"ruleOverrides">, reason: string): Promise<void> {
  const row = await ctx.db.get(id);
  if (!row) throw appError("not_found");
  const why = reason.trim();
  if (why.length < 5) {
    throw appError("invalid_input", "Bitte eine Begründung angeben (mindestens 5 Zeichen).", { field: "reason" });
  }
  const locked = overrideLockIssue(id, await referencedRuleVersions(ctx));
  if (locked) throw appError("conflict", locked.message, { reason: locked.code });
  await auditedDelete(ctx, "ruleOverrides", id, {
    action: "rule_override.delete",
    label: `${row.tableId} ab ${row.validFrom}`,
    reason: why,
  });
}

/**
 * F01 SET-124 `rules.freshness` (weekly cron): one `rules.stale` notification per finding (deduplicated per finding
 * while open). A shipped row contradicting an override (SET-E26) lists the documents finalised with the override.
 */
export async function runRulesFreshness(ctx: ModelCtx, today: CalendarDate): Promise<FreshnessFinding[]> {
  const findings = rulesFreshness(await listRuleOverrides(ctx), today);
  const snapshots = findings.some((f) => f.code === "override_differs_from_shipped")
    ? await ctx.db.query("documentSnapshots").collect()
    : [];
  for (const f of findings) {
    let body = f.message;
    if (f.code === "override_differs_from_shipped" && f.overrideId) {
      const rowId = `override:${f.overrideId}`;
      const numbers: string[] = [];
      for (const s of snapshots) {
        if (!Object.values(s.ruleVersions).includes(rowId)) continue;
        const d = await ctx.db.get(s.documentId);
        numbers.push(d?.number ?? String(s.documentId));
      }
      if (numbers.length > 0) body += ` Mit der Überschreibung fertiggestellt: ${numbers.sort().join(", ")}.`;
    }
    await notifyKind(ctx, "rules.stale", {
      title:
        f.code === "table_stale"
          ? "Regeltabelle veraltet"
          : f.code === "override_duplicates_shipped"
            ? "Überschreibung überflüssig"
            : "Ausgelieferte Regel weicht ab",
      body,
      link: "/einstellungen/regeln",
      ...(f.overrideId ? { entity: { table: "ruleOverrides", id: f.overrideId } } : {}),
      dedupeKey: `rules.stale|${f.code}|${f.overrideId ?? f.tableId}`,
    });
  }
  return findings;
}
