import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import { api } from "./_generated/api";
import { finalizedInvoice, invoiceValues, settle } from "./invoices.fixtures";
import { makeT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("DOC-36 „Letztes Dokument übernehmen“", { timeout: 60_000 }, () => {
  test("DOC-36 T-DOC-041 the contact's last issued invoice offers its lines and texts; drafts and Storno are skipped", async () => {
    const t = makeT();
    const { owner, id, number, personId } = await finalizedInvoice(t, { subject: "Wartung Oktober" });
    const contactId = personId as Id<"contacts">;
    // a newer draft and the type filter do not change the offer
    await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { subject: "Entwurf", lines: [] }),
    });
    const last = await owner.query(api.invoices.lastDocument, { contactId, type: "invoice" });
    expect(last).toMatchObject({ id, number, documentDate: "2026-10-12" });
    expect(last?.content.subject).toBe("Wartung Oktober");
    const source = await owner.query(api.invoices.get, { id });
    expect(last?.content.lines.map((l) => l.name)).toEqual(source?.lines.map((l) => l.name));
    expect(JSON.stringify(last?.content)).not.toContain("supplyDate");
    expect(await owner.query(api.invoices.lastDocument, { contactId, type: "quote" })).toBeNull();
    // a cancelled invoice is no longer offered
    await owner.mutation(api.corrections.cancel, { id });
    await settle(t);
    expect(await owner.query(api.invoices.lastDocument, { contactId, type: "invoice" })).toBeNull();
  });
});
