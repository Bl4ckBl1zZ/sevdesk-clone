/**
 * F01 SET-134 (GOBD-09): cron status table on /einstellungen/system — every registered job (02 §7) with its last run,
 * duration, result and next run. Pure: the schedules come from convex/crons.ts, the runs from `cronRuns`, `now` is
 * passed in. Schedules are in UTC (Convex); the UI shows times in Europe/Berlin.
 */
export type CronScheduleSpec =
  | { readonly type: "cron"; readonly cron: string }
  | { readonly type: "interval"; readonly seconds?: number; readonly minutes?: number; readonly hours?: number }
  | { readonly type: "hourly"; readonly minuteUTC?: number }
  | { readonly type: "daily"; readonly hourUTC: number; readonly minuteUTC?: number }
  | { readonly type: "weekly"; readonly dayOfWeek: string; readonly hourUTC: number; readonly minuteUTC?: number }
  | { readonly type: "monthly"; readonly day: number; readonly hourUTC: number; readonly minuteUTC?: number };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** One cron field → the allowed values (`*`, `a`, `a,b`, `a-b`, `*\/n`, `a-b/n`). */
function field(spec: string, min: number, max: number): Set<number> | null {
  if (spec === "*") return null;
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [range = "*", stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    const [lo, hi] = range === "*" ? [min, max] : range.includes("-") ? range.split("-").map(Number) : [Number(range)];
    const from = lo ?? min;
    const to = hi ?? (stepText ? max : from);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

const ok = (set: Set<number> | null, v: number) => set === null || set.has(v);

function nextCron(expr: string, after: number): number | null {
  const [m = "*", h = "*", dom = "*", mon = "*", dow = "*"] = expr.trim().split(/\s+/);
  const minutes = field(m, 0, 59);
  const hours = field(h, 0, 23);
  const doms = field(dom, 1, 31);
  const months = field(mon, 1, 12);
  const dows = field(dow, 0, 6);
  if (dows?.has(7)) dows.add(0);
  const dayMatches = (d: Date) => {
    const domOk = ok(doms, d.getUTCDate());
    const dowOk = ok(dows, d.getUTCDay());
    // classic cron: with both day fields restricted, either may match
    return ok(months, d.getUTCMonth() + 1) && (doms !== null && dows !== null ? domOk || dowOk : domOk && dowOk);
  };
  const start = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  const startDay = Math.floor(start / DAY) * DAY;
  for (let day = startDay; day < startDay + 400 * DAY; day += DAY) {
    if (!dayMatches(new Date(day))) continue;
    for (let hh = 0; hh < 24; hh++) {
      if (!ok(hours, hh)) continue;
      for (let mm = 0; mm < 60; mm++) {
        const t = day + hh * 60 * MINUTE + mm * MINUTE;
        if (t >= start && ok(minutes, mm)) return t;
      }
    }
  }
  return null;
}

/** The next run strictly after `after`; intervals need the last run (Convex starts them at deployment time). */
export function nextRunAt(s: CronScheduleSpec, after: number, lastRunAt?: number): number | null {
  switch (s.type) {
    case "cron":
      return nextCron(s.cron, after);
    case "interval": {
      const ms = ((s.seconds ?? 0) + (s.minutes ?? 0) * 60 + (s.hours ?? 0) * 3600) * 1000;
      return lastRunAt === undefined || ms <= 0 ? null : lastRunAt + ms;
    }
    case "hourly":
      return nextCron(`${s.minuteUTC ?? 0} * * * *`, after);
    case "daily":
      return nextCron(`${s.minuteUTC ?? 0} ${s.hourUTC} * * *`, after);
    case "weekly":
      return nextCron(`${s.minuteUTC ?? 0} ${s.hourUTC} * * ${DAYS.indexOf(s.dayOfWeek)}`, after);
    case "monthly":
      return nextCron(`${s.minuteUTC ?? 0} ${s.hourUTC} ${s.day} * *`, after);
  }
}

export function scheduleText(s: CronScheduleSpec): string {
  switch (s.type) {
    case "cron":
      return `${s.cron} (UTC)`;
    case "interval": {
      const min = (s.seconds ?? 0) / 60 + (s.minutes ?? 0) + (s.hours ?? 0) * 60;
      return min % 60 === 0 ? `alle ${min / 60} Std.` : `alle ${min} Min.`;
    }
    case "hourly":
      return `stündlich (:${String(s.minuteUTC ?? 0).padStart(2, "0")} UTC)`;
    case "daily":
      return `täglich ${String(s.hourUTC).padStart(2, "0")}:${String(s.minuteUTC ?? 0).padStart(2, "0")} UTC`;
    case "weekly":
      return `wöchentlich (${s.dayOfWeek}) ${String(s.hourUTC).padStart(2, "0")}:${String(s.minuteUTC ?? 0).padStart(2, "0")} UTC`;
    case "monthly":
      return `monatlich am ${s.day}. ${String(s.hourUTC).padStart(2, "0")}:${String(s.minuteUTC ?? 0).padStart(2, "0")} UTC`;
  }
}

export interface RegisteredCron {
  readonly name: string;
  readonly functionName: string;
  /** System job the function runs as (`cron.*`), from the function inventory. */
  readonly job: string | null;
  readonly schedule: CronScheduleSpec;
}

export interface CronRun {
  readonly job: string;
  readonly lastRunAt: number;
  readonly durationMs: number;
  readonly result: "ok" | "error";
}

export interface CronStatusRow {
  readonly name: string;
  readonly job: string | null;
  readonly schedule: string;
  readonly lastRunAt: number | null;
  readonly durationMs: number | null;
  readonly result: "ok" | "error" | null;
  readonly nextRunAt: number | null;
  /** `overdue`: the run expected after the last one is more than 15 minutes late. */
  readonly state: "ok" | "overdue" | "never" | "error";
}

export const OVERDUE_GRACE_MS = 15 * MINUTE;

export function cronStatusRows(
  crons: readonly RegisteredCron[],
  runs: readonly CronRun[],
  now: number,
): CronStatusRow[] {
  const byJob = new Map(runs.map((r) => [r.job, r]));
  return crons
    .map((c): CronStatusRow => {
      const run = c.job ? byJob.get(c.job) : undefined;
      const next = run ? nextRunAt(c.schedule, run.lastRunAt, run.lastRunAt) : nextRunAt(c.schedule, now);
      const state = !run
        ? "never"
        : run.result === "error"
          ? "error"
          : next !== null && next + OVERDUE_GRACE_MS < now
            ? "overdue"
            : "ok";
      return {
        name: c.name,
        job: c.job,
        schedule: scheduleText(c.schedule),
        lastRunAt: run?.lastRunAt ?? null,
        durationMs: run?.durationMs ?? null,
        result: run?.result ?? null,
        nextRunAt: next,
        state,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
