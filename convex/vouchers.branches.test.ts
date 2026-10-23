import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { auditedPatch } from "./model/audit";
import { saveTag } from "./model/lookups";
import { approveBewirtung, approveEigenbeleg } from "./model/vouchers";
import { bookedTransaction } from "./payments.fixtures";
import { makeT, type TestT } from "./test.setup";
import { header, line, OWNER, pdfBytes, setupCompany, TODAY, upload, YEAR } from "./vouchers.fixtures";

/**
 * F06 voucher core branch coverage (convex/vouchers.ts + convex/model/vouchers.ts): list/search fallbacks, the
 * suggestion and option queries, capture metadata per channel, bulk actions and the Sammelbuchung job, correction /
 * cancellation / duplication guards, Bewirtung / Eigenbeleg approval guards and the recurring cron.
 */

type Owner = Awaited<ReturnType<TestT["asUser"]>>;

async function errorOf(p: Promise<unknown>): Promise<{ code: string; message: string; data: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const data = ((e as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
    return { code: errorCode(e) ?? "unknown", message: String(data.message ?? (e as Error).message), data };
  }
  throw new Error("expected an error");
}

const voucher = (t: TestT, id: Id<"vouchers">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"vouchers">>;
const auditOf = (t: TestT, action: string) =>
  t.run((ctx) =>
    ctx.db
      .query("auditLog")
      .filter((q) => q.eq(q.field("action"), action))
      .collect(),
  );
const linesOf = (t: TestT, id: Id<"vouchers">) =>
  t.run((ctx) =>
    ctx.db
      .query("voucherLines")
      .withIndex("by_voucher", (q) => q.eq("voucherId", id))
      .collect(),
  );

async function draft(t: TestT, owner: Owner, over: Record<string, unknown> = {}) {
  const { voucherId } = await upload(t, owner);
  await owner.mutation(api.vouchers.updateDraft, { id: voucherId, input: header(over) });
  return voucherId;
}

async function booked(t: TestT, owner: Owner, over: Record<string, unknown> = {}) {
  const id = await draft(t, owner, over);
  await owner.mutation(api.vouchers.finalize, { id });
  return id;
}

describe("views (VOU-001, VOU-123, VOU-125)", () => {
  test("VOU-001 the list searches supplier, number and note; an unknown tab falls back to „Alle“; an unknown id is null", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const a = await draft(t, owner, { supplierName: "Telekom Deutschland GmbH", internalNote: "Mobilfunk Oktober" });
    const b = await draft(t, owner, { supplierName: "Shell Deutschland", documentNumber: "TANK-4711" });
    const all = await owner.query(api.vouchers.list, {
      paginationOpts: { numItems: 10, cursor: null },
      tab: "gibt-es-nicht",
    });
    expect(all.page.map((r) => r._id).sort()).toEqual([a, b].sort());
    const byNote = await owner.query(api.vouchers.list, {
      paginationOpts: { numItems: 10, cursor: null },
      q: "  MOBILFUNK ",
    });
    expect(byNote.page).toHaveLength(1);
    expect(byNote.page[0]?._id).toBe(a);
    const byNumber = await owner.query(api.vouchers.list, {
      paginationOpts: { numItems: 10, cursor: null },
      q: "tank-47",
    });
    expect(byNumber.page).toHaveLength(1);
    expect(byNumber.page[0]?._id).toBe(b);
    const none = await owner.query(api.vouchers.list, { paginationOpts: { numItems: 10, cursor: null }, q: "xyz" });
    expect(none.page).toEqual([]);
    // VOU-123: the „Papier vernichtbar“ tab without a released scanning procedure lists nothing.
    const paper = await owner.query(api.vouchers.list, {
      paginationOpts: { numItems: 10, cursor: null },
      tab: "paper_destructible",
    });
    expect(paper.page).toEqual([]);
    await owner.mutation(api.vouchers.deleteDraft, { id: b });
    expect(await owner.query(api.vouchers.get, { id: b })).toBeNull();
  });

  test("VOU-125 the scanning procedure lists active writers and the channels of vouchers:write keys; no profile → „das Unternehmen“", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await t.asUser("bookkeeper", { email: "buchhaltung@example.test" });
    await t.asUser("viewer", { email: "lesen@example.test" });
    const bare = await owner.query(api.vouchers.scanningProcedure, {});
    expect(bare.companyName).toBe("das Unternehmen");
    expect(bare.channels).toEqual(["upload", "app"]);
    expect(bare.responsible.some((r) => r.endsWith("(Inhaber)"))).toBe(true);
    expect(bare.responsible).toContain("buchhaltung@example.test (Buchhaltung)");
    expect(bare.responsible.some((r) => r.startsWith("lesen@"))).toBe(false);
    await t.asApiKey(["vouchers:read"]); // no write scope: no channel
    expect((await owner.query(api.vouchers.scanningProcedure, {})).channels).toEqual(["upload", "app"]);
    await t.asMcp(["vouchers:write"]);
    expect((await owner.query(api.vouchers.scanningProcedure, {})).channels).toEqual(["upload", "app", "mcp"]);
    await t.asApiKey(["vouchers:write"]);
    expect((await owner.query(api.vouchers.scanningProcedure, {})).channels).toEqual(["upload", "app", "api", "mcp"]);
  });
});

