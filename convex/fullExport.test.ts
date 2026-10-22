import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import { verifyManifest } from "../src/domain/exports/full-export";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice, settle } from "./invoices.fixtures";
import { checkpointKey, memoryCheckpointObjects } from "./lib/checkpointStore";
import { appendAudit } from "./model/audit";
import { makeT } from "./test.setup";

/** F09 EXP-023 Vollexport job and EXP-024 restore checks (E-EXP-38…41). */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  memoryCheckpointObjects.clear();
});
afterEach(() => {
  vi.useRealTimers();
  memoryCheckpointObjects.clear();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b ?? new Uint8Array());

describe("EXP-023 Vollexport", { timeout: 60_000 }, () => {
  test("E-EXP-37 the manifest head is the chain head when the job read it; the job's own progress entries are not „writes during the export“; others' are", async () => {
    const t = makeT();
    const { owner } = await finalizedInvoice(t);
    const { jobId } = await owner.mutation(api.fullExport.start, {});
    const headBefore = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    await settle(t);
    const job = await t.run((ctx) => ctx.db.get(jobId as Id<"jobs">));
    const buf = await t.run(async (ctx) =>
      (await ctx.storage.get(job?.resultStorageId as Id<"_storage">))?.arrayBuffer(),
    );
    const zip = unzipSync(new Uint8Array(buf as ArrayBuffer));
    const manifest = JSON.parse(text(zip["manifest.json"]));
    expect(manifest.auditHead).toEqual({ seq: headBefore?.seq, hash: headBefore?.hash });
    // the export's own job.start/job.progress entries follow the head but are not foreign writes
    const ownAfter = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((e) => e.seq > (headBefore?.seq ?? 0) && e.entity.id === jobId),
    );
    expect(ownAfter.length).toBeGreaterThan(0);
    expect(manifest.writesDuringExport).toBeNull();
    expect(text(zip["README.txt"])).not.toContain("Während des Exports");

    // a write by someone else after the head is reported, the job's own entries are not
    const head = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    await t.model({ actor: "user:test-owner", role: "owner", channel: "ui" } as const, async (ctx) => {
      await appendAudit(ctx, { action: "settings.company.update", entity: { table: "companyProfile", id: "x" } });
      await appendAudit(ctx, { action: "job.progress", entity: { table: "jobs", id: jobId } });
    });
    const seqs = await t.query(internal.fullExport.writesSince, {
      jobId: jobId as Id<"jobs">,
      afterSeq: head?.seq ?? 0,
    });
    expect(seqs).toEqual([(head?.seq ?? 0) + 1]);
  });

  test("EXP-023 the full export ZIP has every table as NDJSON, every stored file by hash, manifest, sums and README (ohne convex-snapshot.zip, siehe Runbook)", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const bookkeeper = await t.asUser("bookkeeper");
    expect(dataOf(await catching(bookkeeper.mutation(api.fullExport.start, {}))).code).toBe("forbidden_role");

    const { jobId } = await owner.mutation(api.fullExport.start, {});
    await settle(t);
    const job = await t.run((ctx) => ctx.db.get(jobId as Id<"jobs">));
    expect(job).toMatchObject({ kind: "full_export", status: "done", label: "Vollexport" });
    const buf = await t.run(async (ctx) =>
      (await ctx.storage.get(job?.resultStorageId as Id<"_storage">))?.arrayBuffer(),
    );
    const zip = unzipSync(new Uint8Array(buf as ArrayBuffer));
    expect(await sha256Hex(new Uint8Array(buf as ArrayBuffer))).toBe(job?.resultSha256);

    const manifest = JSON.parse(text(zip["manifest.json"]));
    const head = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    expect(manifest.snapshot.included).toBe(false);
    expect(manifest.auditHead.seq).toBeLessThanOrEqual(head?.seq ?? 0);
    expect(manifest.tables.salesDocuments).toBeGreaterThanOrEqual(1);
    const docs = text(zip["tables/salesDocuments.ndjson"])
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(docs.map((d) => d._id)).toContain(id);
    expect(Object.keys(zip).some((k) => k.startsWith("tables/auditLog"))).toBe(true);

    const artifacts = await t.run((ctx) => ctx.db.query("documentArtifacts").collect());
    expect(artifacts.length).toBeGreaterThan(0);
    for (const a of artifacts) {
      const entry = Object.keys(zip).find((k) => k.startsWith(`files/${a.sha256}`));
      expect(entry, a.kind).toBeDefined();
    }
    expect(text(zip["files/index.csv"])).toContain("Speicher-ID");

    const actual = new Map<string, string>();
    for (const [path, bytes] of Object.entries(zip)) actual.set(path, await sha256Hex(bytes));
    expect(verifyManifest(manifest, actual)).toBeNull();
    expect(text(zip["SHA256SUMS.txt"])).toContain("tables/salesDocuments.ndjson");
    expect(text(zip["README.txt"])).toContain("Vollexport");

    // A second Vollexport does not embed the first one (job results are not data).
    const second = await owner.mutation(api.fullExport.start, {});
    await settle(t);
    const job2 = await t.run((ctx) => ctx.db.get(second.jobId as Id<"jobs">));
    const buf2 = await t.run(async (ctx) =>
      (await ctx.storage.get(job2?.resultStorageId as Id<"_storage">))?.arrayBuffer(),
    );
    const manifest2 = JSON.parse(text(unzipSync(new Uint8Array(buf2 as ArrayBuffer))["manifest.json"]));
    expect(manifest2.files.some((f: { path: string }) => f.path.startsWith(`files/${job?.resultSha256}`))).toBe(false);

    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.filter((a) => a.action === "export.full")).toHaveLength(2);
    expect(audit.filter((a) => a.action === "export.full").slice(0, 1)).toEqual([
      expect.objectContaining({
        actor: owner.actor,
        diff: expect.objectContaining({ after: expect.objectContaining({ sha256: job?.resultSha256 }) }),
      }),
    ]);
  });
});

