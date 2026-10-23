import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { b2bBuyer, consumerBuyer, finalizedInvoice, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";

/**
 * 10-edge-cases §3.1 numbering and finalisation edge cases in Convex (EC-001, EC-004, EC-006, EC-007, EC-010, EC-013,
 * EC-100). The invoice is the T-GLD-01 draft (GmbH seller, B2B buyer, ZUGFeRD).
 */

const NOW = new Date("2026-10-12T10:00:00Z");
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const doc = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => {
    const d = await ctx.db.get(id);
    if (!d) throw new Error("missing");
    return d;
  });
const invoiceRegister = (t: TestT) =>
  t.run(async (ctx) => (await ctx.db.query("numberRegister").collect()).filter((r) => r.docType === "invoice"));
const auditOf = (t: TestT, table: string, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query("auditLog")
      .withIndex("by_entity", (q) => q.eq("entity.table", table).eq("entity.id", id))
      .collect(),
  );
const KOSIT_OK = { acceptable: true, validatorVersion: "1.6.3", configVersion: "3.0.2" };

describe("EC-001 concurrent finalisations of different drafts", () => {
  test("EC-001 drafts finalised back to back (same millisecond) get distinct consecutive numbers, each registered once", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const ids: Id<"salesDocuments">[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) })).id);
    }
    // The clock is frozen: every commit happens at the same millisecond. Convex serialises the commits (OCC retry on
    // the shared counter); convex-test runs them one after the other — the real 1,000-parallel race is integration.
    const results = await Promise.all(ids.map((id) => owner.action(api.invoices.finalize, { id, version: 1 })));
    const numbers = results.map((r) => r.number);
    expect(new Set(numbers).size).toBe(5);
    expect([...numbers].sort()).toEqual([
      "RE-2026-0001",
      "RE-2026-0002",
      "RE-2026-0003",
      "RE-2026-0004",
      "RE-2026-0005",
    ]);
    await settle(t);
    const register = await invoiceRegister(t);
    expect(register).toHaveLength(5);
    expect(new Set(register.map((r) => r.documentId)).size).toBe(5);
    const counter = await t.run(async (ctx) => (await ctx.db.query("numberCounters").collect()).map((c) => c.next));
    expect(counter).toContain(6);
  });
});

describe("EC-004 company profile changes between preview and commit", () => {
  test("EC-004 the commit re-validates against the current company data in its transaction; nothing is committed and the user re-previews", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const preview = await owner.query(api.invoices.finalizeCheck, { id });
    expect(preview.check?.canFinalize).toBe(true);
    // The profile loses the mandatory GmbH Geschäftsbrief data while the preview XML is being validated (MAIL-03).
    vi.stubEnv("EINVOICE_TOOLS_URL", "http://einvoice-tools.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await t.model(OWNER, (ctx) =>
          patchCompanyProfile(ctx, { representatives: [] }, { action: "settings.company.update" }),
        );
        return new Response(JSON.stringify(KOSIT_OK));
      }),
    );
    const e = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("revalidation_failed");
    expect(JSON.stringify(dataOf(e).findings)).toMatch(/Geschäftsführ|Vertret|representative/i);
    const d = await doc(t, id);
    expect(d.status).toBe("draft");
    expect(d.number).toBeUndefined();
    expect(await invoiceRegister(t)).toHaveLength(0);
    // The fresh preview now shows the blocking finding instead.
    expect((await owner.query(api.invoices.finalizeCheck, { id })).check?.canFinalize).toBe(false);
  });
});

