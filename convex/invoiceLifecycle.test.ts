import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import { readEmbeddedFiles } from "../src/pdf/embedded-files";
import { checkInvariants, clearInvariantTarget } from "../test/invariants";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createValues, orgForm } from "./catalog.fixtures";
import { b2bBuyer, finalizedInvoice, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedPatch } from "./model/audit";
import { recordIntegrityRun } from "./model/integrity";
import { makeT, type TestT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

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
const codes = (e: unknown) => ((dataOf(e).findings ?? []) as { code: string }[]).map((f) => f.code);

const doc = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => {
    const d = await ctx.db.get(id);
    if (!d) throw new Error("missing");
    return d;
  });

const auditActions = (t: TestT, table: string, id: string) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => q.eq("entity.table", table).eq("entity.id", id))
        .collect()
    ).map((e) => e.action),
  );

async function blobSha(t: TestT, storageId: Id<"_storage">): Promise<{ sha: string; bytes: Uint8Array }> {
  return t
    .run(async (ctx) => {
      const blob = await ctx.storage.get(storageId);
      if (!blob) throw new Error("blob missing");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { sha: await sha256Hex(bytes), buffer: bytes.buffer as ArrayBuffer };
    })
    .then((r) => ({ sha: r.sha, bytes: new Uint8Array(r.buffer) }));
}

// ── drafts ───────────────────────────────────────────────────────────────────────────────────────────────

describe("DOC-03 DOC-52 drafts", () => {
  test("DOC-03 a draft is created, edited with the current version and deleted (audited)", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    let d = await doc(t, id);
    expect(d).toMatchObject({ status: "draft", version: 1, contactName: "Max Beispiel" });
    expect(d.number).toBeUndefined();
    expect(d.totals.grossCents).toBe(119_000);

    const values = invoiceValues(personId, {
      lines: [
        { ...invoiceValues(personId).lines[0], quantityMilli: 5_000 } as ReturnType<typeof invoiceValues>["lines"][0],
        { kind: "text", name: "Vielen Dank für Ihren Auftrag." },
      ],
    });
    const r = await owner.mutation(api.invoices.updateDraft, { id, version: 1, values });
    expect(r.version).toBe(2);
    d = await doc(t, id);
    expect(d.totals.grossCents).toBe(59_500);
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.lines.map((l) => l.kind)).toEqual(["item", "text"]);

    await owner.mutation(api.invoices.deleteDraft, { id });
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
    expect(await auditActions(t, "salesDocuments", id)).toEqual(
      expect.arrayContaining(["document.create_draft", "document.delete_draft"]),
    );
  });

  test("DOC-52 a stale version is refused with version_conflict", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.mutation(api.invoices.updateDraft, { id, version: 1, values: invoiceValues(personId) });
    const e = await owner
      .mutation(api.invoices.updateDraft, { id, version: 1, values: invoiceValues(personId) })
      .catch((x: unknown) => x);
    expect(errorCode(e)).toBe("version_conflict");
  });

  test("DOC-08 SET-050b a draft without bank account and payment method gets the defaults", async () => {
    const t = makeT();
    const { owner, bankAccount } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const d = await doc(t, id);
    expect(d.bankAccountId).toBe(bankAccount);
    expect(d.paymentMethodId).toBeDefined();
    const defaults = await owner.query(api.invoices.draftDefaults, { contactId: personId });
    expect(defaults.bankAccountId).toBe(bankAccount);
  });

  test("DOC-19 DOC-42 the live check returns totals, tax case and findings without writing", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const before = await t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).length);
    const r = await owner.query(api.invoices.check, { values: invoiceValues(personId) });
    expect(r?.totals).toMatchObject({ netCents: 100_000, vatCents: 19_000, grossCents: 119_000 });
    expect(r?.taxCase).toBe("domestic");
    expect(r?.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(r?.canFinalize).toBe(true);
    expect(r?.einvoice).toMatchObject({ decision: "PDF_NEEDS_CONSENT", format: "zugferd_en16931" });
    const missing = await owner.query(api.invoices.check, {
      values: invoiceValues(personId, { lines: [{ kind: "item", name: "Leistung", quantityMilli: 1_000 }] }),
    });
    expect(missing?.canFinalize).toBe(false);
    expect(missing?.findings.every((f) => typeof f.rule === "string" && f.rule.length > 0)).toBe(true);
    expect(await t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).length)).toBe(before);
  });

  test("DOC-20 the compliance panel lists errors with their spec codes and blocks finalisation", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues("", { contactId: undefined }),
    });
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.canFinalize).toBe(false);
    const errors = detail?.findings.filter((f) => f.severity === "E") ?? [];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ group: expect.any(String), rule: expect.stringMatching(/^[A-Z]+-\d+/) });
    const e = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("validation_failed");
    // T-DOC-018: an error before the commit consumes no number.
    expect(
      await t.run(
        async (ctx) => (await ctx.db.query("numberRegister").collect()).filter((r) => r.docType === "invoice").length,
      ),
    ).toBe(0);
  });
});

