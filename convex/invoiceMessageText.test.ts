import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BUYERS } from "../test/factories/snapshot";
import { api } from "./_generated/api";
import { finalizedInvoice } from "./invoices.fixtures";
import { makeT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("SND-19 „E-Mail-Text kopieren“", { timeout: 30_000 }, () => {
  test("SND-19 T-SND-014 subject/body from the message_text template and the snapshot; nothing is logged or changed", async () => {
    const t = makeT();
    const { owner, id, number } = await finalizedInvoice(t);
    await owner.mutation(api.lookups.saveTextTemplate, {
      values: {
        kind: "message_text",
        docTypes: ["invoice"],
        language: "de",
        name: "Rechnung kurz",
        subject: "Rechnung {{document.number}}",
        body: "<p>{{contact.letterSalutation}}</p><p>anbei Rechnung {{document.number}} über {{document.grossTotal}}.</p>",
        isDefault: true,
      },
    });
    const before = await t.run(async (ctx) => ({
      doc: await ctx.db.get(id),
      log: await ctx.db.query("sendLog").collect(),
      audit: (await ctx.db.query("auditLog").collect()).length,
    }));
    const r = await owner.query(api.invoices.messageText, { id });
    expect(r?.subject).toBe(`Rechnung ${number}`);
    expect(r?.body).toMatch(new RegExp(`anbei Rechnung ${number} über 1\\.190,00\\s€\\.`));
    expect(r?.templateName).toBe("Rechnung kurz");
    expect(r?.recipients).toContain(BUYERS.b2b.invoiceEmail);
    expect(r?.mailto.startsWith("mailto:")).toBe(true);
    const after = await t.run(async (ctx) => ({
      doc: await ctx.db.get(id),
      log: await ctx.db.query("sendLog").collect(),
      audit: (await ctx.db.query("auditLog").collect()).length,
    }));
    expect(after).toEqual(before);
  });

  test("SND-19 drafts have no e-mail text (placeholders need the final number)", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const copy = await owner.mutation(api.invoices.duplicate, { id });
    expect(await owner.query(api.invoices.messageText, { id: copy.id })).toBeNull();
  });
});