describe("EC-006 final KoSIT validation fails after the commit", () => {
  test("EC-006 the document stays finalised with its number, ends blocked with the KoSIT error audited; export and the sent mark are disabled", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    let calls = 0;
    vi.stubEnv("EINVOICE_TOOLS_URL", "http://einvoice-tools.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!String(url).endsWith("/validate/xml")) return new Response(JSON.stringify({ valid: true }));
        calls++;
        // The preview passes; the final XML (after the commit) is rejected.
        return calls === 1
          ? new Response(JSON.stringify(KOSIT_OK))
          : new Response(
              JSON.stringify({ acceptable: false, errors: [{ code: "BR-DE-15", text: "Leitweg-ID fehlt" }] }),
              { status: 422 },
            );
      }),
    );
    const { number } = await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    expect(number).toBe("RE-2026-0001");
    let d = await doc(t, id);
    expect(d).toMatchObject({ status: "finalized", number, artifactStatus: "pending" });
    expect(d.artifactError).toMatch(/KoSIT: BR-DE-15/);
    for (let i = 0; i < 5; i++) {
      await t.mutation(internal.invoices.artifactFailure, { id, error: "KoSIT: BR-DE-15 Leitweg-ID fehlt" });
    }
    d = await doc(t, id);
    expect(d).toMatchObject({ status: "finalized", number, artifactStatus: "blocked" });
    // Incident note in the audit log: the validator error is recorded on the document's entries, then the block.
    const audit = await auditOf(t, "salesDocuments", id);
    const firstFailure = audit.find((e) => e.action === "document.artifacts_retry");
    expect(firstFailure?.diff).toMatchObject({ after: { artifactError: expect.stringMatching(/KoSIT: BR-DE-15/) } });
    expect(audit.find((e) => e.action === "document.artifacts_blocked")?.diff).toMatchObject({
      after: { artifactStatus: "blocked" },
    });
    expect((await owner.query(api.invoices.todos, {})).some((n) => n.kind === "artifacts_blocked")).toBe(true);
    // Sending is disabled: no export, and the mark-sent dialog refuses with artifacts_blocked.
    const exp = await owner
      .action(api.documentArtifacts.exportFiles, { id, request: { entry: "default" } })
      .catch((x: unknown) => x);
    expect(errorCode(exp)).toBe("artifacts_blocked");
    const mark = await owner.query(api.invoices.markSentPreview, {
      id,
      values: { sentOn: "2026-10-12", channel: "email_manual", artifactIds: [] },
    });
    expect(mark.errors.map((f) => f.code)).toContain("artifacts_blocked");
    expect(await invoiceRegister(t)).toHaveLength(1); // never renumbered or rolled back
  });
});

