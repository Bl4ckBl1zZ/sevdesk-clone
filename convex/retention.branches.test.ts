import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ABLAUFHEMMUNG_ITEMS, PURGE_MESSAGES, PURGE_PHRASE } from "../src/domain/privacy/purge";
import { api } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import { createValues, personForm, setupCatalog } from "./catalog.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import {
  auditPrefixCandidate,
  createPurgeBatch,
  createReplayBatch,
  endHold,
  finishPurgeBatch,
  insertAnchor,
  type PurgeLog,
  purgeAuditPrefixStep,
  purgeHistory,
  purgeLog,
  purgePreview,
  purgeStep,
  replayChunk,
  replayMessage,
  retentionWorklist,
  scanRetention,
  startHold,
} from "./model/retention";
import { makeT, type TestT } from "./test.setup";

/**
 * F12 PRV-003…PRV-009 — the refusals and edge paths of the retention engine: Betriebsprüfung-Modus, batches that are
 * not running, audit-prefix anchors, the off-host purge log and the replay after a restore.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const CHECKLIST = Object.fromEntries(ABLAUFHEMMUNG_ITEMS.map((i) => [i.id, true]));
const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);
async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}
const ghost = <T extends TableNames>(table: T) => `${"9".repeat(32 - table.length)}${table}` as Id<T>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const LOG: PurgeLog = {
  format: "rechnungen-purge-log/1",
  batch: { id: "batch-alt", createdAt: 1, actor: "user:test-owner", classes: ["vouchers8"], years: [], checklist: {} },
  tombstones: [],
  anchors: [],
};
/** A running batch without eligible data (a replay batch is the cheapest way to get one). */
const runningBatch = (t: TestT, log: PurgeLog = LOG) => t.model(OWNER, (ctx) => createReplayBatch(ctx, log));
const batch = (t: TestT, id: Id<"purgeBatches">) => t.run((ctx) => ctx.db.get(id));

describe("Betriebsprüfung-Modus (PRV-004, EC-181)", () => {
  test("PRV-004 the hold needs a reason, runs once, ends only with a reason; the worklist shows it", async () => {
    const t = makeT();
    await t.asUser("owner");
    const noReason = await catching(t.model(OWNER, (ctx) => startHold(ctx, { reason: "  ", fiscalYears: [2025] })));
    expect(errorCode(noReason)).toBe("invalid_input");
    expect(messageOf(noReason)).toBe("Bitte geben Sie den Grund an (z. B. Prüfungsanordnung vom …).");
    const notActive = await catching(t.model(OWNER, (ctx) => endHold(ctx, "fertig")));
    expect(errorCode(notActive)).toBe("conflict");
    expect(messageOf(notActive)).toBe("Der Betriebsprüfung-Modus ist nicht aktiv.");

    const id = await t.model(OWNER, (ctx) =>
      startHold(ctx, { reason: " Prüfungsanordnung vom 01.10.2026 ", fiscalYears: [2025, 2023, 2025] }),
    );
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      reason: "Prüfungsanordnung vom 01.10.2026",
      fiscalYears: [2023, 2025],
    });
    const twice = await catching(t.model(OWNER, (ctx) => startHold(ctx, { reason: "noch mal", fiscalYears: [] })));
    expect(messageOf(twice)).toBe("Der Betriebsprüfung-Modus ist bereits aktiv.");
    const w = await t.run((ctx) => retentionWorklist({ ...ctx, now: Date.now }));
    expect(w.hold).toMatchObject({ reason: "Prüfungsanordnung vom 01.10.2026", fiscalYears: [2023, 2025] });
    expect(
      (await t.run((ctx) => purgePreview({ ...ctx, now: Date.now }, { classes: ["books10"], years: [] }))).holdActive,
    ).toBe(true);

    // EC-181: a running batch step stops while the hold is active
    const b = await runningBatch(t);
    const blocked = await catching(t.model(OWNER, (ctx) => purgeStep(ctx, b)));
    expect(errorCode(blocked)).toBe("conflict");
    expect(messageOf(blocked)).toBe(PURGE_MESSAGES.hold);

    expect(messageOf(await catching(t.model(OWNER, (ctx) => endHold(ctx, "   "))))).toBe(
      "Bitte geben Sie den Grund für das Beenden an.",
    );
    await t.model(OWNER, (ctx) => endHold(ctx, "Prüfung abgeschlossen"));
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ endReason: "Prüfung abgeschlossen" });
    expect(await t.model(OWNER, (ctx) => purgeStep(ctx, b))).toEqual({ done: true, processed: 0 });
  });
});

