import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PREVIEW_NUMBER } from "../src/domain/documents/snapshot";
import { api } from "./_generated/api";
import { b2bBuyer, finalizedInvoice, invoiceValues, setupInvoicing } from "./invoices.fixtures";
import { makeT } from "./test.setup";

/**
 * F04 §4.4.7 „PDF-Vorschau“ / DOC-42: the draft PDF is rendered from the preview snapshot of the finalisation
 * pipeline (number PREVIEW-0000, watermark „ENTWURF“). The query writes nothing; rendering happens in Next.js.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("invoices.draftRenderInput (DOC-42)", () => {
  test("DOC-42 a valid draft yields the preview snapshot and the layout inputs without writing anything", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const auditBefore = await t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).length);
    const r = await owner.query(api.invoices.draftRenderInput, { id });
    expect(r.status).toBe("draft");
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(r.snapshot?.number).toBe(PREVIEW_NUMBER);
    expect(r.snapshot?.type).toBe("invoice");
    expect(r.snapshot?.lines.some((l) => l.kind === "item" && l.name === "Beratung Webdesign")).toBe(true);
    expect(r).toHaveProperty("layoutConfig");
    expect(r).toHaveProperty("logoUrl", null);
    const after = await t.run(async (ctx) => ({
      audit: (await ctx.db.query("auditLog").collect()).length,
      snapshots: (await ctx.db.query("documentSnapshots").collect()).length,
      doc: await ctx.db.get(id),
    }));
    expect(after.audit).toBe(auditBefore);
    expect(after.snapshots).toBe(0);
    expect(after.doc?.status).toBe("draft");
    expect(after.doc?.number).toBeUndefined();
  });

  test("DOC-42 a draft with blocking findings yields no snapshot but the findings", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { contactId: _c, ...noContact } = invoiceValues(personId);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: noContact });
    const r = await owner.query(api.invoices.draftRenderInput, { id });
    expect(r.snapshot).toBeNull();
    expect(r.findings.some((f) => f.severity === "E")).toBe(true);
  });

  test("DOC-42 a finalised document has no draft preview (the archived PDF is exported instead)", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const r = await owner.query(api.invoices.draftRenderInput, { id });
    expect(r.status).toBe("finalized");
    expect(r.snapshot).toBeNull();
  });

  test("DOC-42 a viewer may preview (documents.read)", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const viewer = await t.asUser("viewer");
    expect((await viewer.query(api.invoices.draftRenderInput, { id })).snapshot?.number).toBe(PREVIEW_NUMBER);
  });
});