// ── finalisation ─────────────────────────────────────────────────────────────────────────────────────────

describe("DOC-24 finalisation (02 §6)", () => {
  test("SET-005 an incomplete setup blocks finalisation with setup_incomplete", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t, { setupComplete: false });
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const e = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("validation_failed");
    expect(codes(e)).toContain("setup_incomplete");
  });

  test("DOC-60 an unacknowledged integrity failure blocks finalisation", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await t.asSystem("cron.integrity.verify").model((ctx) =>
      recordIntegrityRun(ctx, {
        scope: "full",
        lastVerifiedSeq: 1,
        findings: [{ kind: "chain", severity: "error", detail: "test" }],
      }),
    );
    const e = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x: unknown) => x);
    expect(codes(e)).toContain("integrity_alert_open");
  });

  test("DOC-59 EC-027 a server clock off by more than 60 s blocks finalisation before a number is used", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    vi.stubEnv("CLOCK_REFERENCE_URL", "https://time.example.test/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { headers: { date: new Date(NOW.getTime() + 120_000).toUTCString() } })),
    );
    const e = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("clock_skew");
    expect(
      await t.run(
        async (ctx) => (await ctx.db.query("numberRegister").collect()).filter((r) => r.docType === "invoice").length,
      ),
    ).toBe(0);
  });

  test("SET-059 SET-060 SET-061 DOC-25 numbers are consecutive, registered and assigned only at commit", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const a = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const b = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    expect((await doc(t, a.id)).number).toBeUndefined();
    expect((await owner.action(api.invoices.finalize, { id: b.id, version: 1 })).number).toBe("RE-2026-0001");
    expect((await owner.action(api.invoices.finalize, { id: a.id, version: 1 })).number).toBe("RE-2026-0002");
    await settle(t);
    const register = (await t.run((ctx) => ctx.db.query("numberRegister").collect())).filter(
      (r) => r.docType === "invoice",
    );
    expect(register.map((r) => [r.number, r.documentId])).toEqual([
      ["RE-2026-0001", b.id],
      ["RE-2026-0002", a.id],
    ]);
    const detail = await owner.query(api.invoices.get, { id: a.id });
    expect(detail?.register).toMatchObject({ number: "RE-2026-0002", status: "issued" }); // DOC-39
  });

  test("EC-002 finalising the same version twice is idempotent (same number, no second entry)", async () => {
    const t = makeT();
    const { owner, id, number } = await finalizedInvoice(t);
    const again = await owner.action(api.invoices.finalize, { id, version: 1 });
    expect(again).toEqual({ number, idempotentReplay: true });
    expect(
      await t.run(
        async (ctx) => (await ctx.db.query("numberRegister").collect()).filter((r) => r.docType === "invoice").length,
      ),
    ).toBe(1);
    const e = await owner.action(api.invoices.finalize, { id, version: 2 }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("document_not_draft");
  });

  test("DOC-26 DOC-27 SET-024 the document date is the Berlin date of the commit; the snapshot and hash are frozen", async () => {
    const t = makeT();
    vi.setSystemTime(new Date("2026-10-12T22:30:00Z")); // 00:30 on 13 Oct in Berlin
    const { owner, id } = await finalizedInvoice(t);
    const d = await doc(t, id);
    expect(d.documentDate).toBe("2026-10-13");
    expect(d.dueDate).toBe("2026-11-12");
    expect(d.retentionUntil).toBe("2034-12-31");
    const snap = await t.run(async (ctx) => (d.snapshotId ? ctx.db.get(d.snapshotId) : null));
    expect(snap?.snapshotHash).toBe(await sha256Hex(snap?.json ?? ""));
    const s = JSON.parse(snap?.json ?? "{}") as DocumentSnapshot;
    expect(s.taxCase).toBe("domestic");
    expect(s.seller.kleinunternehmer).toBe(false);
    expect(s.seller.vatAccounting).toBe("soll");
    expect(s.ruleVersions["vat:standard"]).toBe("standard@2021-01-01");
    expect((await owner.query(api.invoices.get, { id }))?.snapshot?.documentDate).toBe("2026-10-13");
  });

  test("INV-31 ACC-010 the commit posts invoice_finalised in the same transaction", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t);
    const entries = await t.run((ctx) => ctx.db.query("journalEntries").collect());
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e?.source).toMatchObject({ kind: "salesDocument", id });
    const debit = e?.lines.reduce((s, l) => s + l.debitCents, 0);
    const credit = e?.lines.reduce((s, l) => s + l.creditCents, 0);
    expect(debit).toBe(119_000);
    expect(credit).toBe(119_000);
    expect(e?.lines.map((l) => l.account).sort()).toEqual(["1400", "1776", "8400"]);
  });

  test("SET-022 DOC-22 company and contact changes after finalisation do not change the frozen snapshot", async () => {
    const t = makeT();
    const { owner, id, orgId } = await finalizedInvoice(t);
    const before = (await owner.query(api.invoices.get, { id }))?.snapshot;
    const c = await owner.query(api.contacts.get, { id: orgId });
    await owner.mutation(api.contacts.update, {
      id: orgId,
      version: c?.contact.version ?? 1,
      values: orgForm("Neuer Name GmbH", { number: "K-10023", vatId: "DE811907980" }),
    });
    expect((await owner.query(api.invoices.get, { id }))?.snapshot).toEqual(before);
  });
});

