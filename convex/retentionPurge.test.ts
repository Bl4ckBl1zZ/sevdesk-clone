import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ABLAUFHEMMUNG_ITEMS, PURGE_PHRASE } from "../src/domain/privacy/purge";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice, settle } from "./invoices.fixtures";
import { memoryCheckpointObjects } from "./lib/checkpointStore";
import { loadCheckpointKey, verifyCheckpoint } from "./lib/jws";
import { makeT } from "./test.setup";

/** F12 PRV-003…PRV-009, GOBD-21, RI-20, EC-181: retention scan, Betriebsprüfung-Modus, purge job, prefix purge, replay. */

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}
const CHECKLIST = Object.fromEntries(ABLAUFHEMMUNG_ITEMS.map((i) => [i.id, true]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
  memoryCheckpointObjects.clear();
});
afterEach(() => {
  vi.useRealTimers();
  memoryCheckpointObjects.clear();
});

type T = ReturnType<typeof makeT>;
/** A fresh session for the owner after time travel (sessions expire; the purge needs a fresh one). */
async function ownerLater(t: T, userId: string, at: string) {
  vi.setSystemTime(new Date(at));
  return t.asUser("owner", { existingUserId: userId });
}

describe("purge job (PRV-002, PRV-005, PRV-006, PRV-007, GOBD-21)", { timeout: 60_000 }, () => {
  test("PRV-002 PRV-005 PRV-006 E-PRV-01 E-PRV-03 E-PRV-04 E-PRV-06 GOBD-21 RI-20 a 2026 invoice is refused until 2034-12-31, then purged with tombstones; the journal (10 y) stays", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const docId = f.id as Id<"salesDocuments">;
    const artifacts = await t.run((ctx) =>
      ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", docId))
        .collect(),
    );
    expect(artifacts.length).toBeGreaterThan(0);

    // before the retention ended: nothing is eligible
    const early = await f.owner.query(api.retention.preview, { classes: ["vouchers8"], years: [] });
    expect(early.total).toBe(0);
    const refused = await catching(
      f.owner.mutation(api.retention.startPurge, {
        classes: ["vouchers8"],
        years: [],
        checklist: CHECKLIST,
        phrase: PURGE_PHRASE,
      }),
    );
    expect(dataOf(refused).message).toBe("Für die Auswahl gibt es keine löschbaren Datensätze.");

    const owner = await ownerLater(t, f.owner.userId, "2035-01-02T10:00:00Z");
    const preview = await owner.query(api.retention.preview, { classes: ["vouchers8"], years: [2034] });
    expect(preview.counts.salesDocuments).toBe(1);
    expect(preview.files).toBeGreaterThan(0);
    expect(preview.examples[0]).toMatchObject({
      table: "salesDocuments",
      label: f.number,
      retentionUntil: "2034-12-31",
    });

    const partial = { ...CHECKLIST, einspruch: false };
    expect(
      dataOf(
        await catching(
          owner.mutation(api.retention.startPurge, {
            classes: ["vouchers8"],
            years: [],
            checklist: partial,
            phrase: PURGE_PHRASE,
          }),
        ),
      ).message,
    ).toBe("Bitte bestätigen Sie alle Punkte zur Ablaufhemmung (§ 147 Abs. 3 Satz 5 AO).");
    expect(
      dataOf(
        await catching(
          owner.mutation(api.retention.startPurge, {
            classes: ["vouchers8"],
            years: [],
            checklist: CHECKLIST,
            phrase: "löschen",
          }),
        ),
      ).message,
    ).toBe("Bitte geben Sie „ENDGÜLTIG LÖSCHEN“ ein.");

    const { batchId } = await owner.mutation(api.retention.startPurge, {
      classes: ["vouchers8"],
      years: [],
      checklist: CHECKLIST,
      phrase: PURGE_PHRASE,
    });
    await settle(t);
    expect(await t.run((ctx) => ctx.db.get(docId))).toBeNull();
    for (const a of artifacts) expect(await t.run((ctx) => ctx.storage.get(a.storageId))).toBeNull();
    const tombstones = await t.run((ctx) =>
      ctx.db
        .query("purgeTombstones")
        .withIndex("by_batch", (q) => q.eq("batchId", batchId))
        .collect(),
    );
    const tables = new Set(tombstones.map((x) => x.table));
    for (const table of ["salesDocuments", "documentLines", "documentSnapshots", "documentArtifacts"])
      expect(tables).toContain(table);
    expect(tombstones.every((x) => x.retentionUntil === "2034-12-31" && /^[0-9a-f]{64}$/.test(x.contentSha256))).toBe(
      true,
    );

    // E-PRV-06: the journal entry of the invoice (books10 → 2036-12-31) stays
    const journal = await t.run((ctx) =>
      ctx.db
        .query("journalEntries")
        .withIndex("by_source", (q) => q.eq("source.kind", "salesDocument").eq("source.id", docId))
        .collect(),
    );
    expect(journal.length).toBe(1);

    const batch = await t.run((ctx) => ctx.db.get(batchId));
    expect(batch).toMatchObject({ status: "done", actor: owner.actor });
    expect(batch?.offHostLogKey).toBe(`memory://test-checkpoints/purges/${batchId}.json`);
    const log = JSON.parse(memoryCheckpointObjects.get(`purges/${batchId}.json`) ?? "{}");
    expect(log.format).toBe("rechnungen-purge-log/1");
    expect(log.tombstones.length).toBe(tombstones.length);
    expect(JSON.parse(memoryCheckpointObjects.get("purges/index.json") ?? "[]")).toEqual([`purges/${batchId}.json`]);

    // PRV-006: the purge audit entries carry ids, counts and hashes only — no content of the purged invoice
    const entries = await t.run((ctx) => ctx.db.query("auditLog").collect());
    const purgeEntries = entries.filter((e) => e.action.startsWith("retention."));
    expect(purgeEntries.length).toBeGreaterThan(0);
    expect(purgeEntries.every((e) => e.actor === owner.actor)).toBe(true);
    expect(JSON.stringify(purgeEntries)).not.toContain(f.number ?? "∅");
  });

  test("PRV-004 EC-181 E-PRV-02 while the Betriebsprüfung-Modus is active no purge can start", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const owner = await ownerLater(t, f.owner.userId, "2035-01-02T10:00:00Z");
    await owner.mutation(api.retention.startHoldMode, {
      reason: "Prüfungsanordnung vom 02.01.2035",
      fiscalYears: [2026],
    });
    const w = await owner.query(api.retention.worklist, {});
    expect(w.hold).toMatchObject({ fiscalYears: [2026] });
    const err = await catching(
      owner.mutation(api.retention.startPurge, {
        classes: ["vouchers8"],
        years: [],
        checklist: CHECKLIST,
        phrase: PURGE_PHRASE,
      }),
    );
    expect(dataOf(err).message).toBe("Während einer Betriebsprüfung sind Löschungen gesperrt.");
    await owner.mutation(api.retention.endHoldMode, { reason: "Prüfung abgeschlossen" });
    await owner.mutation(api.retention.startPurge, {
      classes: ["vouchers8"],
      years: [],
      checklist: CHECKLIST,
      phrase: PURGE_PHRASE,
    });
    await settle(t);
    expect(await t.run((ctx) => ctx.db.get(f.id as Id<"salesDocuments">))).toBeNull();
  });

  test("E-PRV-05 a purge via REST/MCP or by the bookkeeper is refused (never grantable)", async () => {
    const t = makeT();
    await t.asUser("owner");
    const key = await t.asApiKey(["settings:write", "settings:read"]);
    const args = { classes: ["vouchers8" as const], years: [], checklist: CHECKLIST, phrase: PURGE_PHRASE };
    expect(dataOf(await catching(key.mutation(api.retention.startPurge, args))).code).toBe("forbidden_scope");
    const mcp = await t.asMcp(["settings:write"]);
    expect(dataOf(await catching(mcp.mutation(api.retention.startPurge, args))).code).toBe("forbidden_scope");
    const bk = await t.asUser("bookkeeper");
    expect(dataOf(await catching(bk.mutation(api.retention.startPurge, args))).code).toBe("forbidden_role");
  });

  test("PRV-003 the monthly scan lists eligible records and notifies, but purges nothing", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    vi.setSystemTime(new Date("2035-02-01T06:00:00Z"));
    const n = await t.mutation(internal.retention.scanCron, { force: true });
    expect(n).toBeGreaterThan(0);
    expect(await t.run((ctx) => ctx.db.get(f.id as Id<"salesDocuments">))).not.toBeNull();
    const ntf = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(ntf.find((x) => x.kind === "retention.purge_eligible")?.title).toBe(
      `${n} Datensätze können gelöscht werden`,
    );
    const owner = await t.asUser("owner", { existingUserId: f.owner.userId });
    const w = await owner.query(api.retention.worklist, {});
    expect(w.groups).toContainEqual(expect.objectContaining({ retentionClass: "vouchers8", year: 2034 }));
  });
});