describe("suggestions and options (VOU-002, VOU-041, VOU-043, EC-VOU-37)", () => {
  test("VOU-043 without a learned profile the tax rule comes from the supplier data (EU VAT ID, no VAT shown)", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const eu = await owner.query(api.vouchers.suggest, {
      direction: "expense",
      supplierName: "Hosting B.V.",
      supplierVatId: "NL123456789B01",
      supplierCountry: "NL",
      vatShown: false,
      text: "Server Hosting",
    });
    expect(eu.taxRule.rule).toBe("reverse_charge_eu");
    expect(eu.ku).toBe(false);
    // No arguments at all: today, the default rule (German VAT shown), no profile.
    const plain = await owner.query(api.vouchers.suggest, { direction: "expense" });
    expect(plain.taxRule).toEqual({ rule: "input_vat_deductible", reason: expect.anything() });
    // An explicit tax rule restricts the allowed accounts; an IBAN-only key finds no profile.
    const income = await owner.query(api.vouchers.suggest, {
      direction: "income",
      taxRule: "not_taxable",
      supplierIban: "DE02120300000000202051",
      date: TODAY,
    });
    expect(income.taxRule.reason).not.toBe("gelernt");
  });

  test("VOU-041 VOU-042 after a booking the supplier profile (VAT ID → IBAN → name) is the learned suggestion", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    await booked(t, owner, {
      supplierName: "Telekom Deutschland GmbH",
      supplierVatId: "DE811907980",
      supplierIban: "DE02120300000000202051",
      lines: [line({ account: "6805", costCenterId: "kst-7" })],
    });
    const profile = await t.run((ctx) => ctx.db.query("supplierProfiles").first());
    expect(profile).toMatchObject({ lastAccount: "6805", lastCostCenterId: "kst-7", uses: 1 });
    // The profile is keyed by the strongest key (VAT ID); the learned rule wins over the derived one.
    const s = await owner.query(api.vouchers.suggest, {
      direction: "expense",
      supplierVatId: "de 811 907 980",
      supplierIban: "DE02120300000000202051",
      supplierName: "Irgendwer",
    });
    expect(s.taxRule).toEqual({ rule: "input_vat_deductible", reason: "gelernt" });
    expect(s.account).toMatchObject({ account: "6805" });
    // A key that was never learned (another IBAN, no VAT ID) gives no learned suggestion.
    const other = await owner.query(api.vouchers.suggest, {
      direction: "expense",
      supplierIban: "DE89370400440532013000",
    });
    expect(other.taxRule.reason).not.toBe("gelernt");
  });

  test("EC-VOU-37 options: allowed accounts per direction and rule; a GmbH is a corporation; without a profile there is no chart", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    // Before the company setup: SKR03 by default, no KU, not a corporation.
    const none = await owner.query(api.vouchers.options, { direction: "expense", taxRule: "no_input_vat" });
    expect(none).toMatchObject({ chart: "SKR03", ku: false, corporation: false });
    expect((await owner.query(api.vouchers.suggest, { direction: "expense", date: TODAY })).ku).toBe(false);
    await setupCompany(t, { legalForm: "gmbh", chart: "SKR03" });
    const o = await owner.query(api.vouchers.options, { direction: "expense", taxRule: "input_vat_deductible" });
    expect(o).toMatchObject({ chart: "SKR03", ku: false, corporation: true });
    expect(o.accounts.length).toBeGreaterThan(0);
    expect(o.accounts.some((a) => a.number.startsWith("8"))).toBe(false); // no revenue accounts on expenses
    expect(o.taxRules.every((r) => r.label && r.help)).toBe(true);
    const inc = await owner.query(api.vouchers.options, { direction: "income", taxRule: "not_taxable", date: TODAY });
    expect(inc.taxRules.map((r) => r.value)).toContain("not_taxable");
  });
});