// ── immutability (GoBD) ──────────────────────────────────────────────────────────────────────────────────

describe("T-DOC-019 GOBD-06 finalised documents are immutable", () => {
  test("T-DOC-019 edits, deletes and line changes of a finalised invoice are refused", async () => {
    const t = makeT();
    const { owner, id, personId } = await finalizedInvoice(t);
    const upd = await owner
      .mutation(api.invoices.updateDraft, { id, version: 2, values: invoiceValues(personId) })
      .catch((x: unknown) => x);
    expect(errorCode(upd)).toBe("document_not_draft");
    const del = await owner.mutation(api.invoices.deleteDraft, { id }).catch((x: unknown) => x);
    expect(["document_not_draft", "illegal_transition"]).toContain(errorCode(del));
    const actor = { actor: owner.actor, role: "owner", channel: "ui" } as const;
    const patchDoc = await t
      .model(actor, (ctx) => auditedPatch(ctx, "salesDocuments", id, { subject: "geändert" }, { action: "test" }))
      .catch((x: unknown) => x);
    expect(errorCode(patchDoc)).toBe("immutable_record");
    const line = (await owner.query(api.invoices.get, { id }))?.lines[0];
    if (!line) throw new Error("no line");
    const patchLine = await t
      .model(actor, (ctx) => auditedPatch(ctx, "documentLines", line._id, { name: "x" }, { action: "test" }))
      .catch((x: unknown) => x);
    expect(errorCode(patchLine)).toBe("immutable_record");
  });
});

// ── artifacts ────────────────────────────────────────────────────────────────────────────────────────────

