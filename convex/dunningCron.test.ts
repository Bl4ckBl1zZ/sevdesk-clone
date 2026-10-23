import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { dunningSetup } from "./dunning.fixtures";
import { makeT } from "./test.setup";

/**
 * F05 DUN-030 daily job `dunning.run`: two crons (05:00 and 06:00 UTC) cover 07:00 Europe/Berlin in summer and winter;
 * the job gates on the Berlin hour and runs once per day. Test deployments (IS_TEST) skip the unforced job.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("DUN-030 DUN-037 the daily dunning job", () => {
  test("DUN-030 DUN-037 the daily job runs only at 07:00 Berlin and once per day; test deployments skip it unless forced", async () => {
    const t = makeT();
    await dunningSetup(t);
    vi.setSystemTime(new Date("2026-10-19T05:00:00Z"));
    expect(await t.mutation(internal.dunning.runCron, {})).toBeNull();
    expect(await t.mutation(internal.dunning.refreshOverdueCron, {})).toBeNull();
    vi.stubEnv("IS_TEST", "false");
    vi.setSystemTime(new Date("2026-10-19T10:00:00Z")); // 12:00 Berlin
    expect(await t.mutation(internal.dunning.runCron, {})).toBeNull();
    vi.setSystemTime(new Date("2026-10-19T05:10:00Z")); // 07:10 Berlin (CEST)
    expect(await t.mutation(internal.dunning.runCron, {})).toMatchObject({ drafts: 1 });
    expect(await t.mutation(internal.dunning.runCron, {})).toBeNull(); // the same day again
    vi.setSystemTime(new Date("2026-11-02T06:00:00Z")); // 07:00 Berlin (CET, the winter cron)
    expect(await t.mutation(internal.dunning.runCron, {})).not.toBeNull();
    vi.unstubAllEnvs();
    const runs = await t.run((ctx) => ctx.db.query("dunningRuns").collect());
    expect(runs.map((r) => [r.date, r.mode])).toEqual([
      ["2026-10-19", "auto"],
      ["2026-11-02", "auto"],
    ]);
  });
});