describe("capture metadata (VOU-120, VOU-122, GOBD-08)", () => {
  test("VOU-120 the channel decides capturedVia; an XML is an extracted_xml, an e-mail an eml; the device time is kept", async () => {
    const t = makeT();
    await setupCompany(t);
    const store = (bytes: Uint8Array, type: string) =>
      t.run((ctx) => ctx.storage.store(new Blob([bytes as BlobPart], { type })));
    const base = { sha256: "a".repeat(64), bytes: 10, pages: 1 };
    const xml = await t.mutation(internal.vouchers.attachFileInternal, {
      actorContext: { actor: OWNER.actor, role: "owner", channel: "api" },
      file: { ...base, storageId: await store(pdfBytes(), "application/xml"), mime: "application/xml", name: "x.xml" },
    });
    const eml = await t.mutation(internal.vouchers.attachFileInternal, {
      actorContext: { actor: OWNER.actor, role: "owner", channel: "mcp" },
      voucherId: xml.voucherId,
      file: {
        ...base,
        sha256: "b".repeat(64),
        storageId: await store(pdfBytes(), "message/rfc822"),
        mime: "message/rfc822",
        name: "mail.eml",
        clientCapturedAt: 1_700_000_000_000,
      },
    });
    expect(eml).toEqual({ voucherId: xml.voucherId, index: 1 });
    const app = await t.mutation(internal.vouchers.attachFileInternal, {
      actorContext: { actor: OWNER.actor, role: "owner", channel: "system" },
      voucherId: xml.voucherId,
      via: "app",
      file: {
        ...base,
        sha256: "c".repeat(64),
        storageId: await store(pdfBytes(), "application/pdf"),
        mime: "application/pdf",
        name: "p.pdf",
      },
    });
    expect(app.index).toBe(2);
    const other = await t.mutation(internal.vouchers.attachFileInternal, {
      actorContext: { actor: OWNER.actor, role: "owner", channel: "system" },
      voucherId: xml.voucherId,
      file: {
        ...base,
        sha256: "d".repeat(64),
        storageId: await store(pdfBytes(), "application/pdf"),
        mime: "application/pdf",
        name: "q.pdf",
      },
    });
    expect(other.index).toBe(3);
    const v = await voucher(t, xml.voucherId);
    expect(v.originalFiles.map((f) => [f.role, f.capturedVia])).toEqual([
      ["extracted_xml", "api"],
      ["eml", "mcp"],
      ["original", "app"],
      ["original", "upload"],
    ]);
    expect(v.originalFiles[1]?.clientCapturedAt).toBe(1_700_000_000_000);
    expect(v.originalFiles[0]?.clientCapturedAt).toBeUndefined();
  });

  test("VOU-120 VOU-122 the upload action: a vanished upload, a blank name, device time and the replacement reason", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([pdfBytes() as BlobPart])));
    await t.run((ctx) => ctx.storage.delete(storageId));
    const gone = await errorOf(owner.action(api.vouchers.attachFile, { storageId, name: "weg.pdf" }));
    expect(gone).toMatchObject({ code: "not_found", message: "Die hochgeladene Datei wurde nicht gefunden." });
    const sid = await t.run((ctx) => ctx.storage.store(new Blob([pdfBytes() as BlobPart])));
    const r = await owner.action(api.vouchers.attachFile, {
      storageId: sid,
      name: "   ",
      clientCapturedAt: 1_700_000_000_000,
      via: "app",
    });
    const v = await voucher(t, r.voucherId);
    expect(v.originalFiles[0]).toMatchObject({
      name: "beleg",
      capturedVia: "app",
      clientCapturedAt: 1_700_000_000_000,
    });
    // Replacing on a draft keeps the old file (replacedBy) and records the reason in the audit (VOU-122).
    await upload(t, owner, { voucherId: r.voucherId, replaceIndex: 0, reason: "Bessere Kopie" });
    const after = await voucher(t, r.voucherId);
    expect(after.originalFiles).toHaveLength(2);
    expect(after.originalFiles[0]?.replacedBy).toBeDefined();
    expect((await auditOf(t, "voucher.replace_file")).at(-1)?.reason).toBe("Bessere Kopie");
  });

  test("VOU-009 no file can be added to a cancelled voucher; an unknown voucher is not found", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    await owner.mutation(api.vouchers.cancel, { id, reason: "Doppelt erfasst" });
    const e = await errorOf(upload(t, owner, { voucherId: id }));
    expect(e).toMatchObject({ code: "invalid_input", message: "Der Beleg ist storniert." });
    const d = await draft(t, owner);
    await owner.mutation(api.vouchers.deleteDraft, { id: d });
    expect(await errorOf(owner.mutation(api.vouchers.checkedComplete, { id: d }))).toMatchObject({
      code: "not_found",
      message: "Der Beleg existiert nicht.",
    });
  });
});