describe("EC-007 the einvoice-tools sidecar is down at finalisation", () => {
  test("EC-007 an E-Rechnung is refused before the commit with dependency_unavailable; no number is consumed", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    vi.stubEnv("EINVOICE_TOOLS_URL", "http://einvoice-tools.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }),
    );
    const e = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("dependency_unavailable");
    expect((await doc(t, id)).status).toBe("draft");
    expect(await invoiceRegister(t)).toHaveLength(0);
  });

  test("EC-007 exception: a document without an XML format (ER-03 NOT_REQUIRED, consumer) finalises without the sidecar", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const consumer = await consumerBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(consumer as string, { einvoiceFormat: "none" }),
    });
    const fetchSpy = vi.fn(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    vi.stubEnv("EINVOICE_TOOLS_URL", "http://einvoice-tools.test");
    vi.stubGlobal("fetch", fetchSpy);
    const check = await owner.query(api.invoices.finalizeCheck, { id });
    expect(check.check?.einvoice).toMatchObject({ decision: "NOT_REQUIRED", format: "none" });
    const r = await owner.action(api.invoices.finalize, { id, version: 1 });
    expect(r.number).toBe("RE-2026-0001");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("EC-010 year rollover with a yearly reset", () => {
  test("EC-010 a draft created 31.12. and finalised 02.01. takes the new year's counter; backdated into the old year it continues the old counter", async () => {
    vi.setSystemTime(new Date("2026-12-31T09:00:00Z"));
    const t = makeT();
    let { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const values = invoiceValues(personId, { supplyDate: { kind: "date", date: "2026-12-30" as never } });
    const first = await owner.mutation(api.invoices.createDraft, { values });
    expect((await owner.action(api.invoices.finalize, { id: first.id, version: 1 })).number).toBe("RE-2026-0001");
    const a = await owner.mutation(api.invoices.createDraft, { values });
    const b = await owner.mutation(api.invoices.createDraft, { values });

    vi.setSystemTime(new Date("2027-01-02T09:00:00Z"));
    owner = await t.asUser("owner", { existingUserId: owner.userId });
    const ra = await owner.action(api.invoices.finalize, { id: a.id, version: 1 });
    expect(ra.number).toBe("RE-2027-0001");
    expect((await doc(t, a.id)).documentDate).toBe("2027-01-02");
    // Backdated to 31.12.2026 (within the backdate window): the 2026 counter continues.
    const rb = await owner.action(api.invoices.finalize, { id: b.id, version: 1, documentDate: "2026-12-31" });
    expect(rb.number).toBe("RE-2026-0002");
    expect((await doc(t, b.id)).documentDate).toBe("2026-12-31");
    await settle(t);
    const counters = await t.run(async (ctx) =>
      (await ctx.db.query("numberCounters").collect()).map((c) => [c.periodKey, c.next]).sort(),
    );
    expect(counters).toEqual(
      expect.arrayContaining([
        ["2026", 3],
        ["2027", 2],
      ]),
    );
  });
});

describe("EC-013 a deleted draft", () => {
  test("EC-013 deleting a draft consumes no number and the deletion is audited with the content", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.mutation(api.invoices.deleteDraft, { id });
    const del = (await auditOf(t, "salesDocuments", id)).find((e) => e.action === "document.delete_draft");
    const before = (del?.diff as { before?: Record<string, unknown>; after?: unknown } | undefined)?.before;
    expect(before).toMatchObject({ status: "draft", type: "invoice", contactName: "Max Beispiel" });
    expect((before?.totals as { grossCents?: number } | undefined)?.grossCents).toBe(119_000);
    expect(del).toBeDefined();
    expect((del?.diff as { after?: unknown } | undefined)?.after).toBeUndefined();
    // The lines are deleted with their content audited as well.
    const lineDeletes = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter(
        (e) => e.entity.table === "documentLines" && (e.diff as { after?: unknown })?.after === undefined,
      ),
    );
    expect(JSON.stringify(lineDeletes.map((e) => e.diff))).toContain("Beratung Webdesign");
    // No number consumed: the next finalisation gets 0001.
    const next = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    expect((await owner.action(api.invoices.finalize, { id: next.id, version: 1 })).number).toBe("RE-2026-0001");
    await settle(t);
  });
});

describe("EC-100 the KoSIT bundle is updated later", () => {
  test("EC-100 archived artifacts and reports stay as archived: „Erneut erzeugen“ is refused for a ready document and nothing is regenerated", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const before = await t.run((ctx) =>
      ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect(),
    );
    expect(before.length).toBeGreaterThan(0);
    const snapBefore = (await owner.query(api.invoices.get, { id }))?.snapshot as DocumentSnapshot;
    // A newer validator would now reject the old XML — the app does not re-validate or re-render finalised files.
    vi.stubEnv("EINVOICE_TOOLS_URL", "http://einvoice-tools.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ acceptable: false, errors: [{ code: "NEW-RULE" }] }), { status: 422 }),
      ),
    );
    const e = await owner.mutation(api.invoices.retryArtifacts, { id }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("conflict");
    await settle(t);
    const after = await t.run((ctx) =>
      ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect(),
    );
    expect(after.map((a) => [a._id, a.sha256])).toEqual(before.map((a) => [a._id, a.sha256]));
    expect((await doc(t, id)).artifactStatus).toBe("ready");
    expect((await owner.query(api.invoices.get, { id }))?.snapshot).toEqual(snapBefore);
  });
});