describe("DOC-28 ER-11 ER-13 INV-21 artifacts", () => {
  test("DOC-28 ER-13 archived bytes match their sha256; INV-21 the embedded XML equals the archived XML", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t);
    const artifacts = await t.run((ctx) =>
      ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect(),
    );
    const pdf = artifacts.find((a) => a.kind === "zugferd_pdf");
    const xml = artifacts.find((a) => a.kind === "xrechnung_xml");
    if (!pdf || !xml) throw new Error("artifacts missing");
    const p = await blobSha(t, pdf.storageId);
    const x = await blobSha(t, xml.storageId);
    expect(p.sha).toBe(pdf.sha256);
    expect(x.sha).toBe(xml.sha256);
    expect(pdf).toMatchObject({ name: "RE-2026-0001.pdf", retentionUntil: "2034-12-31", variant: "original" });
    const embedded = await readEmbeddedFiles(p.bytes);
    expect(embedded.map((f) => f.name)).toEqual(["factur-x.xml"]);
    expect(Buffer.from(embedded[0]?.bytes ?? []).equals(Buffer.from(x.bytes))).toBe(true);
  });

  test("DOC-28 a failed render retries with backoff and ends blocked with an alert; „Erneut erzeugen“ recovers", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    // Sidecar: KoSIT accepts the XML, Mustang is down → the render after the commit fails.
    vi.stubEnv("EINVOICE_TOOLS_URL", "http://einvoice-tools.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/validate/xml")
          ? new Response(JSON.stringify({ acceptable: true, validatorVersion: "1.6.3", configVersion: "3.0.2" }))
          : new Response("down", { status: 503 }),
      ),
    );
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    let d = await doc(t, id);
    expect(d).toMatchObject({ artifactStatus: "pending", artifactAttempts: 1 });
    expect(d.artifactError).toMatch(/Mustang nicht erreichbar/);
    expect(d.einvoice.validation).toBe("passed");
    // The five retries (10 s, 1 min, 5 min, 30 min, 2 h) fail as well.
    const delays: (number | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await t.mutation(internal.invoices.artifactFailure, { id, error: "Mustang nicht erreichbar" });
      delays.push(r.retryInMs);
    }
    expect(delays).toEqual([60_000, 300_000, 1_800_000, 7_200_000, null]);
    d = await doc(t, id);
    expect(d.artifactStatus).toBe("blocked");
    const todos = await owner.query(api.invoices.todos, {});
    expect(todos.some((n) => n.kind === "artifacts_blocked")).toBe(true);
    const exp = await owner
      .action(api.documentArtifacts.exportFiles, { id, request: { entry: "default" } })
      .catch((x: unknown) => x);
    expect(errorCode(exp)).toBe("artifacts_blocked");

    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await owner.mutation(api.invoices.retryArtifacts, { id });
    await settle(t);
    expect((await doc(t, id)).artifactStatus).toBe("ready");
    expect((await owner.query(api.invoices.todos, {})).some((n) => n.kind === "artifacts_blocked")).toBe(false);
  });
});

// ── export and sent mark ─────────────────────────────────────────────────────────────────────────────────

describe("SND-16 SND-22 SND-06 export", () => {
  test("SND-16 SND-22 the export serves the archived files, audits document.export and never changes the status", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const r = await owner.action(api.documentArtifacts.exportFiles, { id, request: { entry: "zip" } });
    expect(r.zipName).toBe("RE-2026-0001.zip");
    expect(r.files.map((f) => f.name).sort()).toEqual(["RE-2026-0001.pdf", "RE-2026-0001.xml"]);
    expect(r.files.every((f) => f.url.length > 0 && /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    const d = await doc(t, id);
    expect(d.status).toBe("finalized"); // SND-06
    expect(d.sentAt).toBeUndefined();
    expect(d.firstExportedAt).toBe(NOW.getTime());
    expect(await auditActions(t, "documentExports", id)).toEqual(["document.export"]);
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.defaultMarkSelection.sort()).toEqual(r.files.map((f) => f.artifactId).sort());
  });

  test("SND-21 an exported but unmarked invoice becomes a to-do after two days; the mark resolves it", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const r = await owner.action(api.documentArtifacts.exportFiles, { id, request: { entry: "default" } });
    vi.setSystemTime(new Date("2026-10-14T07:00:00Z"));
    const fresh = await t.asUser("owner", { existingUserId: owner.userId });
    expect(await t.mutation(internal.invoices.notifyDeadlinesCron, { force: true })).toEqual({ created: 1 });
    expect(await t.mutation(internal.invoices.notifyDeadlinesCron, { force: true })).toEqual({ created: 0 });
    const todos = await owner.query(api.invoices.todos, {});
    expect(todos.map((n) => n.title)).toContain("Exportiert, aber nicht als versendet markiert: RE-2026-0001");
    expect(
      (
        await owner.query(api.invoices.list, {
          paginationOpts: { numItems: 10, cursor: null },
          tab: "exported_not_marked",
        })
      ).page,
    ).toHaveLength(1);
    await fresh.mutation(api.invoices.markSent, {
      id,
      values: { sentOn: "2026-10-13", channel: "email_manual", artifactIds: r.files.map((f) => f.artifactId) },
    });
    expect((await owner.query(api.invoices.todos, {})).some((n) => n.kind === "exported_not_marked")).toBe(false);
  });
});

