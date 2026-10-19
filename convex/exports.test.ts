import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { createJob } from "./model/jobs";
import { makeT, type TestT } from "./test.setup";

/** F09 EXP-021/022/026: list CSV exports (both variants), the job path, cancel and the 30-day result. */

const NOW = new Date("2026-10-12T10:00:00Z");
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}
const auditOf = (t: TestT, action: string) =>
  t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).filter((e) => e.action === action));

describe("list CSV export (EXP-021, EXP-022)", () => {
  test("EXP-021 the invoice list exports as „CSV (Excel)“ and „CSV (technisch)“; each export is audited with its hash", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const excel = await f.owner.mutation(api.exports.csv, { list: "documents", variant: "excel" });
    if (excel.kind !== "file") throw new Error("expected a direct file");
    expect(excel.name).toBe("dokumente-2026-10-12.csv");
    expect(excel.content.startsWith("﻿Art;Nummer;Kunde;Datum;Fällig;Netto;USt;Brutto")).toBe(true);
    expect(excel.content).toContain(`Rechnung;${f.number};`);
    expect(excel.content).toContain(";1000,00;190,00;1190,00;");
    const technical = await f.owner.mutation(api.exports.csv, { list: "documents", variant: "technical" });
    if (technical.kind !== "file") throw new Error("expected a direct file");
    expect(technical.content.startsWith("id,type,number")).toBe(true);
    expect(technical.content).toContain(`${f.id},Rechnung,${f.number}`);
    expect(technical.content).toContain(",100000,19000,119000,");
    const [entry] = await auditOf(t, "export.csv");
    expect(entry?.diff?.after).toMatchObject({ sha256: await sha256Hex(excel.content), rows: 1 });

    const opos = await f.owner.mutation(api.exports.csv, { list: "open_items", variant: "excel" });
    if (opos.kind !== "file") throw new Error("expected a direct file");
    expect(opos.content).toContain(`${f.number};`);
    const journal = await f.owner.mutation(api.exports.csv, { list: "journal", variant: "technical" });
    if (journal.kind !== "file") throw new Error("expected a direct file");
    expect(journal.content.split("\r\n")[0]).toBe(
      "entry_id,seq,date,text,line,account,debit_cents,credit_cents,source_kind,reversal",
    );
  });

  test("EXP-021 an API key needs the list's own read scope on top of documents:read", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    const key = await t.asApiKey(["documents:read"]);
    expect((await key.mutation(api.exports.csv, { list: "documents", variant: "technical" })).kind).toBe("file");
    expect(
      errorCode(await catching(key.mutation(api.exports.csv, { list: "bank_transactions", variant: "excel" }))),
    ).toBe("forbidden_scope");
  });
});

describe("export jobs (EXP-026)", () => {
  test("EXP-026 a CSV job stores the file for 30 days, audits the hash for the creator and notifies; expired results are removed", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const jobId = await t.model(OWNER, (ctx) =>
      createJob(ctx, {
        kind: "csv_export",
        label: "CSV-Export",
        params: { list: "documents", variant: "excel" },
        total: 1,
      }),
    );
    expect(await t.action(internal.exports.runCsvJob, { jobId })).toBe(true);
    const [job] = await f.owner.query(api.jobs.list, {});
    expect(job).toMatchObject({ status: "done", hasResult: true, resultName: "dokumente-2026-10-12.csv" });
    expect(job?.expiresAt).toBe(NOW.getTime() + 30 * DAY);
    const url = await f.owner.query(api.jobs.resultUrl, { id: jobId });
    expect(url.sha256).toBe(job?.resultSha256);
    const [entry] = (await auditOf(t, "export.csv")).filter((e) => e.entity.id === jobId);
    expect(entry).toMatchObject({ actor: "user:test-owner", channel: "ui" });
    expect((await f.owner.query(api.notifications.list, { kind: "export.ready" })).length).toBe(1);

    vi.setSystemTime(new Date(NOW.getTime() + 31 * DAY));
    expect(await t.mutation(internal.jobs.expireCron, { force: true })).toBe(1);
    const owner = await t.asUser("owner");
    expect(errorCode(await catching(owner.query(api.jobs.resultUrl, { id: jobId })))).toBe("not_found");
  });

  test("EXP-026 a job can be cancelled while queued; the worker then stops and keeps no file; others' jobs are protected", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const jobId = (await t.model(OWNER, (ctx) =>
      createJob(ctx, {
        kind: "csv_export",
        label: "CSV-Export",
        params: { list: "documents", variant: "excel" },
        total: 1,
      }),
    )) as Id<"jobs">;
    const bookkeeper = await t.asUser("bookkeeper");
    expect(errorCode(await catching(bookkeeper.mutation(api.jobs.cancel, { id: jobId })))).toBe("forbidden_role");
    await f.owner.mutation(api.jobs.cancel, { id: jobId });
    expect(await t.action(internal.exports.runCsvJob, { jobId })).toBe(false);
    const [job] = await f.owner.query(api.jobs.list, {});
    expect(job).toMatchObject({ status: "cancelled", hasResult: false });
    expect(errorCode(await catching(f.owner.mutation(api.jobs.cancel, { id: jobId })))).toBe("invalid_input");
  });
});
