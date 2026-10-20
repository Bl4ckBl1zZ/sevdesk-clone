import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { b2bBuyer, invoiceValues, setupInvoicing } from "./invoices.fixtures";
import { makeT, type TestT } from "./test.setup";

/**
 * Step 3 of the finalise pipeline (documentArtifacts.render) when loading its input fails transiently — e.g. the
 * backend's 1 s query limit on a loaded machine („Function execution timed out“), seen in the e2e runs.
 */
const fail = vi.hoisted(() => ({ renderInput: false }));
vi.mock("./model/companyProfile", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./model/companyProfile")>();
  return {
    ...mod,
    getCompanyProfile: (async (...args: Parameters<typeof mod.getCompanyProfile>) => {
      if (fail.renderInput) throw new Error("Function execution timed out (maximum duration: 1s)");
      return mod.getCompanyProfile(...args);
    }) as typeof mod.getCompanyProfile,
  };
});

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fail.renderInput = false;
});
afterEach(() => {
  vi.useRealTimers();
});

const doc = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => {
    const d = await ctx.db.get(id);
    if (!d) throw new Error("missing");
    return d;
  });

const cancelPendingJobs = (t: TestT) =>
  t.run(async (ctx) => {
    for (const j of await ctx.db.system.query("_scheduled_functions").collect())
      if (j.state.kind === "pending") await ctx.scheduler.cancel(j._id);
  });

describe("documentArtifacts.render", () => {
  test("DOC-28 EC-005 a failure while loading the render input counts as a failed attempt (retried with backoff), not a dead job", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await cancelPendingJobs(t);

    fail.renderInput = true;
    await t.action(internal.documentArtifacts.render, { id });
    fail.renderInput = false;
    const d = await doc(t, id);
    // Not a dead job that only the 10-minute watchdog finds: the attempt is recorded like any render failure.
    expect(d).toMatchObject({ artifactStatus: "pending", artifactAttempts: 1 });
    expect(d.artifactError).toMatch(/timed out/);
    // The retry itself (10 s, 1 min, …) is scheduled by artifactFailure outside IS_TEST (DOC-28 backoff test);
    // here the next attempt runs directly and succeeds.
    await cancelPendingJobs(t);
    await t.action(internal.documentArtifacts.render, { id });
    expect((await doc(t, id)).artifactStatus).toBe("ready");
  });
});