describe("MAIL-02 SND-07 SND-17 SND-18 sent mark", () => {
  test("MAIL-02 the mark records date, channel, note and the artifact hashes; status → sent; Zugang derived", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const r = await owner.action(api.documentArtifacts.exportFiles, { id, request: { entry: "default" } });
    const m = await owner.mutation(api.invoices.markSent, {
      id,
      values: {
        sentOn: "2026-10-12",
        channel: "email_manual",
        note: "an buchhaltung@",
        artifactIds: [r.files[0]?.artifactId ?? ""],
      },
    });
    expect(m.firstEffective).toBe(true);
    const d = await doc(t, id);
    expect(d).toMatchObject({ status: "sent", sentOn: "2026-10-12", sentAt: NOW.getTime() });
    expect(d.zugang).toBeDefined();
    const log = await t.run((ctx) => ctx.db.query("sendLog").collect());
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: "mark_sent", channel: "email_manual", note: "an buchhaltung@" });
    expect(log[0]?.artifacts[0]?.sha256).toBe(r.files[0]?.sha256);
    expect(log[0]?.einvoiceHandedOverElectronically).toBe(true);
    const list = await owner.query(api.invoices.list, { paginationOpts: { numItems: 10, cursor: null } });
    expect(list.page[0]?.displayStatus.token).toBe("open");
  });

  test("MAIL-02 a future date, a date before finalisation and „Sonstiges“ without a note are refused", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const artifactIds = ((await owner.query(api.invoices.get, { id }))?.artifacts ?? []).map((a) => a._id);
    for (const values of [
      { sentOn: "2026-10-13", channel: "email_manual", artifactIds },
      { sentOn: "2026-10-11", channel: "email_manual", artifactIds },
      { sentOn: "2026-10-12", channel: "other", artifactIds },
      { sentOn: "2026-10-12", channel: "email_manual", artifactIds: [] },
    ]) {
      const e = await owner.mutation(api.invoices.markSent, { id, values }).catch((x: unknown) => x);
      expect(errorCode(e)).toBe("mark_sent_invalid");
    }
    expect((await doc(t, id)).status).toBe("finalized");
  });

  test("SND-18 retracting the effective mark returns the invoice to finalized (audited with reason)", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const artifactIds = ((await owner.query(api.invoices.get, { id }))?.artifacts ?? []).map((a) => a._id);
    const m = await owner.mutation(api.invoices.markSent, {
      id,
      values: { sentOn: "2026-10-12", channel: "email_manual", artifactIds },
    });
    const noReason = await owner
      .mutation(api.invoices.retractMark, { id, values: { retractsId: m.sendLogId, reason: "" } })
      .catch((x: unknown) => x);
    expect(errorCode(noReason)).toBe("retraction_invalid");
    await owner.mutation(api.invoices.retractMark, {
      id,
      values: { retractsId: m.sendLogId, reason: "Falsche Rechnung markiert" },
    });
    const d = await doc(t, id);
    expect(d.status).toBe("finalized");
    expect(d.sentAt).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.query("sendLog").collect())).map((r) => r.kind)).toEqual([
      "mark_sent",
      "retraction",
    ]);
  });

  test("DOC-32 SND-05 EC-099 after the mark the export serves the archived „Kopie“; the original needs a reason", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const artifactIds = ((await owner.query(api.invoices.get, { id }))?.artifacts ?? []).map((a) => a._id);
    await owner.mutation(api.invoices.markSent, {
      id,
      values: { sentOn: "2026-10-12", channel: "email_manual", artifactIds },
    });
    const copy = await owner.action(api.documentArtifacts.exportFiles, { id, request: { entry: "zugferd_pdf" } });
    expect(copy.files.map((f) => f.name)).toEqual(["RE-2026-0001_Kopie.pdf"]);
    const again = await owner.action(api.documentArtifacts.exportFiles, { id, request: { entry: "zugferd_pdf" } });
    expect(again.files[0]?.artifactId).toBe(copy.files[0]?.artifactId); // archived once, served again
    const noReason = await owner
      .action(api.documentArtifacts.exportFiles, { id, request: { entry: "zugferd_pdf", original: true } })
      .catch((x: unknown) => x);
    expect(errorCode(noReason)).toBe("resend_original_reason");
    const orig = await owner.action(api.documentArtifacts.exportFiles, {
      id,
      request: { entry: "zugferd_pdf", original: true, reason: "Kunde hat Original verloren" },
    });
    expect(orig.files[0]?.name).toBe("RE-2026-0001.pdf");
    expect(await auditActions(t, "documentExports", id)).toContain("document.download_original");
  });

  test("MAIL-04 ER-03 an E-Rechnung under MUST_E cannot be marked as handed over by post or by hand", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const authority = await owner.mutation(api.contacts.create, {
      values: createValues(
        orgForm("Stadtverwaltung Musterstadt", {
          isPublicAuthority: true,
          buyerReference: "04011000-1234512345-06",
          electronicAddressScheme: "0204",
          electronicAddressValue: "04011000-1234512345-06",
        }),
        { address: { street: "Rathausplatz 1", postalCode: "28195", city: "Bremen", countryCode: "DE" } },
      ),
    });
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(authority.id) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.doc.einvoice.decision).toBe("MUST_E");
    expect(detail?.artifacts.map((a) => `${a.kind}:${a.variant}`).sort()).toEqual([
      "pdf:reading",
      "xrechnung_xml:original",
    ]);
    const xml = detail?.artifacts.find((a) => a.kind === "xrechnung_xml")?._id ?? "";
    const reading = detail?.artifacts.find((a) => a.kind === "pdf")?._id ?? "";
    const post = await owner
      .mutation(api.invoices.markSent, { id, values: { sentOn: "2026-10-12", channel: "post", artifactIds: [xml] } })
      .catch((x: unknown) => x);
    expect(dataOf(post).reason).toBe("must_e_channel_not_electronic");
    const pdfOnly = await owner
      .mutation(api.invoices.markSent, {
        id,
        values: { sentOn: "2026-10-12", channel: "email_manual", artifactIds: [reading] },
      })
      .catch((x: unknown) => x);
    expect(dataOf(pdfOnly).reason).toBe("pdf_not_allowed_must_e");
    await owner.mutation(api.invoices.markSent, {
      id,
      values: { sentOn: "2026-10-12", channel: "upload_portal", artifactIds: [xml] },
    });
    expect((await doc(t, id)).status).toBe("sent");
  });
});