describe("bulk actions and the Sammelbuchung job (VOU-101)", () => {
  test("VOU-101 an empty selection is refused by every bulk action", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    for (const p of [
      owner.mutation(api.vouchers.bulkUpdate, { ids: [], patch: { account: "6815" } }),
      owner.mutation(api.vouchers.bulkDelete, { ids: [] }),
      owner.mutation(api.vouchers.startBulkFinalize, { ids: [] }),
    ]) {
      expect(await errorOf(p)).toMatchObject({
        code: "invalid_input",
        message: "Bitte mindestens einen Beleg auswählen.",
      });
    }
  });

  test("VOU-101 tags and a cleared cost centre are applied in bulk; a deleted draft is skipped under its id", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const tag = await t.model(OWNER, (ctx) => saveTag(ctx, { name: "Reise" }));
    const a = await draft(t, owner, { lines: [line({ costCenterId: "kst-1" })] });
    const gone = await draft(t, owner);
    await owner.mutation(api.vouchers.deleteDraft, { id: gone });
    const r = await owner.mutation(api.vouchers.bulkUpdate, {
      ids: [a, gone],
      patch: { costCenterId: null, addTagIds: [tag] },
    });
    expect(r.updated).toEqual([a]);
    expect(r.skipped).toEqual([{ id: gone, label: gone, reason: expect.stringContaining("Nur Entwürfe") }]);
    expect((await voucher(t, a)).tags).toEqual([tag]);
    expect((await linesOf(t, a)).map((l) => [l.account, l.costCenterId])).toEqual([["6805", undefined]]);
    // Adding the same tag again changes no tags (only the version of the lines).
    await owner.mutation(api.vouchers.bulkUpdate, { ids: [a], patch: { addTagIds: [tag] } });
    expect((await voucher(t, a)).tags).toEqual([tag]);
    const del = await owner.mutation(api.vouchers.bulkDelete, { ids: [gone] });
    expect(del).toEqual({
      deleted: [],
      skipped: [{ id: gone, label: gone, reason: "Gebuchte Belege können nicht gelöscht werden." }],
    });
  });

  test("VOU-101 the job labels drafts by supplier, number or „Entwurf“; booked and deleted ones are skipped; a finished job is not rerun", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const done = await booked(t, owner);
    const numbered = await owner.mutation(api.vouchers.create, { input: { documentNumber: "NR-1" } });
    const blank = await owner.mutation(api.vouchers.create, { input: {} });
    const gone = await owner.mutation(api.vouchers.create, { input: {} });
    await owner.mutation(api.vouchers.deleteDraft, { id: gone });
    const { jobId } = await owner.mutation(api.vouchers.startBulkFinalize, { ids: [done, numbered, blank, gone] });
    const job0 = await t.run((ctx) => ctx.db.get(jobId));
    expect((job0?.params as { labels?: Record<string, string> } | undefined)?.labels).toEqual({
      [done]: "Büro Schmidt GmbH",
      [numbered]: "NR-1",
      [blank]: "Entwurf",
      [gone]: "Entwurf",
    });
    await t.finishAllScheduledFunctions(() => {});
    const job = await t.run((ctx) => ctx.db.get(jobId));
    expect(job?.status).toBe("done");
    const reasons = Object.fromEntries((job?.skipped ?? []).map((s) => [s.id, s.reason]));
    expect(reasons[done]).toBe("Der Beleg ist bereits gebucht.");
    expect(reasons[gone]).toBe("Der Beleg existiert nicht.");
    expect(reasons[blank]).toBeDefined();
    // bulkFinalizeInput answers null for a finished job → the action does nothing.
    expect(await t.query(internal.vouchers.bulkFinalizeInput, { jobId })).toBeNull();
    expect(await t.action(internal.vouchers.bulkFinalizeJob, { jobId })).toBe(false);
  });

  test("VOU-101 a cancelled Sammelbuchung books nothing", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const a = await draft(t, owner);
    vi.useFakeTimers(); // the scheduled run must not start before the cancel
    try {
      const { jobId } = await owner.mutation(api.vouchers.startBulkFinalize, { ids: [a] });
      await owner.mutation(api.jobs.cancel, { id: jobId });
      expect(await t.action(internal.vouchers.bulkFinalizeJob, { jobId })).toBe(false);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await t.run((ctx) => ctx.db.get(jobId)))?.status).toBe("cancelled");
    } finally {
      vi.useRealTimers();
    }
    expect((await voucher(t, a)).status).toBe("draft");
  });
});

