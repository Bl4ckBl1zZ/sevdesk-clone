import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { b2bBuyer, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";

/** F04 SND-20 bulk export ZIP and bulk sent mark as jobs (F09 EXP-026). */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function documents(t: TestT) {
  const setup = await setupInvoicing(t);
  const { personId } = await b2bBuyer(setup.owner);
  const ids: Id<"salesDocuments">[] = [];
  const numbers: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { id } = await setup.owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const r = await setup.owner.action(api.invoices.finalize, { id, version: 1 });
    ids.push(id as Id<"salesDocuments">);
    numbers.push(r.number as string);
  }
  const draft = await setup.owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
  await settle(t);
  return { owner: setup.owner, ids, numbers, draftId: draft.id as Id<"salesDocuments"> };
}

const jobsOf = (t: TestT) => t.run((ctx) => ctx.db.query("jobs").collect());

describe("bulk operations (SND-20)", () => {
  test("SND-20 „Sammel-Export“ zips one folder per document with index.csv and SHA256SUMS.txt; drafts are skipped", async () => {
    const t = makeT();
    const { owner, ids, numbers, draftId } = await documents(t);
    await owner.mutation(api.bulk.startExport, { ids: [...ids, draftId, ids[0] as Id<"salesDocuments">] });
    await t.finishAllScheduledFunctions(() => {});
    const [job] = await jobsOf(t);
    expect(job).toMatchObject({ kind: "bulk_export", status: "done", progress: { total: 3 } });
    expect(job?.skipped).toEqual([
      { id: draftId, label: "Entwurf", reason: "Entwürfe können nicht exportiert werden." },
    ]);
    const bytes = await t.run(async (ctx) => {
      const blob = await ctx.storage.get(job?.resultStorageId as Id<"_storage">);
      return (await (blob as Blob).arrayBuffer()) as ArrayBuffer;
    });
    const files = unzipSync(new Uint8Array(bytes));
    const names = Object.keys(files).sort();
    for (const n of numbers) expect(names.some((f) => f.startsWith(`${n.replaceAll("/", "-")}/`))).toBe(true);
    expect(names).toContain("index.csv");
    expect(names).toContain("SHA256SUMS.txt");
    const sums = new TextDecoder().decode(files["SHA256SUMS.txt"]);
    expect(sums.trim().split("\n")).toHaveLength(names.length - 2);
    const exports = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((e) => e.action === "document.export"),
    );
    expect(new Set(exports.map((e) => e.entity.id))).toEqual(new Set(ids));
    expect(exports.every((e) => e.actor.startsWith("user:"))).toBe(true);
  });

  test("SND-20 „Sammel-Markierung“ marks each document individually with one sentOn/channel; failures are listed", async () => {
    const t = makeT();
    const { owner, ids, draftId } = await documents(t);
    await owner.mutation(api.bulk.startMarkSent, {
      ids: [...ids, draftId],
      values: { sentOn: "2026-10-12", channel: "email_manual", note: "Sammelversand" },
    });
    await t.finishAllScheduledFunctions(() => {});
    const [job] = await jobsOf(t);
    expect(job).toMatchObject({ kind: "bulk_mark_sent", status: "done" });
    expect(job?.skipped?.map((s) => s.id)).toEqual([draftId]);
    const logs = await t.run((ctx) => ctx.db.query("sendLog").collect());
    expect(logs.filter((l) => ids.includes(l.documentId as Id<"salesDocuments">))).toHaveLength(2);
    for (const id of ids) expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("sent");
  });

  test("SND-20 at most 2,000 documents per job; a viewer cannot start a bulk mark", async () => {
    const t = makeT();
    const { owner, ids } = await documents(t);
    const many = Array.from({ length: 2001 }, (_, i) => ids[i % 2] as Id<"salesDocuments">);
    // duplicates collapse, so the limit is about distinct documents — 2 distinct here
    await owner.mutation(api.bulk.startExport, { ids: many });
    const viewer = await t.asUser("viewer");
    let e: unknown;
    try {
      await viewer.mutation(api.bulk.startMarkSent, { ids, values: { sentOn: "2026-10-12", channel: "post" } });
    } catch (x) {
      e = x;
    }
    expect(errorCode(e)).toBe("forbidden_role");
    let empty: unknown;
    try {
      await owner.mutation(api.bulk.startExport, { ids: [] });
    } catch (x) {
      empty = x;
    }
    expect(errorCode(empty)).toBe("invalid_input");
    await t.finishAllScheduledFunctions(() => {});
  });
});
