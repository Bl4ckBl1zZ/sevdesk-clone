import { CLOCK_SKEW_BLOCK_MS, clockSkewCheck } from "../../src/domain/system/clock";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseWriter } from "../_generated/server";
import { appError } from "../lib/errors";
import { appendAudit } from "./audit";
import { notifyKind, resolveEntityNotifications } from "./notifications";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Clock monitoring (F12 AUD-019, GOBD-22, EC-027). Every 10 minutes the Convex runtime's clock is compared with the
 * reference (`CLOCK_REFERENCE_URL`, HTTP `Date`; the web server's SNTP check against `NTP_SERVER`, default
 * ptbtime1.ptb.de, is shown on the system page). `clockReadings` is a technical rolling log (7 days, no audit per
 * row); a status change to or from warning/error is audited, > 60 s raises `clock.skew_critical` and blocks every
 * business-date-assigning action (finalisation, Storno, sent mark, payments) with `clock_skew` until a good reading.
 */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** A blocking reading counts while it is younger than this (3 missed cron ticks). */
export const CLOCK_READING_FRESH_MS = 30 * 60 * 1000;

const CLOCK_ENTITY = { table: "system", id: "clock" } as const;

export async function latestClockReading(ctx: ReadCtx): Promise<Doc<"clockReadings"> | null> {
  return ctx.db.query("clockReadings").withIndex("by_at").order("desc").first();
}

export async function recordClockReading(
  ctx: ModelCtx,
  r: { offsetMs: number | null; reference: string },
): Promise<Doc<"clockReadings">["status"]> {
  const check = clockSkewCheck(r.offsetMs);
  const prev = await latestClockReading(ctx);
  const id = await ctx.db.insert("clockReadings", {
    at: ctx.now(),
    offsetMs: r.offsetMs,
    reference: r.reference.slice(0, 200),
    status: check.status,
    detail: check.detail,
  });
  const notable = (s: string | undefined) => s === "warning" || s === "error";
  if (prev?.status !== check.status && (notable(check.status) || notable(prev?.status))) {
    await appendAudit(ctx, {
      action: "system.clock",
      entity: { table: "clockReadings", id },
      reason: check.detail,
    });
  }
  if (check.status === "error") {
    await notifyKind(ctx, "clock.skew_critical", {
      title: check.detail,
      link: "/einstellungen/system",
      entity: CLOCK_ENTITY,
    });
  } else if (check.status === "ok" || check.status === "warning") {
    await resolveEntityNotifications(ctx, CLOCK_ENTITY, "clock.skew_critical");
  }
  for (const old of await ctx.db
    .query("clockReadings")
    .withIndex("by_at", (q) => q.lt("at", ctx.now() - KEEP_MS))
    .take(500)) {
    await ctx.db.delete(old._id);
  }
  return check.status;
}

/** EC-027: refuses business-date-assigning actions while the latest fresh reading is off by more than 60 s. */
export async function assertClockOk(ctx: ReadCtx & { now: () => number }): Promise<void> {
  const r = await latestClockReading(ctx);
  if (!r || r.offsetMs === null || ctx.now() - r.at > CLOCK_READING_FRESH_MS) return;
  if (Math.abs(r.offsetMs) > CLOCK_SKEW_BLOCK_MS) throw appError("clock_skew", r.detail);
}

/** Banner/status view (SET-132 panel, GOBD-22 banner > 2 s). */
export async function clockView(ctx: ReadCtx) {
  const r = await latestClockReading(ctx);
  return r ? { at: r.at, offsetMs: r.offsetMs, status: r.status, detail: r.detail, reference: r.reference } : null;
}

// ── F01 SET-134 cron runs ───────────────────────────────────────────────────────────────────────────────

/**
 * Records the latest run of a cron job (`cron.*` system job) — called by the system wrappers in convex/functions.ts
 * after a successful run (a failing mutation rolls back, so a missed run shows as overdue in the status table).
 * `cronRuns` is technical (one row per job, no audit).
 */
export async function recordCronRun(
  ctx: { db: DatabaseWriter },
  run: { job: string; startedAt: number; finishedAt: number; result: "ok" | "error" },
): Promise<void> {
  const row = {
    job: run.job,
    lastRunAt: run.startedAt,
    durationMs: Math.max(0, run.finishedAt - run.startedAt),
    result: run.result,
  };
  const existing = await ctx.db
    .query("cronRuns")
    .withIndex("by_job", (q) => q.eq("job", run.job))
    .first();
  if (existing) await ctx.db.patch("cronRuns", existing._id, row);
  else await ctx.db.insert("cronRuns", row);
}

export async function listCronRuns(ctx: ReadCtx): Promise<Doc<"cronRuns">[]> {
  return ctx.db.query("cronRuns").collect();
}