describe("correction, cancellation, duplication (VOU-008, VOU-009, EC-VOU-19, EC-VOU-21)", () => {
  test("VOU-008 VOU-009 EC-VOU-21 a draft can be neither corrected nor cancelled; a booked one is neither edited as draft nor deleted", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const d = await draft(t, owner);
    expect(
      await errorOf(owner.mutation(api.vouchers.correct, { id: d, input: {}, reason: "Konto falsch" })),
    ).toMatchObject({ code: "invalid_input", message: "Der Beleg ist nicht gebucht." });
    expect(await errorOf(owner.mutation(api.vouchers.cancel, { id: d, reason: "Doppelt erfasst" }))).toMatchObject({
      code: "invalid_input",
      message: "Der Beleg ist nicht gebucht.",
    });
    await owner.mutation(api.vouchers.finalize, { id: d });
    const e = await errorOf(owner.mutation(api.vouchers.updateDraft, { id: d, input: { internalNote: "x" } }));
    expect(e).toMatchObject({ code: "invalid_input", data: { reason: "NOT_DRAFT" } });
    expect(await errorOf(owner.mutation(api.vouchers.deleteDraft, { id: d }))).toMatchObject({
      code: "immutable_record",
      message: "Gebuchte Belege können nicht gelöscht werden.",
    });
  });

  test("VOU-009 EC-VOU-19 the Storno needs a reason; a second Storno is already reversed; a cancelled voucher cannot be corrected", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    expect(await errorOf(owner.mutation(api.vouchers.cancel, { id, reason: " ab " }))).toMatchObject({
      code: "invalid_input",
      message: "Bitte einen Grund angeben (mindestens 5 Zeichen).",
    });
    await owner.mutation(api.vouchers.cancel, { id, reason: "Doppelt erfasst" });
    expect(await errorOf(owner.mutation(api.vouchers.cancel, { id, reason: "Noch einmal" }))).toMatchObject({
      code: "already_reversed",
      message: "Der Beleg ist storniert.",
    });
    expect(
      await errorOf(owner.mutation(api.vouchers.correct, { id, input: {}, reason: "Konto falsch" })),
    ).toMatchObject({ code: "invalid_input", message: "Der Beleg ist storniert." });
    expect(await voucher(t, id)).toMatchObject({
      status: "cancelled",
      cancelReason: "Doppelt erfasst",
      openAmountCents: 0,
    });
  });

  test("VOU-008 acknowledged warnings of a correction are kept on the voucher (deduplicated)", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await booked(t, owner);
    const r = await owner.mutation(api.vouchers.correct, {
      id,
      input: { lines: [line({ account: "6815", description: "Bürobedarf" })] },
      reason: "Konto falsch gewählt",
      acknowledgeWarnings: ["eigene_bestaetigung", "eigene_bestaetigung"],
    });
    expect(r.version).toBeGreaterThan(1);
    expect((await voucher(t, id)).acknowledgedWarnings).toEqual(["eigene_bestaetigung"]);
    expect((await linesOf(t, id)).map((l) => l.account)).toEqual(["6815"]);
    expect((await auditOf(t, "voucher.correct")).some((a) => a.reason === "Konto falsch gewählt")).toBe(true);
  });

  test("VOU-009 „Duplizieren“ copies every header field, the lines and the active files; a bare draft copies minimal data", async () => {
    const t = makeT();
    const { supplier } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, {
      supplierContactId: supplier,
      supplierTaxNumber: "27/123/45678",
      supplierIban: "DE02120300000000202051",
      supplyDate: { kind: "date", date: TODAY },
      dueDate: TODAY,
      internalNote: "Kopie prüfen",
    });
    const copy = await owner.mutation(api.vouchers.duplicate, { id });
    const [v, c] = [await voucher(t, id), await voucher(t, copy)];
    for (const k of [
      "supplierContactId",
      "supplierName",
      "supplierVatId",
      "supplierTaxNumber",
      "supplierAddress",
      "supplierIban",
      "documentNumber",
      "documentDate",
      "supplyDate",
      "dueDate",
      "internalNote",
      "taxRule",
      "priceMode",
    ] as const) {
      expect(c[k]).toEqual(v[k]);
    }
    expect(c.status).toBe("draft");
    expect(c.duplicateDismissals).toEqual([id]);
    expect(c.originalFiles.map((f) => f.sha256)).toEqual(v.originalFiles.map((f) => f.sha256));
    const bare = await owner.mutation(api.vouchers.create, { input: { direction: "income" } });
    expect((await voucher(t, bare)).taxRule).toBe("not_taxable"); // VOU-010 income default rule
    const bareCopy = await voucher(t, await owner.mutation(api.vouchers.duplicate, { id: bare }));
    expect(bareCopy).toMatchObject({ direction: "income", originalFiles: [], status: "draft" });
    expect(bareCopy.supplierName).toBeUndefined();
    expect(bareCopy.documentDate).toBeUndefined();
  });

  test("VOU-053 „Keine Dublette“ is stored once (a second dismissal is a no-op)", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const a = await draft(t, owner);
    const b = await draft(t, owner);
    await owner.mutation(api.vouchers.dismissDuplicateOf, { id: a, otherId: b });
    await owner.mutation(api.vouchers.dismissDuplicateOf, { id: a, otherId: b });
    expect((await voucher(t, a)).duplicateDismissals).toEqual([b]);
    expect(await auditOf(t, "voucher.duplicate_dismiss")).toHaveLength(1);
  });
});

