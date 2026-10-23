import { describe, expect, test } from "vitest";
import { clearInvariantTarget } from "../test/invariants";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { finalizedInvoice } from "./invoices.fixtures";
import { appendAudit } from "./model/audit";
import { type InvariantPage, type InvariantState, replayEntity } from "./model/invariants";
import { makeT, type TestT } from "./test.setup";

/**
 * Branches of the regulatory invariants (10-edge-cases §2) that only tampered or unusual data reaches: RI-15 replay,
 * RI-20 tombstones and audited deletions, RI-14 checkpoint, RI-01 artifact files, and the paged evaluation with
 * arbitrary budgets (AUD-013).
 */

const entry = (seq: number, action: string, diff?: { before?: unknown; after?: unknown }) =>
  ({ seq, action, ...(diff ? { diff } : {}) }) as unknown as Doc<"auditLog">;

const check = (t: TestT) => t.query(internal.invariants.check, {});
const messages = async (t: TestT, id: string) => (await check(t)).filter((v) => v.id === id).map((v) => v.message);

async function purgeBatch(t: TestT) {
  return t.run((ctx) =>
    ctx.db.insert("purgeBatches", {
      createdAt: Date.now(),
      actor: "system:cron.retention.purge",
      classes: ["10y"],
      years: [2015],
      checklist: {},
      status: "done",
      counts: {},
    }),
  );
}

describe("RI-15 replay of audit diffs (replayEntity)", () => {
  test("RI-15 entries without a diff are skipped; a create, an update removing a field and a delete replay in order", () => {
    expect(replayEntity([entry(1, "x.note")])).toBeNull();
    const created = entry(1, "unit.create", { after: { a: 1, b: 2 } });
    const updated = entry(2, "unit.update", { before: { a: 1, b: 2 }, after: { a: 3 } });
    expect(replayEntity([created, entry(2, "x.note"), updated])).toEqual({ a: 3 });
    const deleted = entry(3, "unit.delete", { before: { a: 3 } });
    expect(replayEntity([created, updated, deleted])).toBeNull();
    // purge counts as a deletion too
    expect(replayEntity([created, entry(2, "retention.purge", { before: { a: 1 } })])).toBeNull();
  });

  test("RI-15 a before-only entry that is no deletion keeps the state; a before-only entry on nothing stays nothing", () => {
    const created = entry(1, "unit.create", { after: { a: 1 } });
    expect(replayEntity([created, entry(2, "unit.archive", { before: { a: 1 } })])).toEqual({ a: 1 });
    expect(replayEntity([entry(1, "unit.delete", { before: { a: 1 } })])).toBeNull();
    // an update without a preceding create starts from an empty state
    expect(replayEntity([entry(1, "unit.update", { before: { a: 1 }, after: { b: 2 } })])).toEqual({ b: 2 });
  });
});

describe("RI-20 purge tombstones (F12 PRV-006)", () => {
  test("RI-20 a tombstone written before its retention ended is reported, and a journal tombstone keeps its seq", async () => {
    const t = makeT();
    await t.asUser("owner");
    const batchId = await purgeBatch(t);
    await t.run((ctx) =>
      ctx.db.insert("purgeTombstones", {
        table: "journalEntries",
        recordId: "not-an-id",
        retentionClass: "10y",
        retentionUntil: "2099-12-31",
        contentSha256: "0".repeat(64),
        batchId,
        purgedAt: Date.now(),
        seq: 7,
      }),
    );
    clearInvariantTarget(); // tampered on purpose
    expect(await messages(t, "RI-20")).toEqual([
      "journalEntries/not-an-id wurde vor Ablauf der Aufbewahrungsfrist (2099-12-31) gelöscht.",
    ]);
  });

  test("RI-20 a purged contact whose key was not shredded and a purged record that still exists are reported", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.invites.create, { email: "b@example.test", role: "viewer" });
    const batchId = await purgeBatch(t);
    const inviteId = await t.run(async (ctx) => {
      const invite = await ctx.db.query("invites").first();
      if (!invite) throw new Error("no invite");
      return invite._id;
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("contactKeys", { contactId: "contact-1", wrappedKey: "k", createdAt: Date.now() });
      const base = {
        retentionClass: "10y",
        retentionUntil: "2000-12-31",
        contentSha256: "0".repeat(64),
        batchId,
        purgedAt: Date.now(),
      };
      await ctx.db.insert("purgeTombstones", { ...base, table: "contacts", recordId: "contact-1" });
      await ctx.db.insert("purgeTombstones", { ...base, table: "invites", recordId: String(inviteId) });
      await ctx.db.insert("purgeTombstones", { ...base, table: "auditLog", recordId: "1" });
    });
    clearInvariantTarget(); // tampered on purpose
    expect(await messages(t, "RI-20")).toEqual([
      "contacts/contact-1: Schlüssel nach Löschung nicht vernichtet.",
      `invites/${inviteId} besteht trotz Löschvermerk.`,
    ]);
  });

  test("RI-20 PRV-002 an audited deletion of a record still within retention is reported with its seq", async () => {
    const t = makeT();
    await t.asUser("owner");
    const seq = await t.asSystem("migration").model(async (ctx) => {
      const e = await appendAudit(ctx, {
        action: "document.delete_draft",
        entity: { table: "salesDocuments", id: "gone" },
        diff: { before: { retentionUntil: "2099-12-31" } },
      });
      return e.seq;
    });
    clearInvariantTarget(); // the reported deletion stays in the log
    expect(await messages(t, "RI-20")).toEqual([
      `salesDocuments/gone wurde vor Ablauf der Aufbewahrungsfrist (2099-12-31) gelöscht (seq ${seq}).`,
    ]);
  });
});