describe("scan, start and steps (PRV-003, PRV-005, E-PRV-05)", () => {
  test("PRV-003 a scan without eligible records is audited but notifies nobody", async () => {
    const t = makeT();
    await t.asUser("owner");
    expect(await t.model({ actor: "system:cron.retention.scan", channel: "cron" }, (ctx) => scanRetention(ctx))).toBe(
      0,
    );
    expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toEqual([]);
    const scan = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).find((e) => e.action === "retention.scan"),
    );
    expect(scan?.diff?.after).toEqual({ eligible: 0, groups: 0 });
  });

  test("E-PRV-05 a purge batch can only be started in the app (API/MCP channel refused)", async () => {
    const t = makeT();
    await t.asUser("owner");
    const err = await catching(
      t.model({ actor: "api-key:abc", channel: "api" }, (ctx) =>
        createPurgeBatch(ctx, { classes: ["vouchers8"], years: [], checklist: CHECKLIST, phrase: PURGE_PHRASE }),
      ),
    );
    expect(errorCode(err)).toBe("forbidden_scope");
    expect(messageOf(err)).toBe(PURGE_MESSAGES.apiForbidden);
    expect(await t.run((ctx) => ctx.db.query("purgeBatches").collect())).toEqual([]);
  });

  test("PRV-005 steps of an unknown or finished batch do nothing; an empty running batch is done at once", async () => {
    const t = makeT();
    await t.asUser("owner");
    expect(await t.model(OWNER, (ctx) => purgeStep(ctx, ghost("purgeBatches")))).toEqual({ done: true, processed: 0 });
    const b = await runningBatch(t);
    expect(await t.model(OWNER, (ctx) => purgeStep(ctx, b))).toEqual({ done: true, processed: 0 });
    expect((await batch(t, b))?.counts).toEqual({}); // nothing purged, no batch update
    await t.model(OWNER, (ctx) => finishPurgeBatch(ctx, b, { ok: true }));
    expect(await t.model(OWNER, (ctx) => purgeStep(ctx, b))).toEqual({ done: true, processed: 0 });
  });

  test("PRV-006 finishing a batch records the off-host log key or the error once; the history lists both", async () => {
    const t = makeT();
    await t.asUser("owner");
    const ok = await runningBatch(t);
    const failed = await runningBatch(t, { ...LOG, batch: { ...LOG.batch, id: "batch-2" } });
    const open = await runningBatch(t, { ...LOG, batch: { ...LOG.batch, id: "batch-3" } });
    await t.model(OWNER, (ctx) => finishPurgeBatch(ctx, ok, { ok: true, offHostLogKey: `purges/${ok}.json` }));
    await t.model(OWNER, (ctx) =>
      finishPurgeBatch(ctx, failed, { ok: false, error: `R2 nicht erreichbar ${"x".repeat(400)}` }),
    );
    await t.model(OWNER, (ctx) => finishPurgeBatch(ctx, failed, { ok: true })); // not running any more: ignored
    expect(await batch(t, ok)).toMatchObject({ status: "done", offHostLogKey: `purges/${ok}.json` });
    expect((await batch(t, failed))?.status).toBe("failed");
    const failEntry = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter(
        (e) => e.action === "retention.batch" && e.entity.id === failed,
      ),
    );
    expect(failEntry.at(-1)?.reason?.length).toBe(300);
    const history = await t.run((ctx) => purgeHistory(ctx));
    expect(history.find((h) => h.id === open)).toMatchObject({
      status: "running",
      offHostLogKey: null,
      finishedAt: null,
      replayOf: "batch-3",
    });
    expect(history.find((h) => h.id === ok)).toMatchObject({ finishedAt: NOW.getTime() });
  });
});

