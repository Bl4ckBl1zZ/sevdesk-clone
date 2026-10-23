import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { consumerBuyer, finalizedInvoice, invoiceValues } from "./invoices.fixtures";
import { makeT } from "./test.setup";

/** Branch coverage of convex/documentsApi.ts — the REST/MCP list, get and head reads (API-021, API-022). */

const PAGE = { numItems: 20, cursor: null };

describe("documentsApi.list", { timeout: 60_000 }, () => {
  test("API-021 lists one type with the status, contact_id and q filters", async () => {
    const t = makeT();
    const { owner, id, personId } = await finalizedInvoice(t);
    const consumer = await consumerBuyer(owner);
    const { id: draftId } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(consumer) });

    const all = await owner.query(api.documentsApi.list, { paginationOpts: PAGE, type: "invoice" });
    expect(all.page.map((r) => r.doc._id).sort()).toEqual([id, draftId].sort());
    const fin = all.page.find((r) => r.doc._id === id);
    expect(fin?.displayStatus.token).toBe("unsent");

    // status filter via the index
    const drafts = await owner.query(api.documentsApi.list, { paginationOpts: PAGE, type: "invoice", status: "draft" });
    expect(drafts.page.map((r) => r.doc._id)).toEqual([draftId]);
    // an unknown status is ignored (whole type)
    const unknown = await owner.query(api.documentsApi.list, { paginationOpts: PAGE, type: "invoice", status: "nope" });
    expect(unknown.page).toHaveLength(2);

    // contact_id: a valid id narrows, a malformed id returns an empty page
    const byContact = await owner.query(api.documentsApi.list, {
      paginationOpts: PAGE,
      type: "invoice",
      contactId: personId,
    });
    expect(byContact.page.map((r) => r.doc._id)).toEqual([id]);
    const badContact = await owner.query(api.documentsApi.list, {
      paginationOpts: PAGE,
      type: "invoice",
      contactId: "not-an-id",
    });
    expect(badContact).toEqual({ page: [], isDone: true, continueCursor: "" });

    // q searches the contact name; together with a status the status is filtered after the search
    const search = await owner.query(api.documentsApi.list, { paginationOpts: PAGE, type: "invoice", q: "Erika" });
    expect(search.page.map((r) => r.doc._id)).toEqual([draftId]);
    const searchStatus = await owner.query(api.documentsApi.list, {
      paginationOpts: PAGE,
      type: "invoice",
      q: "Erika",
      status: "finalized",
    });
    expect(searchStatus.page).toEqual([]);
    // whitespace-only q is no search
    const blank = await owner.query(api.documentsApi.list, { paginationOpts: PAGE, type: "invoice", q: "   " });
    expect(blank.page).toHaveLength(2);
    // other types are not mixed in
    const quotes = await owner.query(api.documentsApi.list, { paginationOpts: PAGE, type: "quote" });
    expect(quotes.page).toEqual([]);
  });

  test("API-005 a viewer key without documents:read is refused", async () => {
    const t = makeT();
    const key = await t.asApiKey(["contacts:read"]);
    await expect(key.query(api.documentsApi.list, { paginationOpts: PAGE, type: "invoice" })).rejects.toThrow();
  });
});

describe("documentsApi.get / head", { timeout: 60_000 }, () => {
  test("API-021 get returns null for malformed, unknown or other-type ids", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    expect(await owner.query(api.documentsApi.get, { id: "garbage", types: ["invoice"] })).toBeNull();
    expect(await owner.query(api.documentsApi.get, { id, types: ["quote"] })).toBeNull();
    // a deleted draft id is well-formed but unknown
    const { id: d } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues((await t.run(async (ctx) => (await ctx.db.get(id))?.contactId)) as string),
    });
    await owner.mutation(api.invoices.deleteDraft, { id: d });
    expect(await owner.query(api.documentsApi.get, { id: d, types: ["invoice"] })).toBeNull();
  });

  test("API-021 API-022 a finalised invoice has no validation; a draft converted from a proforma lists it as related, with findings", async () => {
    const t = makeT();
    const { owner, id, number } = await finalizedInvoice(t);
    const fin = await owner.query(api.documentsApi.get, { id, types: ["invoice"] });
    expect(fin).toMatchObject({ validation: null, canFinalize: null, related: {} });
    expect(fin?.lines).toHaveLength(1);
    expect(fin?.doc.number).toBe(number);

    await owner.mutation(api.settings.saveNumberRanges, {
      values: {
        ranges: [{ key: "proforma", name: "Proforma", format: "PF-{YYYY}-{####}", resetPolicy: "yearly", next: 1 }],
      },
    });
    const contactId = (await t.run(async (ctx) => (await ctx.db.get(id))?.contactId)) as string;
    const { supplyDate: _s, ...rest } = invoiceValues(contactId);
    const { id: pf } = await owner.mutation(api.invoices.createDraft, { values: { ...rest, type: "proforma" } });
    await owner.action(api.invoices.finalize, { id: pf, version: 1 });
    const { id: cid } = await owner.mutation(api.documentFlows.convert, { id: pf, values: { to: "invoice" } });
    const cor = await owner.query(api.documentsApi.get, { id: cid, types: ["invoice"] });
    expect(cor?.doc.status).toBe("draft");
    expect(cor?.related[pf]).toBe("proforma");
    expect(Array.isArray(cor?.validation)).toBe(true);
    expect(typeof cor?.canFinalize).toBe("boolean");
    for (const f of cor?.validation ?? []) expect(f.field === null || typeof f.field === "string").toBe(true);
  });

  test("API-022 head resolves any sales document to type, status, version and number", async () => {
    const t = makeT();
    const { owner, id, number } = await finalizedInvoice(t);
    expect(await owner.query(api.documentsApi.head, { id })).toEqual({
      id,
      type: "invoice",
      status: "finalized",
      version: expect.any(Number),
      number,
    });
    const { id: d } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues((await t.run(async (ctx) => (await ctx.db.get(id))?.contactId)) as Id<"contacts">),
    });
    expect(await owner.query(api.documentsApi.head, { id: d })).toMatchObject({ status: "draft", number: null });
    expect(await owner.query(api.documentsApi.head, { id: "nope" })).toBeNull();
    await owner.mutation(api.invoices.deleteDraft, { id: d });
    expect(await owner.query(api.documentsApi.head, { id: d })).toBeNull();
  });
});