describe("RI-14 / RI-15 checkpoint and profile versions", () => {
  test("RI-14 a checkpoint whose hash the chain does not contain is reported", async () => {
    const t = makeT();
    await t.asUser("owner");
    await t.run((ctx) =>
      ctx.db.insert("integrityCheckpoints", {
        date: "2026-10-22",
        lastSeq: 1,
        lastHash: "f".repeat(64),
        counts: {},
        artifactsCount: 0,
        journalSeq: 0,
        appVersion: "test",
        schemaVersion: "1",
        prevCheckpointHash: "",
        jws: "x",
        kid: "k",
        uploadStatus: "pending",
        at: Date.now(),
      }),
    );
    clearInvariantTarget(); // tampered on purpose
    expect(await messages(t, "RI-14")).toEqual(["Kette enthält den Prüfpunkt vom 2026-10-22 (seq 1) nicht."]);
  });

  test("RI-15 a company profile version without its companyProfile audit entry is reported", async () => {
    const t = makeT();
    await t.asUser("owner");
    const id = await t.run((ctx) =>
      ctx.db.insert("companyProfileVersions", {
        version: 99,
        profile: "{}",
        diff: {},
        validFrom: Date.now(),
        actor: "system:migration.x",
        auditSeq: 1,
      }),
    );
    clearInvariantTarget(); // tampered on purpose
    expect(await messages(t, "RI-15")).toContain(
      `companyProfileVersions/${id} (Version 99) ohne passenden Protokolleintrag.`,
    );
  });
});

describe("RI-01 archived artifact files (GOBD-06)", () => {
  test("RI-01 a finalised invoice whose archived file is gone or altered is reported", async () => {
    const t = makeT();
    const { id, number } = await finalizedInvoice(t);
    const artifacts = await t.run((ctx) =>
      ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect(),
    );
    expect(artifacts.length).toBeGreaterThan(0);
    expect(await messages(t, "RI-01")).toEqual([]);
    const first = artifacts[0] as Doc<"documentArtifacts">;
    await t.run((ctx) => ctx.storage.delete(first.storageId)); // out-of-band
    clearInvariantTarget(); // tampered on purpose
    const found = await messages(t, "RI-01");
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((m) => m.startsWith(`${number}:`))).toBe(true);
  });
});

describe("paged evaluation with arbitrary budgets (AUD-013)", () => {
  test("AUD-013 every small call budget reports exactly what the single transaction reports", async () => {
    const t = makeT();
    const { owner } = await finalizedInvoice(t);
    await owner.mutation(api.invites.create, { email: "b@example.test", role: "viewer" });
    const single = await check(t);
    for (const calls of [2, 3, 5, 9, 17]) {
      const pages: InvariantPage[] = [];
      let state: InvariantState | null = null;
      for (;;) {
        const page: InvariantPage = await t.query(internal.invariants.page, {
          ...(state ? { state } : {}),
          budget: { calls },
        });
        pages.push(page);
        if (page.done) break;
        state = page.state;
      }
      expect(pages.length).toBeGreaterThan(1);
      expect(await t.action(internal.invariants.run, { budget: { calls } })).toEqual(single);
    }
  });
});