describe("receipt waiver (VOU-110)", () => {
  test("VOU-110 „Beleg nicht erforderlich“ needs a reason, an existing transaction and is recorded once", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const tx = await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: -500, purpose: "Kontoführung" });
    expect(
      await errorOf(owner.mutation(api.vouchers.waiveReceipt, { transactionId: tx, reason: "  kurz " })),
    ).toMatchObject({ code: "invalid_input", message: "Bitte einen Grund angeben (mindestens 5 Zeichen)." });
    const first = await owner.mutation(api.vouchers.waiveReceipt, { transactionId: tx, reason: "Kontoauszug genügt" });
    const again = await owner.mutation(api.vouchers.waiveReceipt, { transactionId: tx, reason: "Noch ein Grund" });
    expect(again).toBe(first);
    expect(await auditOf(t, "voucher.receipt_waive")).toHaveLength(1);
    const other = await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: -700, purpose: "Gebühr" });
    await t.run((ctx) => ctx.db.delete(other));
    expect(
      await errorOf(owner.mutation(api.vouchers.waiveReceipt, { transactionId: other, reason: "Kontoauszug genügt" })),
    ).toMatchObject({ code: "not_found", message: "Der Bankumsatz existiert nicht." });
  });
});

describe("Bewirtung and Eigenbeleg approval guards (VOU-060…063, EC-EIG-02, EC-EIG-04)", () => {
  const bewirtung = {
    occasionType: "geschaeftlich" as const,
    occasion: "Projektbesprechung Website-Relaunch mit Müller GmbH",
    participants: ["Anna Müller (Müller GmbH)", "Max Mustermann"],
    host: "Max Mustermann",
    place: "Restaurant Adler, Berlin",
    date: TODAY,
    tseConfirmed: true,
  };
  const eigen = { reason: "not_obtainable" as const, recipient: "Parkhaus Mitte", purpose: "Kundentermin Müller GmbH" };
  const fileRef = {
    storageId: "x" as Id<"_storage">,
    sha256: "0".repeat(64),
    bytes: 1,
    mime: "application/pdf",
    name: "x.pdf",
  };
  const SYSTEM = { actor: "system:test", channel: "system" } as const;

  test("VOU-060 the Bewirtung step is refused for other kinds, cancelled and locked vouchers", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const standard = await draft(t, owner);
    expect(await errorOf(owner.query(api.vouchers.bewirtungContext, { id: standard, data: bewirtung }))).toMatchObject({
      code: "invalid_input",
      message: "Dieser Schritt gilt nur für Belege der Art Bewirtung.",
    });
    const locked = await draft(t, owner, { kind: "bewirtung" });
    await t.model(OWNER, (ctx) =>
      auditedPatch(ctx, "vouchers", locked, { lockedAt: Date.now() }, { action: "voucher.lock" }),
    );
    expect(await errorOf(owner.query(api.vouchers.bewirtungContext, { id: locked, data: bewirtung }))).toMatchObject({
      code: "immutable_record",
      message: "Der Beleg ist festgeschrieben und kann nicht geändert werden. Bitte stornieren und neu erfassen.",
    });
    const cancelled = await draft(t, owner, { kind: "bewirtung", lines: [line({ amountCents: 4321 })] });
    await owner.action(api.vouchers.approveBewirtungBeleg, { id: cancelled, data: bewirtung });
    await owner.mutation(api.vouchers.finalize, { id: cancelled });
    await owner.mutation(api.vouchers.cancel, { id: cancelled, reason: "Falsch erfasst" });
    expect(await errorOf(owner.query(api.vouchers.bewirtungContext, { id: cancelled, data: bewirtung }))).toMatchObject(
      { code: "invalid_input", message: "Der Beleg ist storniert." },
    );
  });

  test("VOU-062 the Eigenbeleg content of a Bewirtung without date, number or file uses today and the member's name", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner", { name: "Max Mustermann" });
    const id = await owner.mutation(api.vouchers.create, {
      input: {
        kind: "bewirtung",
        bewirtung,
        lines: [line({ account: "6640", description: "Speisen", amountCents: 5000, vatRateBp: 700 })],
      },
    });
    expect((await voucher(t, id)).bewirtung).toMatchObject({ host: "Max Mustermann", versions: [] });
    const c = await owner.query(api.vouchers.bewirtungContext, { id, data: bewirtung });
    expect(c.company.name).toBe("Muster Design");
    const text = JSON.stringify(c.content);
    expect(text).toContain("Max Mustermann");
    expect(text).toContain("Restaurant Adler");
  });

  test("VOU-060 the model refuses an approval by a non-human actor (Bewirtung and Eigenbeleg)", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, { kind: "bewirtung" });
    const e = await errorOf(t.model(SYSTEM, (ctx) => approveBewirtung(ctx, { id, data: bewirtung, file: fileRef })));
    expect(e).toMatchObject({
      code: "forbidden_role",
      message: "Die Freigabe eines Eigenbelegs ist eine persönliche Erklärung und nur in der App möglich.",
      data: { reason: "HUMAN_APPROVAL_REQUIRED" },
    });
    const e2 = await errorOf(t.model(SYSTEM, (ctx) => approveEigenbeleg(ctx, { id, data: eigen, file: fileRef })));
    expect(e2.code).toBe("forbidden_role");
    expect((await voucher(t, id)).bewirtung?.approvedAt).toBeUndefined();
  });

  test("VOU-062 a re-approval keeps the earlier version with its optional fields; the approved data cannot be edited in the draft", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    // A standard draft becomes a Bewirtung in the editor (no earlier versions).
    await owner.mutation(api.vouchers.updateDraft, { id, input: { kind: "bewirtung", bewirtung } });
    expect((await voucher(t, id)).bewirtung?.versions).toEqual([]);
    await owner.action(api.vouchers.approveBewirtungBeleg, {
      id,
      data: { ...bewirtung, hostOnInvoiceConfirmed: true },
    });
    const edit = await errorOf(owner.mutation(api.vouchers.updateDraft, { id, input: { bewirtung } }));
    expect(edit).toMatchObject({ code: "immutable_record", data: { reason: "ALREADY_APPROVED" } });
    await owner.action(api.vouchers.approveBewirtungBeleg, {
      id,
      data: { ...bewirtung, tipCents: 500 },
      reason: "Trinkgeld ergänzt",
    });
    const v = await voucher(t, id);
    expect(v.bewirtung?.tipCents).toBe(500);
    expect(v.bewirtung?.versions).toHaveLength(1);
    expect(v.bewirtung?.versions[0]?.data).toMatchObject({ hostOnInvoiceConfirmed: true });
    expect(v.bewirtung?.versions[0]?.data.tipCents).toBeUndefined();
    expect(v.bewirtung?.versions[0]?.reason).toBe("Trinkgeld ergänzt");
  });

  test("EC-EIG-02 EC-EIG-04 the Eigenbeleg step: other kinds, missing fields, a missing date, booked and approved vouchers", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const standard = await draft(t, owner);
    expect(await errorOf(owner.query(api.vouchers.eigenbelegContext, { id: standard, data: eigen }))).toMatchObject({
      code: "invalid_input",
      message: "Dieser Schritt gilt nur für Belege der Art Eigenbeleg.",
    });
    const undated = await owner.mutation(api.vouchers.create, {
      input: {
        kind: "eigenbeleg",
        eigenbeleg: eigen,
        taxRule: "no_input_vat",
        lines: [line({ account: "6673", description: "Parkautomat", amountCents: 400, vatRateBp: 0 })],
      },
    });
    expect((await voucher(t, undated)).eigenbeleg).toMatchObject({ recipient: "Parkhaus Mitte" });
    expect(
      await errorOf(owner.query(api.vouchers.eigenbelegContext, { id: undated, data: { ...eigen, recipient: " " } })),
    ).toMatchObject({
      code: "invalid_input",
      message: "Bitte Empfänger, Zweck und Grund für das Fehlen des Originalbelegs angeben.",
      data: { reason: "EIGENBELEG_FIELDS" },
    });
    expect(await errorOf(owner.query(api.vouchers.eigenbelegContext, { id: undated, data: eigen }))).toMatchObject({
      code: "invalid_input",
      message: "Bitte zuerst das Datum der Ausgabe angeben.",
    });
    await owner.mutation(api.vouchers.updateDraft, { id: undated, input: { documentDate: TODAY } });
    const c = await owner.query(api.vouchers.eigenbelegContext, { id: undated, data: eigen });
    expect(JSON.stringify(c.content)).toContain("Parkhaus Mitte");
    // An API key cannot approve (personal declaration).
    const key = await t.asApiKey(["vouchers:write", "vouchers:read"]);
    expect((await errorOf(key.action(api.vouchers.approveEigenbelegBeleg, { id: undated, data: eigen }))).code).toBe(
      "forbidden_role",
    );
    await owner.action(api.vouchers.approveEigenbelegBeleg, { id: undated, data: eigen });
    const edit = await errorOf(owner.mutation(api.vouchers.updateDraft, { id: undated, input: { eigenbeleg: eigen } }));
    expect(edit).toMatchObject({
      code: "immutable_record",
      message: "Der Eigenbeleg ist freigegeben und unveränderbar.",
      data: { reason: "ALREADY_APPROVED" },
    });
    await owner.mutation(api.vouchers.finalize, { id: undated });
    expect(await errorOf(owner.query(api.vouchers.eigenbelegContext, { id: undated, data: eigen }))).toMatchObject({
      code: "invalid_input",
      data: { reason: "NOT_DRAFT" },
    });
  });
});

