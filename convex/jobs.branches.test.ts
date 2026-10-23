import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JOB_EXPIRED, JOB_NOT_CANCELLABLE } from "../src/domain/jobs/jobs";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { advanceJob, createJob, failJob, finishJob, jobDetail, listJobs, resultUrl } from "./model/jobs";
import { makeT, type TestT } from "./test.setup";

/** F09 EXP-026 / 05 §4.7 background jobs: worker transitions, cancel, list, result download and expiry (branches). */

const NOW = new Date("2026-10-12T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const WORKER = { actor: "system:exports.run", channel: "system" } as const;

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

const messageOf = (e: unknown) => String((e as { data?: { message?: string } }).data?.message ?? e);

const newJob = (t: TestT, actor: Parameters<TestT["model"]>[0] = OWNER, total = 3) =>
  t.model(actor, (ctx) =>
    createJob(ctx, { kind: "csv_export", label: "CSV-Export", params: { list: "documents" }, total }),
  ) as Promise<Id<"jobs">>;

/** The worker starts the job (queued → running), then finishes it. */
const runAndFinish = (t: TestT, id: Id<"jobs">, result: Parameters<typeof finishJob>[2]) =>
  t.model(WORKER, async (ctx) => {
    await advanceJob(ctx, id, { status: "running" });
    return finishJob(ctx, id, result);
  });

const storeFile = (t: TestT, text = "a;b\r\n") => t.run((ctx) => ctx.storage.store(new Blob([text])));
const job = (t: TestT, id: Id<"jobs">) => t.run((ctx) => ctx.db.get(id));
const actions = (t: TestT) =>
  t.run(async (ctx) => (await ctx.db.query("auditLog").withIndex("by_seq").collect()).map((e) => e.action));

describe("job worker transitions (EXP-026)", () => {
  test("EXP-026 the worker starts, reports progress and finishes; done jobs cannot be advanced or failed any more", async () => {
    const t = makeT();
    await t.asUser("owner");
    const id = await newJob(t, { ...OWNER, label: "owner@example.test", requestId: "req-1" });
    expect((await job(t, id))?.by).toMatchObject({ label: "owner@example.test", requestId: "req-1", role: "owner" });

    expect(await t.model(WORKER, (ctx) => advanceJob(ctx, id, {}))).toBe(true);
    expect(await job(t, id)).toMatchObject({ status: "running", progress: { done: 0, total: 3 } });
    expect(await t.model(WORKER, (ctx) => advanceJob(ctx, id, { done: 2, total: 4 }))).toBe(true);
    expect((await job(t, id))?.progress).toEqual({ done: 2, total: 4 });
    expect((await actions(t)).filter((a) => a.startsWith("job."))).toEqual(["job.create", "job.start", "job.progress"]);

    // no file, no export action: the job is done without a result and without an export audit entry
    expect(await t.model(WORKER, (ctx) => finishJob(ctx, id, {}))).toBe(true);
    const done = await job(t, id);
    expect(done).toMatchObject({ status: "done", progress: { done: 4, total: 4 }, finishedAt: NOW.getTime() });
    expect(done?.resultStorageId).toBeUndefined();
    expect(done?.expiresAt).toBeUndefined();
    expect(await actions(t)).not.toContain("export.csv");

    expect(await t.model(WORKER, (ctx) => advanceJob(ctx, id, { done: 1 }))).toBe(false);
    await t.model(WORKER, (ctx) => failJob(ctx, id, "zu spät"));
    expect((await job(t, id))?.status).toBe("done");
  });

  test("EXP-026 a finished job keeps the skipped list and the export audit entry defaults to 0 bytes and the job label", async () => {
    const t = makeT();
    await t.asUser("owner");
    const id = await newJob(t);
    const storageId = await storeFile(t);
    expect(
      await runAndFinish(t, id, {
        storageId,
        sha256: "ab".repeat(32),
        skipped: [{ id: "x", label: "RE-1", reason: "kein PDF" }],
        exportAction: "export.csv",
      }),
    ).toBe(true);
    const done = await job(t, id);
    expect(done).toMatchObject({ resultStorageId: storageId, expiresAt: NOW.getTime() + 30 * DAY });
    expect(done?.skipped).toEqual([{ id: "x", label: "RE-1", reason: "kein PDF" }]);
    const entry = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).find((e) => e.action === "export.csv"),
    );
    expect(entry).toMatchObject({ actor: "user:test-owner", entity: { table: "exports", label: "CSV-Export" } });
    expect(entry?.diff?.after).toMatchObject({ sha256: "ab".repeat(32), bytes: 0 });
  });

  test("EXP-026 a job cancelled while the worker ran: the worker stops, the file is deleted, failing changes nothing", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const id = await newJob(t);
    await t.model(WORKER, (ctx) => advanceJob(ctx, id, { status: "running" }));
    await owner.mutation(api.jobs.cancel, { id });
    expect(await t.model(WORKER, (ctx) => advanceJob(ctx, id, { done: 1 }))).toBe(false);
    const storageId = await storeFile(t);
    expect(await t.model(WORKER, (ctx) => finishJob(ctx, id, { storageId }))).toBe(false);
    expect(await t.run((ctx) => ctx.db.system.get(storageId))).toBeNull();
    // a cancelled job without a file: nothing to delete
    expect(await t.model(WORKER, (ctx) => finishJob(ctx, id, {}))).toBe(false);
    await t.model(WORKER, (ctx) => failJob(ctx, id, "abgebrochen"));
    expect(await job(t, id)).toMatchObject({ status: "cancelled" });
    expect((await job(t, id))?.error).toBeUndefined();
  });

  test("EXP-026 a failed job keeps the shortened error (500 characters) and cannot be cancelled any more", async () => {
    const t = makeT();
    await t.asUser("owner");
    const id = await newJob(t);
    await t.model(WORKER, (ctx) => failJob(ctx, id, "x".repeat(800)));
    const failed = await job(t, id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error?.length).toBe(500);
    expect(await actions(t)).toContain("job.fail");
    const owner = await t.asUser("owner");
    const err = await catching(owner.mutation(api.jobs.cancel, { id }));
    expect(errorCode(err)).toBe("invalid_input");
    expect(messageOf(err)).toBe(JOB_NOT_CANCELLABLE);
  });

  test("EXP-026 unknown and malformed job ids are not found", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const id = await newJob(t);
    await t.run((ctx) => ctx.db.delete(id)); // a removed row (never happens in the app; checks the guard)
    expect(errorCode(await catching(t.model(WORKER, (ctx) => advanceJob(ctx, id, {}))))).toBe("not_found");
    expect(errorCode(await catching(t.model(WORKER, (ctx) => finishJob(ctx, id, {}))))).toBe("not_found");
    expect(errorCode(await catching(t.model(WORKER, (ctx) => failJob(ctx, id, "x"))))).toBe("not_found");
    expect(errorCode(await catching(owner.mutation(api.jobs.cancel, { id: "kaputt" })))).toBe("not_found");
    expect(errorCode(await catching(owner.query(api.jobs.resultUrl, { id: "kaputt" })))).toBe("not_found");
    expect(errorCode(await catching(owner.query(api.jobs.get, { id: "kaputt" })))).toBe("not_found");
    expect(errorCode(await catching(owner.query(api.jobs.get, { id })))).toBe("not_found");
  });
});