describe("audit-log prefix purge (PRV-008) and replay (PRV-009)", { timeout: 60_000 }, () => {
  test("PRV-008 E-PRV-07 RI-14 the expired prefix is purged behind a signed, uploaded anchor; the chain verifies from it", async () => {
    const t = makeT();
    const owner0 = (await finalizedInvoice(t)).owner;
    const before = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    const owner = await ownerLater(t, owner0.userId, "2037-01-02T10:00:00Z");
    const { batchId } = await owner.mutation(api.retention.startPurge, {
      classes: ["auditLog"],
      years: [],
      checklist: CHECKLIST,
      phrase: PURGE_PHRASE,
    });
    await settle(t);
    const anchor = await t.run((ctx) => ctx.db.query("chainAnchors").first());
    expect(anchor).toMatchObject({ seq: before?.seq, hash: before?.hash, purgeBatchId: batchId });
    expect(memoryCheckpointObjects.get(`anchors/${anchor?.seq}.jws`)).toBe(anchor?.jws);
    const key = await loadCheckpointKey(process.env.CHECKPOINT_SIGNING_KEY_PEM as string);
    const verified = await verifyCheckpoint(anchor?.jws as string, key.publicJwk);
    expect(verified.ok).toBe(true);
    const remaining = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").collect());
    expect(remaining[0]?.seq).toBe((before?.seq ?? 0) + 1); // never cuts the 2037 entries (E-PRV-07)
    const res = await t.action(internal.integrity.verify, { scope: "full" });
    expect(res.findings.filter((x) => x.severity === "error")).toEqual([]);
  });

  test("PRV-009 E-PRV-08 after a restore the off-host purge log re-purges records that reappeared", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const docId = f.id as Id<"salesDocuments">;
    vi.setSystemTime(new Date("2035-01-02T10:00:00Z"));
    // The restored backup still holds the invoice, while the off-host log of an earlier purge lists it.
    const rows = await t.run(async (ctx) => [
      { table: "salesDocuments", id: docId as string },
      ...(
        await ctx.db
          .query("documentLines")
          .withIndex("by_document", (q) => q.eq("documentId", docId))
          .collect()
      ).map((r) => ({ table: "documentLines", id: r._id as string })),
      ...(
        await ctx.db
          .query("documentSnapshots")
          .withIndex("by_document", (q) => q.eq("documentId", docId))
          .collect()
      ).map((r) => ({ table: "documentSnapshots", id: r._id as string })),
      ...(
        await ctx.db
          .query("documentArtifacts")
          .withIndex("by_document", (q) => q.eq("documentId", docId))
          .collect()
      ).map((r) => ({ table: "documentArtifacts", id: r._id as string })),
      ...(
        await ctx.db
          .query("sendLog")
          .withIndex("by_document_at", (q) => q.eq("documentId", docId))
          .collect()
      ).map((r) => ({ table: "sendLog", id: r._id as string })),
    ]);
    memoryCheckpointObjects.set("purges/index.json", JSON.stringify(["purges/old.json"]));
    memoryCheckpointObjects.set(
      "purges/old.json",
      JSON.stringify({
        format: "rechnungen-purge-log/1",
        batch: {
          id: "old",
          createdAt: Date.now(),
          actor: f.owner.actor,
          classes: ["vouchers8"],
          years: [],
          checklist: CHECKLIST,
        },
        tombstones: rows.map((r) => ({
          table: r.table,
          recordId: r.id,
          retentionClass: "vouchers8",
          retentionUntil: "2034-12-31",
          contentSha256: "0".repeat(64),
          purgedAt: Date.now(),
        })),
        anchors: [],
      }),
    );
    const out = await t.action(internal.retention.replayPurges, {});
    expect(out).toMatchObject({
      batches: 1,
      repurged: rows.length,
      message: `${rows.length} bereits gelöschte Datensätze aus der Sicherung wurden erneut gelöscht.`,
    });
    expect(await t.run((ctx) => ctx.db.get(docId))).toBeNull();
    const replay = await t.run((ctx) => ctx.db.query("purgeBatches").collect());
    expect(replay[0]).toMatchObject({ replayOf: "old", status: "done" });
  });
});
