import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { systemAction, systemMutation, systemQuery } from "./functions";
import { isTest } from "./lib/env";
import { berlinParts } from "./lib/time";
import { recordIntegrityRun } from "./model/integrity";
import {
  checkInvariants,
  DEFAULT_PAGE_BUDGET,
  driveInvariants,
  type InvariantBudget,
  type InvariantPage,
  type InvariantState,
  type InvariantViolation,
  invariantsPage,
} from "./model/invariants";
import { vIntegrityFinding } from "./validators";

/**
 * `invariants.check` (02 §7, 10 §2): the regulatory invariants over the whole database.
 *
 *  - `check` (query): everything in one transaction — tests and small datasets only (Convex read limits).
 *  - `page` (query): one budget-sized page of the same evaluation, returning the continuation state.
 *  - `run` (action): drives `page` to completion — any data volume; `assertInvariants()` after every Convex and
 *    integration test (07 §5a), ops (`npx convex run invariants:run`) and the migration pre-check (AUD-028) use it.
 *  - `checkCron` (action): the daily 02:15 Europe/Berlin job; ERROR findings are stored in `integrityRuns`, which
 *    blocks finalisation until acknowledged (AUD-015) and raises `integrity.failed` (NTF-007).
 */
export const check = systemQuery({
  job: "cron.invariants.check",
  args: {},
  handler: async (ctx): Promise<InvariantViolation[]> => checkInvariants(ctx),
});

const vBudget = v.object({
  calls: v.optional(v.number()),
  docs: v.optional(v.number()),
  bytes: v.optional(v.number()),
});

export const page = systemQuery({
  job: "cron.invariants.check",
  args: { state: v.optional(v.any()), budget: v.optional(vBudget) },
  handler: async (ctx, { state, budget }): Promise<InvariantPage> =>
    invariantsPage(ctx, (state ?? null) as InvariantState | null, budget ?? DEFAULT_PAGE_BUDGET),
});

/** The paged check from an action: one `page` query per budget-sized page. */
export async function runInvariants(
  ctx: Pick<ActionCtx, "runQuery">,
  budget: InvariantBudget = DEFAULT_PAGE_BUDGET,
): Promise<InvariantViolation[]> {
  const res = await driveInvariants(
    (state): Promise<InvariantPage> => ctx.runQuery(internal.invariants.page, { ...(state ? { state } : {}), budget }),
  );
  return res.violations;
}

export const run = systemAction({
  job: "invariants.run",
  args: { budget: v.optional(vBudget) },
  handler: async (ctx, { budget }): Promise<InvariantViolation[]> => runInvariants(ctx, budget),
});

/** At most this many findings are stored per run (like `integrity.verify`). */
const MAX_FINDINGS = 100;

export const recordRun = systemMutation({
  job: "cron.invariants.check",
  args: { findings: v.array(vIntegrityFinding) },
  handler: async (ctx, { findings }) => recordIntegrityRun(ctx, { scope: "full", lastVerifiedSeq: 0, findings }),
});

/**
 * Cron (hourly tick, 02 §7): runs in the 02:xx Europe/Berlin hour, i.e. daily 02:15 in summer and winter. Only runs
 * with ERROR findings are stored: an `ok` row would supersede an unacknowledged `integrity.verify` failure of 02:00
 * and lift the finalisation block without acknowledgement (AUD-015); `lastVerifiedSeq: 0` keeps the incremental
 * chain verification on its own runs.
 */
export const checkCron = systemAction({
  job: "cron.invariants.check",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }): Promise<{ errors: number; warnings: number } | null> => {
    if (isTest() && !force) return null; // 02 §7: crons skip with IS_TEST unless invoked explicitly
    if (berlinParts(Date.now()).hour !== 2 && !force) return null;
    const violations = await runInvariants(ctx);
    const errors = violations.filter((x) => x.severity === "ERROR");
    if (errors.length > 0) {
      const findings = [...errors, ...violations.filter((x) => x.severity !== "ERROR")]
        .slice(0, MAX_FINDINGS)
        .map((x) => ({
          kind: x.id,
          severity: x.severity === "ERROR" ? ("error" as const) : ("warning" as const),
          detail: x.message,
        }));
      await ctx.runMutation(internal.invariants.recordRun, { findings });
    }
    return { errors: errors.length, warnings: violations.length - errors.length };
  },
});