describe("audit-log prefix and anchors (PRV-008)", () => {
  test("PRV-008 no prefix candidate for finished batches, batches without the auditLog class or without expired entries", async () => {
    const t = makeT();
    await t.asUser("owner");
    const withoutClass = await runningBatch(t);
    const withClass = await runningBatch(t, { ...LOG, batch: { ...LOG.batch, id: "b-audit", classes: ["auditLog"] } });
    const read = (id: Id<"purgeBatches">) => t.run((ctx) => auditPrefixCandidate({ ...ctx, now: Date.now }, id));
    expect(await read(ghost("purgeBatches"))).toBeNull();
    expect(await read(withoutClass)).toBeNull();
    expect(await read(withClass)).toBeNull(); // 2026 entries are retained until 2036
    expect(await t.model(OWNER, (ctx) => purgeAuditPrefixStep(ctx, withClass))).toEqual({ done: true, processed: 0 });
  });

  test("PRV-008 an anchor is inserted once per seq with its entry time and export target; nothing behind seq 0 is purged", async () => {
    const t = makeT();
    await t.asUser("owner");
    const b = await runningBatch(t, { ...LOG, batch: { ...LOG.batch, id: "b-audit", classes: ["auditLog"] } });
    const input = {
      batchId: b,
      seq: 0,
      hash: "00".repeat(32),
      jws: "eyJ.test.sig",
      entryAt: 1,
      exportedTo: "r2://anchors/0",
    };
    const first = await t.model(OWNER, (ctx) => insertAnchor(ctx, input));
    expect(await t.model(OWNER, (ctx) => insertAnchor(ctx, { ...input, jws: "anders" }))).toBe(first);
    expect(await t.run((ctx) => ctx.db.get(first))).toMatchObject({
      entryAt: 1,
      exportedTo: "r2://anchors/0",
      jws: "eyJ.test.sig",
    });
    expect(await t.model(OWNER, (ctx) => purgeAuditPrefixStep(ctx, b))).toEqual({ done: true, processed: 0 });
    const log = await t.run((ctx) => purgeLog(ctx, b));
    expect(log?.anchors).toEqual([{ seq: 0, hash: "00".repeat(32), jws: "eyJ.test.sig", entryAt: 1 }]);
    expect(log?.batch.replayOf).toBe("b-audit");
    expect(await t.run((ctx) => purgeLog(ctx, ghost("purgeBatches")))).toBeNull();
  });
});

describe("replay after a restore (PRV-009, E-PRV-08)", () => {
  test("PRV-009 E-PRV-08 the replay skips audit tombstones, unknown and absent records, re-purges what reappeared and anonymises a contact once", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const created = await owner.mutation(api.contacts.create, {
      values: createValues(personForm("Paula", "Prospekt"), { email: "paula@example.test" }),
    });
    const contactId = created.id as Id<"contacts">;
    // a record that "reappeared" from the backup: an activity whose attachment file is already gone
    const lost = await t.run((ctx) => ctx.storage.store(new Blob(["weg"])));
    await t.run((ctx) => ctx.storage.delete(lost));
    const activity = await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "contactActivities",
        {
          contactId,
          kind: "note",
          text: "Notiz",
          attachments: [{ storageId: lost, sha256: "00", bytes: 3, mime: "text/plain", name: "n.txt" }],
          actor: OWNER.actor,
        },
        { action: "contact.activity.create" },
      ),
    );
    const b = await runningBatch(t);
    const ts = (table: string, recordId: string) => ({
      table,
      recordId,
      retentionClass: "books10",
      retentionUntil: "2020-12-31",
      contentSha256: "ab".repeat(32),
      purgedAt: 1,
    });
    const tombstones = [
      ts("auditLog", "1-5"),
      ts("contactActivities", "kaputt"),
      ts("contactActivities", ghost("contactActivities")),
      ts("contactActivities", activity),
      ts("contacts", contactId),
    ];
    const n = await t.model(OWNER, (ctx) => replayChunk(ctx, b, tombstones, []));
    expect(n).toBe(2);
    expect(await t.run((ctx) => ctx.db.get(activity))).toBeNull();
    const c = await t.run((ctx) => ctx.db.get(contactId));
    expect(c).toMatchObject({ displayName: `Gelöschter Kontakt ${c?.number}`, status: "archived" });
    expect((await batch(t, b))?.counts).toEqual({ repurged: 2, checked: 5 });
    // a second replay: the contact is already anonymised, nothing reappeared
    expect(await t.model(OWNER, (ctx) => replayChunk(ctx, b, tombstones, []))).toBe(0);
    expect((await batch(t, b))?.counts).toEqual({ repurged: 2, checked: 10 });
    expect(replayMessage(2)).toBe("2 bereits gelöschte Datensätze aus der Sicherung wurden erneut gelöscht.");
    // the off-host log of the replay batch holds its tombstones
    const log = await t.run((ctx) => purgeLog(ctx, b));
    expect(log?.tombstones.map((x) => x.table).sort()).toEqual(["contactActivities", "contacts"]);
  });

  test("PRV-009 a replayed anchor without entry time is inserted without it and logged without it", async () => {
    const t = makeT();
    await t.asUser("owner");
    const b = await runningBatch(t);
    await t.model(OWNER, (ctx) => replayChunk(ctx, b, [], [{ seq: 0, hash: "11".repeat(32), jws: "a.b.c" }]));
    const anchors = await t.run((ctx) => ctx.db.query("chainAnchors").collect());
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ seq: 0, purgeBatchId: b });
    expect(anchors[0]?.entryAt).toBeUndefined();
    expect(anchors[0]?.exportedTo).toBeUndefined();
    expect((await t.run((ctx) => purgeLog(ctx, b)))?.anchors).toEqual([
      { seq: 0, hash: "11".repeat(32), jws: "a.b.c" },
    ]);
  });
});