// ── list ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("DOC-37 list", () => {
  test("DOC-37 tabs and search (customer name, exact number)", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedInvoice(t);
    await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const page = { numItems: 20, cursor: null };
    expect((await owner.query(api.invoices.list, { paginationOpts: page })).page).toHaveLength(2);
    expect((await owner.query(api.invoices.list, { paginationOpts: page, tab: "draft" })).page).toHaveLength(1);
    expect((await owner.query(api.invoices.list, { paginationOpts: page, tab: "unsent" })).page).toHaveLength(1);
    const byNumber = await owner.query(api.invoices.list, { paginationOpts: page, q: "re-2026-0001" });
    expect(byNumber.page.map((r) => r.number)).toContain("RE-2026-0001");
    const byName = await owner.query(api.invoices.list, { paginationOpts: page, q: "Beispiel" });
    expect(byName.page.length).toBeGreaterThan(0);
  });

  test("SEC-01 viewers can read invoices but never write", async () => {
    const t = makeT();
    const { personId, id } = await finalizedInvoice(t);
    const viewer = await t.asUser("viewer");
    expect((await viewer.query(api.invoices.get, { id }))?.doc.number).toBe("RE-2026-0001");
    const e = await viewer
      .mutation(api.invoices.createDraft, { values: invoiceValues(personId) })
      .catch((x: unknown) => x);
    expect(errorCode(e)).toBe("forbidden_role");
    const exp = await viewer.action(api.documentArtifacts.exportFiles, { id, request: { entry: "pdf" } });
    expect(exp.files).toHaveLength(1);
  });
});

// ── invariants (10 §2) ───────────────────────────────────────────────────────────────────────────────────

describe("RI-01 RI-19 document invariants over the database", () => {
  test("RI-01 RI-19 EC-182 a raw database edit of a snapshot or the dispatch record is detected", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const artifactIds = ((await owner.query(api.invoices.get, { id }))?.artifacts ?? []).map((a) => a._id);
    await owner.mutation(api.invoices.markSent, {
      id,
      values: { sentOn: "2026-10-12", channel: "email_manual", artifactIds },
    });
    expect((await checkInvariants(t as never)).filter((v) => v.severity === "ERROR")).toEqual([]);
    // Out-of-band edits through the raw db (dashboard), bypassing the guarded writer.
    await t.run(async (ctx) => {
      const d = await ctx.db.get(id);
      if (!d?.snapshotId) throw new Error("no snapshot");
      const snap = await ctx.db.get(d.snapshotId);
      await ctx.db.patch(d.snapshotId, { json: (snap?.json ?? "").replace("119000", "119001") });
      for (const row of await ctx.db.query("sendLog").collect()) await ctx.db.delete(row._id);
    });
    const ids = new Set((await checkInvariants(t as never)).map((v) => v.id));
    expect(ids.has("RI-01")).toBe(true);
    expect(ids.has("RI-19")).toBe(true);
    clearInvariantTarget();
  });
});
