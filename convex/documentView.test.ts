import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { b2bBuyer, finalizedInvoice, invoiceValues, setupInvoicing } from "./invoices.fixtures";
import { makeT, type TestT } from "./test.setup";

/**
 * F04 §6.4 / DOC-62: the „Vorschau“ section of the Beleg page names the archived original PDF of a finalised document.
 * Viewing is not an export: nothing is written (no `document.export` audit entry, no „Kopie“ rendered).
 */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const counts = (t: TestT) =>
  t.run(async (ctx) => ({
    audit: (await ctx.db.query("auditLog").collect()).length,
    artifacts: (await ctx.db.query("documentArtifacts").collect()).length,
  }));

describe("invoices.viewInput (DOC-62)", () => {
  test("DOC-62 a finalised invoice yields the URL of its archived original PDF and writes nothing", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const before = await counts(t);
    const r = await owner.query(api.invoices.viewInput, { id });
    expect(r.status).toBe("finalized");
    expect(r.artifactStatus).toBe("ready");
    expect(r.variant).toBe("original");
    expect(["pdf", "zugferd_pdf"]).toContain(r.kind);
    expect(typeof r.url).toBe("string");
    expect(await counts(t)).toEqual(before);
  });

  test("DOC-62 while the files are still being produced there is no URL yet", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await t.run(async (ctx) => {
      for (const j of await ctx.db.system.query("_scheduled_functions").collect())
        if (j.state.kind === "pending") await ctx.scheduler.cancel(j._id);
    });
    const r = await owner.query(api.invoices.viewInput, { id });
    expect(r).toMatchObject({ status: "finalized", artifactStatus: "pending", url: null });
  });

  test("DOC-62 a draft has no archived PDF (the draft render of DOC-42 is used) and reports its version", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const r = await owner.query(api.invoices.viewInput, { id });
    expect(r).toMatchObject({ status: "draft", version: 1, url: null });
  });
});