describe("job list, detail and download (EXP-026, 05 §4.7)", () => {
  test("EXP-026 a bookkeeper lists only their own jobs; the owner sees all; optional fields default to null", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const bookkeeper = await t.asUser("bookkeeper", { email: "bk@example.test" });
    const mine = await newJob(t, { actor: bookkeeper.actor, role: "bookkeeper", channel: "ui" });
    await newJob(t);
    const list = await bookkeeper.query(api.jobs.list, {});
    expect(list.map((j) => j.id)).toEqual([mine]);
    expect(list[0]).toMatchObject({
      status: "queued",
      resultName: null,
      resultSha256: null,
      resultBytes: null,
      hasResult: false,
      skipped: [],
      error: null,
      finishedAt: null,
      expiresAt: null,
    });
    expect((await owner.query(api.jobs.list, {})).length).toBe(2);
  });

  test("EXP-026 another member's job: download forbidden, detail not found (existence never leaks); the owner gets both", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const bookkeeper = await t.asUser("bookkeeper", { email: "bk@example.test" });
    const id = await newJob(t);
    const storageId = await storeFile(t);
    await runAndFinish(t, id, { storageId, bytes: 5 });

    expect(errorCode(await catching(bookkeeper.query(api.jobs.resultUrl, { id })))).toBe("forbidden_role");
    expect(errorCode(await catching(bookkeeper.query(api.jobs.get, { id })))).toBe("not_found");

    const url = await owner.query(api.jobs.resultUrl, { id });
    expect(url).toMatchObject({ name: "export", sha256: null });
    expect(url.url).toEqual(expect.any(String));
    const detail = await owner.query(api.jobs.get, { id });
    expect(detail).toMatchObject({
      id,
      status: "done",
      resultName: null,
      resultSha256: null,
      resultBytes: 5,
      error: null,
      finishedAt: NOW.getTime(),
      expiresAt: NOW.getTime() + 30 * DAY,
    });
    expect(detail.resultUrl).toEqual(expect.any(String));

    // after 30 days: no link in the detail, the download says why
    vi.setSystemTime(new Date(NOW.getTime() + 30 * DAY));
    expect((await owner.query(api.jobs.get, { id })).resultUrl).toBeNull();
    const err = await catching(owner.query(api.jobs.resultUrl, { id }));
    expect(errorCode(err)).toBe("not_found");
    expect(messageOf(err)).toBe(JOB_EXPIRED);
  });

  test("EXP-026 05 §4.7 an API key reads its own job through GET /jobs/{id}; a job without a result has no link", async () => {
    const t = makeT();
    await t.asUser("owner");
    const key = await t.asApiKey(["exports:run"]);
    const id = await newJob(t, { actor: key.actor, channel: "api" });
    const detail = await key.query(api.jobs.get, { id });
    expect(detail).toMatchObject({ id, actor: key.actor, status: "queued", resultUrl: null, expiresAt: null });
    expect(errorCode(await catching(key.query(api.jobs.resultUrl, { id })))).toBe("forbidden_scope");
  });

  test("EXP-026 jobs without a result or without an expiry are listed with nulls by the model too", async () => {
    const t = makeT();
    await t.asUser("owner");
    const id = await newJob(t);
    await runAndFinish(t, id, { name: "x.csv", sha256: "cd".repeat(32) });
    const rows = await t.run((ctx) => listJobs({ ...ctx, actor: "user:someone-else", role: "viewer" }));
    expect(rows).toEqual([]);
    const err = await catching(t.run((ctx) => resultUrl({ ...ctx, actor: "user:test-owner", now: Date.now }, id)));
    expect(messageOf(err)).toBe(JOB_EXPIRED);
    const d = await t.run((ctx) => jobDetail({ ...ctx, actor: "user:test-owner", now: Date.now }, id));
    expect(d).toMatchObject({ resultName: "x.csv", resultSha256: "cd".repeat(32), resultUrl: null });
  });
});

describe("result expiry cron (EXP-026)", () => {
  test("EXP-026 the cron skips under IS_TEST unless forced and removes only results older than 30 days", async () => {
    const t = makeT();
    await t.asUser("owner");
    expect(await t.mutation(internal.jobs.expireCron, {})).toBeNull();
    const old = await newJob(t);
    await runAndFinish(t, old, {});
    const fileJob = await newJob(t);
    const storageId = await storeFile(t);
    await runAndFinish(t, fileJob, { storageId });
    vi.setSystemTime(new Date(NOW.getTime() + 10 * DAY));
    const fresh = await newJob(t);
    const freshFile = await storeFile(t);
    await runAndFinish(t, fresh, { storageId: freshFile });
    expect(await t.mutation(internal.jobs.expireCron, { force: true })).toBe(0);
    vi.setSystemTime(new Date(NOW.getTime() + 31 * DAY));
    expect(await t.mutation(internal.jobs.expireCron, { force: true })).toBe(1);
    expect((await job(t, fileJob))?.resultStorageId).toBeUndefined();
    expect(await actions(t)).toContain("job.expire");
  });
});
