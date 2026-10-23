import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearInvariantTarget } from "../test/invariants";
import { api, internal } from "./_generated/api";
import { b2bBuyer, finalizedInvoice, invoiceValues, setupInvoicing } from "./invoices.fixtures";
import { memoryCheckpointObjects, memoryFailures } from "./lib/checkpointStore";
import { makeT } from "./test.setup";

/** F12 §5.1 edge cases of the integrity run that span several modules (E-AUD-03 …). */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  memoryCheckpointObjects.clear();
  memoryFailures.remaining = 0;
  clearInvariantTarget();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const codes = (e: unknown) => ((dataOf(e).findings ?? []) as { code: string }[]).map((f) => f.code);

describe("artifact re-hash (E-AUD-08, AUD-013 c)", () => {
  test("E-AUD-08 an archived file whose bytes changed is a critical finding naming the file and the document", async () => {
    const t = makeT();
    const { number } = await finalizedInvoice(t);
    expect((await t.action(internal.integrity.verify, {})).ok).toBe(true);
    const pdf = await t.run(async (ctx) =>
      (await ctx.db.query("documentArtifacts").collect()).find((a) => a.documentId !== undefined),
    );
    if (!pdf) throw new Error("no artifact");
    // the stored file is swapped behind the app's back (same row, other bytes)
    await t.run(async (ctx) => {
      const other = await ctx.storage.store(new Blob(["%PDF-1.7 manipuliert"], { type: "application/pdf" }));
      await ctx.db.patch(pdf._id, { storageId: other });
    });
    const res = await t.action(internal.integrity.verify, {});
    expect(res.ok).toBe(false);
    expect(res.findings).toEqual([
      expect.objectContaining({
        kind: "file_hash_mismatch",
        severity: "error",
        detail: `Archivdatei ${pdf.name} (${number}) stimmt nicht mehr mit dem gespeicherten Hash überein.`,
        entity: { table: "documentArtifacts", id: pdf._id },
      }),
    ]);
    expect((await (await t.asUser("owner")).query(api.integrity.status, {})).finalisationBlocked).toBe(true);
  });

  test("E-AUD-08 incremental runs check artifacts created since the last run and a sample; full runs check all", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    const run = async (since: number | "all", sample: boolean) =>
      t.action(internal.integrity.rehashArtifactsForTest, { since, sample });
    await t.run(async (ctx) => {
      const a = (await ctx.db.query("documentArtifacts").collect())[0];
      if (!a) throw new Error("no artifact");
      await ctx.storage.delete(a.storageId);
    });
    expect((await run("all", false)).map((f) => f.detail)).toEqual([
      expect.stringMatching(/^Archivdatei .+ fehlt im Speicher\.$/),
    ]);
    expect(await run(Date.now() + 1, false)).toEqual([]); // nothing new, not sampled
    expect(await run(Date.now() + 1, true)).toHaveLength(1); // sampled
    expect(await run(0, false)).toHaveLength(1); // created since the last run
  });
});

describe("restore drill (E-AUD-15, AUD-027)", () => {
  test("E-AUD-15 a drill whose chain head does not match the production checkpoint is recorded as failed and notifies", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.system.recordRestoreDrill, {
      date: "2026-10-12",
      backupObject: "postgres/2026-10-11.dump.zst",
      targetEnvironment: "Testinstanz lokal",
      integrityOk: true,
      headMatchesCheckpoint: false,
      notes: "Kopf seq 812, Prüfpunkt seq 815",
    });
    const overview = await owner.query(api.system.overview, {});
    expect(overview.drills).toEqual([expect.objectContaining({ date: "2026-10-12", headMatchesCheckpoint: false })]);
    // a failed drill does not count as the monthly drill: the reminder stays due
    expect(overview.restoreDrill.due).toBe(true);
    const n = (await t.run((ctx) => ctx.db.query("notifications").collect())).find(
      (x) => x.kind === "restore_drill.failed",
    );
    expect(n).toMatchObject({
      severity: "error",
      title: "Wiederherstellungstest fehlgeschlagen: Prüfkette stimmt nicht überein.",
      link: "/einstellungen/system/backups",
    });

    // a later successful drill resolves the notification and resets the reminder
    await owner.mutation(api.system.recordRestoreDrill, {
      date: "2026-10-12",
      backupObject: "postgres/2026-10-12.dump.zst",
      targetEnvironment: "Testinstanz lokal",
      integrityOk: true,
      headMatchesCheckpoint: true,
    });
    expect((await owner.query(api.system.overview, {})).restoreDrill.due).toBe(false);
    const after = (await t.run((ctx) => ctx.db.query("notifications").collect())).find(
      (x) => x.kind === "restore_drill.failed",
    );
    expect(after?.resolvedAt).toBeDefined();
  });
});

describe("out-of-band edits (E-AUD-03, EC-182)", () => {
  test("E-AUD-03 an edit via the admin key bypasses the triggers but the next run reports it, blocks finalising until the owner acknowledges", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });

    // the Convex dashboard / admin key writes straight to the table (no wrapper, no trigger, no audit entry)
    const seq = await t.run(async (ctx) => {
      const e = await ctx.db
        .query("auditLog")
        .withIndex("by_seq", (q) => q.eq("seq", 3))
        .first();
      if (!e) throw new Error("no entry");
      await ctx.db.patch(e._id, { reason: "nachträglich geändert" });
      return e.seq;
    });

    const run = await t.action(internal.integrity.verify, {});
    expect(run.ok).toBe(false);
    expect(run.findings[0]).toMatchObject({ severity: "error", firstBrokenSeq: seq });
    const status = await owner.query(api.integrity.status, {});
    expect(status.finalisationBlocked).toBe(true);
    const n = await t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect()).find((x) => x.kind === "integrity.failed"),
    );
    expect(n).toMatchObject({
      severity: "critical",
      body: `Protokolleintrag seq ${seq} wurde verändert oder beschädigt.`,
    });

    const blocked = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x: unknown) => x);
    expect(codes(blocked)).toContain("integrity_alert_open");

    if (!status.lastRun) throw new Error("no run");
    await owner.mutation(api.integrity.acknowledge, {
      runId: status.lastRun.id,
      note: "Änderung über das Convex-Dashboard, Ursache dokumentiert",
    });
    // acknowledging does not alter data: the finding stays, only the block is lifted
    expect((await owner.query(api.integrity.status, {})).finalisationBlocked).toBe(false);
    const done = await owner.action(api.invoices.finalize, { id, version: 1 });
    expect(done.number).toEqual(expect.any(String));
    expect((await t.action(internal.integrity.verify, {})).ok).toBe(false);
  });
});
