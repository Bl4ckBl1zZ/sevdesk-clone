import { describe, expect, test } from "vitest";
import { localTimerFromQueue, type OfflineOp, planOfflineSync } from "./offline";

const M = 60_000;
const T0 = Date.UTC(2026, 9, 23, 8, 0); // 10:00 Berlin
const NOW = T0 + 8 * 60 * M;
const fields = { description: "Workshop", projectId: "p1" };

const start = (id: string, at: number): OfflineOp => ({ id, kind: "timer_start", at, fields });
const stop = (id: string, at: number): OfflineOp => ({ id, kind: "timer_stop", at });

describe("PRJ-018 offline replay", () => {
  test("PRJ-018 manual entries and an offline timer start/stop replay in instant order; no timer → it becomes the running one", () => {
    const manual: OfflineOp = { id: "m1", kind: "manual", at: T0 + 5 * M, values: { duration: "1:30" } };
    const plan = planOfflineSync(null, "phone", [stop("s1", T0 + 60 * M), manual, start("a1", T0)], NOW);
    expect(plan).toEqual({
      conflict: false,
      actions: [
        { type: "start_timer", opId: "a1", startedAt: T0, fields },
        { type: "manual", opId: "m1", values: { duration: "1:30" } },
        { type: "stop_timer", opId: "s1", endedAt: T0 + 60 * M, conflict: false },
      ],
    });
  });

  test("PRJ-018 device clocks ahead of the server are capped at now; a stop without a timer is skipped", () => {
    const plan = planOfflineSync(null, "phone", [start("a1", NOW + 5 * M), stop("s0", NOW + 6 * M)], NOW);
    expect(plan.actions[0]).toMatchObject({ type: "start_timer", startedAt: NOW });
    expect(planOfflineSync(null, "phone", [stop("s1", T0)], NOW).actions).toEqual([
      { type: "skip", opId: "s1", reason: "no_timer" },
    ]);
  });

  test("PRJ-018 the device's own running timer is stopped by a new offline start (no conflict) and by an offline stop", () => {
    const own = { startedAt: T0, deviceId: "phone" };
    expect(planOfflineSync(own, "phone", [start("a1", T0 + 30 * M)], NOW).actions).toEqual([
      { type: "stop_timer", opId: "a1", endedAt: T0 + 30 * M, conflict: false },
      { type: "start_timer", opId: "a1", startedAt: T0 + 30 * M, fields },
    ]);
    expect(planOfflineSync(own, "phone", [stop("s1", T0 + 45 * M)], NOW)).toEqual({
      conflict: false,
      actions: [{ type: "stop_timer", opId: "s1", endedAt: T0 + 45 * M, conflict: false }],
    });
  });
});

describe("PRJ-018 local view of the queue", () => {
  test("PRJ-018 the queued start without a later stop is the running offline timer", () => {
    expect(localTimerFromQueue([])).toBeNull();
    expect(localTimerFromQueue([start("a1", T0)])).toEqual({ startedAt: T0, fields });
    expect(localTimerFromQueue([start("a1", T0), stop("s1", T0 + M)])).toBeNull();
    expect(localTimerFromQueue([stop("s1", T0 + M), start("a1", T0), start("a2", T0 + 2 * M)])).toEqual({
      startedAt: T0 + 2 * M,
      fields,
    });
  });
});

describe("E-PRJ-29 two devices start a timer offline", () => {
  test("E-PRJ-29 TST-PRJ-20 the offline start is later: it wins; the other device's timer becomes a conflict entry", () => {
    const desktop = { startedAt: T0, deviceId: "desktop" };
    const plan = planOfflineSync(desktop, "phone", [start("a1", T0 + 20 * M)], NOW);
    expect(plan).toEqual({
      conflict: true,
      actions: [
        { type: "stop_timer", opId: "a1", endedAt: T0 + 20 * M, conflict: true },
        { type: "start_timer", opId: "a1", startedAt: T0 + 20 * M, fields },
      ],
    });
  });

  test("E-PRJ-29 the offline start is earlier: the other device's later start wins; the offline run becomes the conflict entry", () => {
    const desktop = { startedAt: T0 + 30 * M, deviceId: "desktop" };
    // still running offline when the connection returns → ends where the other timer started
    expect(planOfflineSync(desktop, "phone", [start("a1", T0)], NOW)).toEqual({
      conflict: true,
      actions: [{ type: "entry", opId: "a1", startedAt: T0, endedAt: T0 + 30 * M, fields, conflict: true }],
    });
    // stopped offline after the other start → still overlapping → conflict, cut at the other start
    expect(planOfflineSync(desktop, "phone", [start("a1", T0), stop("s1", T0 + 50 * M)], NOW).actions).toEqual([
      { type: "entry", opId: "a1", startedAt: T0, endedAt: T0 + 30 * M, fields, conflict: true },
    ]);
    // stopped before the other device started → no overlap, a plain entry
    expect(planOfflineSync(desktop, "phone", [start("a1", T0), stop("s1", T0 + 20 * M)], NOW)).toEqual({
      conflict: false,
      actions: [{ type: "entry", opId: "a1", startedAt: T0, endedAt: T0 + 20 * M, fields, conflict: false }],
    });
  });
});