describe("recurring vouchers (VOU-064, EC-VOU-33)", () => {
  const template = {
    direction: "expense" as const,
    kind: "standard" as const,
    supplierName: "Vermieter GmbH",
    currency: "EUR",
    priceMode: "gross" as const,
    taxRule: "no_input_vat" as const,
    lines: [line({ account: "6310", description: "Miete", amountCents: 80_000, vatRateBp: 0 })],
  };

  test("VOU-064 an inactive template shows no upcoming dates; the cron is a no-op in tests unless forced", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const first = `${YEAR}-01-01`;
    const rid = await owner.mutation(api.vouchers.createRecurring, {
      name: "Miete Büro",
      template,
      interval: "P1Y",
      firstDate: first,
      createAs: "draft",
    });
    const paused = await owner.mutation(api.vouchers.createRecurring, {
      name: "Pausiert",
      template,
      interval: "P1M",
      firstDate: TODAY,
      createAs: "draft",
    });
    const pr = await t.run((ctx) => ctx.db.get(paused));
    await owner.mutation(api.vouchers.updateRecurring, { id: paused, version: pr?.version, patch: { active: false } });
    const list = await owner.query(api.vouchers.recurringList, {});
    expect(list.find((r) => r._id === paused)?.upcoming).toEqual([]);
    expect(list.find((r) => r._id === rid)?.upcoming.length).toBe(3);
    expect(await t.action(internal.vouchers.generateRecurringCron, {})).toEqual({
      templates: 0,
      created: 0,
      failed: 0,
    });
    const r = await t.action(internal.vouchers.generateRecurringCron, { force: true });
    expect(r).toEqual({ templates: 1, created: 1, failed: 0 });
    const made = await t.run((ctx) =>
      ctx.db
        .query("vouchers")
        .filter((q) => q.eq(q.field("recurringVoucherId"), rid))
        .collect(),
    );
    expect(made.map((v) => [v.status, v.documentDate])).toEqual([["draft", first]]);
  });
});