describe("EXP-024 restore checks", { timeout: 60_000 }, () => {
  test("EXP-024 E-EXP-38 preflight accepts only an empty instance", async () => {
    const t = makeT();
    expect(await t.query(internal.restore.preflight, {})).toEqual({ ok: true });
    await finalizedInvoice(t);
    expect(await t.query(internal.restore.preflight, {})).toEqual({
      ok: false,
      error: "Wiederherstellung ist nur in eine leere Instanz möglich.",
    });
  });

  test("EXP-024 E-EXP-40 a head that differs from the manifest blocks and raises the integrity alert", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    const { head } = await t.query(internal.restore.headState, {});
    const r = await t.action(internal.restore.complete, {
      source: "vollexport.zip",
      expected: { seq: head?.seq ?? 0, hash: "0".repeat(64) },
    });
    expect(r).toEqual({
      ok: false,
      error: `Prüfkette nach Wiederherstellung weicht ab (seq ${head?.seq}). Bitte nicht weiterarbeiten.`,
    });
    const run = await t.run((ctx) => ctx.db.query("integrityRuns").order("desc").first());
    expect(run).toMatchObject({ ok: false });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((a) => a.action === "system.restore")).toBe(false);
  });

  test("EXP-024 E-EXP-41 EC-183 E-AUD-14 the restore is the first audit entry after the imported head; a newer off-host checkpoint warns", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    const { head } = await t.query(internal.restore.headState, {});
    const payload = btoa(JSON.stringify({ date: "2026-10-12", lastSeq: (head?.seq ?? 0) + 5, lastHash: "h" }));
    memoryCheckpointObjects.set(checkpointKey("2026-10-12"), `eyJhbGciOiJFUzI1NiJ9.${payload.replace(/=+$/, "")}.sig`);
    const r = await t.action(internal.restore.complete, {
      source: "convex-export/2026-10-12.zip",
      expected: { seq: head?.seq ?? 0, hash: head?.hash ?? "" },
    });
    expect(r).toMatchObject({ ok: true, head: { seq: head?.seq } });
    expect((r as { warnings: string[] }).warnings[0]).toMatch(
      /^Die Sicherung ist älter als der letzte Prüfpunkt \(12\.10\.2026\)\. Daten nach .+ fehlen und müssen nacherfasst werden\.$/,
    );
    const after = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_seq", (q) => q.gt("seq", head?.seq ?? 0))
        .collect(),
    );
    expect(after.map((a) => a.action)).toEqual(["system.restore", "integrity.run"]);
    expect(after[0]?.actor).toBe("system:system.restore");
    const run = await t.run((ctx) => ctx.db.query("integrityRuns").order("desc").first());
    expect(run).toMatchObject({ ok: true });
  });
});
