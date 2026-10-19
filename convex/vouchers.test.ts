import { describe, expect, test } from "vitest";
import { ersetzendesScannen } from "../src/domain/docs/ersetzendes-scannen";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { auditedInsert, auditedPatch } from "./model/audit";
import { postJournalEntry } from "./model/journal";
import { bookedTransaction } from "./payments.fixtures";
import { makeT, type TestT } from "./test.setup";
import { header, line, OWNER, pdfBytes, setupCompany, TODAY, upload, YEAR } from "./vouchers.fixtures";

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
const entriesOf = (t: TestT, id: string, kind: "voucher" | "payment" = "voucher") =>
  t.run((ctx) =>
    ctx.db
      .query("journalEntries")
      .withIndex("by_source", (q) => q.eq("source.kind", kind).eq("source.id", id))
      .collect(),
  );
const accountsOf = (e: Doc<"journalEntries">) =>
  e.lines.map((l) => [l.account, l.debitCents > 0 ? "S" : "H", l.debitCents || l.creditCents] as const);

/** A draft with a file and a complete header (owner, UI). */
async function draft(t: TestT, owner: Awaited<ReturnType<TestT["asUser"]>>, over: Record<string, unknown> = {}) {
  const { voucherId } = await upload(t, owner);
  await owner.mutation(api.vouchers.updateDraft, { id: voucherId, input: header(over) });
  return voucherId;
}

async function openingCash(t: TestT, cents: number) {
  await t.model(OWNER, (ctx) =>
    postJournalEntry(ctx, {
      kind: "opening_balance",
      fiscalYear: YEAR,
      date: `${YEAR}-01-01`,
      part: { kind: "cash", amountCents: cents },
    }),
  );
}

describe("capture and drafts (VOU-001, VOU-120…122)", () => {
  test("VOU-120 GOBD-08 VOU-001 upload creates a draft with capture metadata; the header and lines compute totals", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const bytes = pdfBytes("vou-120");
    const { voucherId, index } = await upload(t, owner, { bytes, name: "Telekom.pdf" });
    expect(index).toBe(0);
    const v0 = await voucher(t, voucherId);
    expect(v0.status).toBe("draft");
    expect(v0.originalFiles[0]).toMatchObject({
      name: "Telekom.pdf",
      mime: "application/pdf",
      bytes: bytes.byteLength,
      pages: 1,
      role: "original",
      capturedVia: "upload",
    });
    expect(v0.originalFiles[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v0.originalFiles[0]?.capturedBy).toMatch(/^user:/);
    await owner.mutation(api.vouchers.updateDraft, {
      id: voucherId,
      version: v0.version,
      input: header({ lines: [line(), line({ account: "6815", amountCents: 1070, vatRateBp: 700 })] }),
    });
    const v1 = await voucher(t, voucherId);
    expect(v1.totals).toMatchObject({ netCents: 11_000, vatCents: 1970, grossCents: 12_970 });
    expect(v1.version).toBe(2);
    const stale = await errorOf(
      owner.mutation(api.vouchers.updateDraft, { id: voucherId, version: 1, input: { internalNote: "x" } }),
    );
    expect(stale.code).toBe("conflict");
  });

  test("VOU-120 EC-INB-01 an executable renamed to .pdf is rejected and removed from storage", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const e = await errorOf(upload(t, owner, { bytes: new TextEncoder().encode("MZ\u0090\u0000 fake exe") }));
    expect(e.code).toBe("invalid_input");
    expect(await t.run((ctx) => ctx.db.query("vouchers").collect())).toHaveLength(0);
  });

  test("VOU-007 drafts are deleted with an audit entry carrying the content", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    await owner.mutation(api.vouchers.deleteDraft, { id });
    expect(await voucher(t, id)).toBeNull();
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "voucher.delete_draft"))
        .collect(),
    );
    expect(
      audit.some(
        (a) => (a.diff as { before?: { supplierName?: string } }).before?.supplierName === "Büro Schmidt GmbH",
      ),
    ).toBe(true);
  });
});

describe("booking (VOU-007, VOU-026, VOU-136)", () => {
  test("VOU-007 GOBD-05 „Buchen“ assigns BE-YYYY-00001 gaplessly, posts V1 on SKR04 and learns the supplier profile", async () => {
    const t = makeT();
    const { supplier } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, { supplierContactId: supplier });
    const r = await owner.mutation(api.vouchers.finalize, { id });
    expect(r.number).toBe(`BE-${YEAR}-00001`);
    expect(r.status).toBe("open");
    const v = await voucher(t, id);
    expect(v).toMatchObject({
      internalNumber: `BE-${YEAR}-00001`,
      openAmountCents: 11_900,
      taxRule: "input_vat_deductible",
    });
    const [entry] = await entriesOf(t, id);
    expect(entry?.explanation).toBe("V1");
    expect(accountsOf(entry as Doc<"journalEntries">)).toEqual([
      ["6805", "S", 10_000],
      ["1406", "S", 1900],
      ["3300", "H", 11_900],
    ]);
    const profile = await t.run((ctx) => ctx.db.query("supplierProfiles").collect());
    expect(profile[0]).toMatchObject({ key: "vat:DE123456789", lastAccount: "6805", uses: 1, accountStreak: 1 });
    const second = await draft(t, owner, { lines: [line({ amountCents: 5950 })] });
    expect((await owner.mutation(api.vouchers.finalize, { id: second })).number).toBe(`BE-${YEAR}-00002`);
    const again = await errorOf(owner.mutation(api.vouchers.finalize, { id }));
    expect(again.data.reason).toBe("ALREADY_BOOKED");
  });

  test("VOU-007 VOU-121 EC-VOU-01 RI-21 a voucher without original file or Eigenbeleg cannot be booked (no number consumed)", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await owner.mutation(api.vouchers.create, { input: header() });
    const e = await errorOf(owner.mutation(api.vouchers.finalize, { id }));
    expect(e.message).toContain("Jede Buchung braucht einen Beleg.");
    expect(await t.run((ctx) => ctx.db.query("numberRegister").collect())).toHaveLength(0);
  });

  test("VOU-006 VOU-007 ⚑ „Vorsteuerabzug gefährdet“ must be acknowledged and is recorded on the voucher", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, {
      supplierVatId: undefined,
      documentNumber: undefined,
      lines: [line({ amountCents: 59_500 })],
    });
    const e = await errorOf(owner.mutation(api.vouchers.finalize, { id }));
    expect(e.data.reason).toBe("WARNINGS_UNACKNOWLEDGED");
    await owner.mutation(api.vouchers.finalize, { id, acknowledgeWarnings: ["input_vat_at_risk"] });
    const v = await voucher(t, id);
    expect(v.inputVatAtRisk).toEqual(["Steuernummer oder USt-IdNr des Lieferanten", "Rechnungsnummer"]);
    expect(v.acknowledgedWarnings).toEqual(["input_vat_at_risk"]);
  });

  test("VOU-026 KU-01 a Kleinunternehmer books input_vat_deductible as no_input_vat: gross to expense (V4)", async () => {
    const t = makeT();
    await setupCompany(t, { ku: true });
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, { taxRule: "input_vat_deductible" });
    const r = await owner.mutation(api.vouchers.finalize, { id });
    expect(r.infos.map((i) => i.code)).toEqual(["ku_no_input_vat"]);
    expect((await voucher(t, id)).taxRule).toBe("no_input_vat");
    const [entry] = await entriesOf(t, id);
    expect(entry?.explanation).toBe("V4");
    expect(accountsOf(entry as Doc<"journalEntries">)).toEqual([
      ["6805", "S", 11_900],
      ["3300", "H", 11_900],
    ]);
  });

  test("VOU-022 VOU-026 golden V2: KU company, Google Ireland reverse charge → 190 output VAT, not deductible", async () => {
    const t = makeT();
    await setupCompany(t, { ku: true });
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, {
      supplierName: "Google Ireland Ltd.",
      supplierVatId: "IE6388047V",
      taxRule: "reverse_charge_eu",
      priceMode: "net",
      lines: [line({ account: "6600", description: "Google Ads", amountCents: 100_000, vatRateBp: 1900 })],
    });
    await owner.mutation(api.vouchers.finalize, { id });
    const v = await voucher(t, id);
    expect(v.totals).toMatchObject({ grossCents: 100_000, selfAssessedVatCents: 19_000 });
    expect(v.openAmountCents).toBe(100_000);
    const [entry] = await entriesOf(t, id);
    expect(entry?.explanation).toBe("V6-ku");
    expect(accountsOf(entry as Doc<"journalEntries">)).toEqual([
      ["6600", "S", 100_000],
      ["3837", "H", 19_000],
      ["6860", "S", 19_000],
      ["3300", "H", 100_000],
    ]);
  });

  test("VOU-136 VOU-133 card_pending books the voucher as „Vorgemerkt“ (scheduled) without a payment", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    const r = await owner.mutation(api.vouchers.finalize, { id, payment: { method: "card_pending" } });
    expect(r.status).toBe("scheduled");
    expect(await t.run((ctx) => ctx.db.query("payments").collect())).toHaveLength(0);
  });

  test("VOU-007 MCP-safety: voucher_finalize via MCP needs a confirm token; viewers cannot book", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    const mcp = await t.asMcp(["vouchers:write", "vouchers:read"]);
    expect((await errorOf(mcp.mutation(api.vouchers.finalize, { id }))).code).toBe("confirm_token_required");
    const viewer = await t.asUser("viewer");
    expect((await errorOf(viewer.mutation(api.vouchers.finalize, { id }))).code).toBe("forbidden_role");
    const auditor = await t.asUser("auditor", { auditor: { purpose: "Prüfung", fiscalYears: [YEAR] } });
    expect((await auditor.query(api.vouchers.get, { id }))?.voucher._id).toBe(id);
  });
});

describe("„Bezahlt mit“ cash and private (VOU-137, VOU-138, CSH-022/023, EC-151)", () => {
  test("VOU-137 CSH-022 „Bar bezahlt“ writes voucher, journal (T6) and payment in one transaction → paid", async () => {
    const t = makeT();
    await setupCompany(t);
    await openingCash(t, 50_000);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    const r = await owner.mutation(api.vouchers.finalize, { id, payment: { method: "cash" } });
    expect(r.status).toBe("paid");
    const [p] = await t.run((ctx) => ctx.db.query("payments").collect());
    expect(p).toMatchObject({ target: { kind: "voucher", id }, source: { kind: "cash" }, amountCents: 11_900 });
    const [pe] = await entriesOf(t, p?._id as string, "payment");
    expect(pe?.explanation).toBe("T6");
    expect(accountsOf(pe as Doc<"journalEntries">)).toEqual([
      ["3300", "S", 11_900],
      ["1600", "H", 11_900],
    ]);
    expect((await voucher(t, id)).openAmountCents).toBe(0);
  });

  test("EC-151 CSH-026 VOU-137 two cash vouchers that jointly exceed the till: the second aborts and books nothing", async () => {
    const t = makeT();
    await setupCompany(t);
    await openingCash(t, 15_000);
    const owner = await t.asUser("owner");
    const a = await draft(t, owner);
    const b = await draft(t, owner, { lines: [line({ amountCents: 9000 })] });
    await owner.mutation(api.vouchers.finalize, { id: a, payment: { method: "cash" } });
    const e = await errorOf(owner.mutation(api.vouchers.finalize, { id: b, payment: { method: "cash" } }));
    expect(e.code).toBe("cash_negative");
    const vb = await voucher(t, b);
    expect(vb.status).toBe("draft");
    expect(vb.internalNumber).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("numberRegister").collect())).toHaveLength(1);
  });

  test("VOU-137 EC-VOU-41 a cash payment 12 days back needs a reason (stored and audited)", async () => {
    const t = makeT();
    await setupCompany(t);
    await openingCash(t, 50_000);
    const owner = await t.asUser("owner");
    const back = new Date(Date.now() - 12 * 86_400_000).toISOString().slice(0, 10);
    const id = await draft(t, owner, { documentDate: back });
    const e = await errorOf(owner.mutation(api.vouchers.finalize, { id, payment: { method: "cash" } }));
    expect(e.data.reason).toBe("BACKDATE_REASON_REQUIRED");
    await owner.mutation(api.vouchers.finalize, {
      id,
      payment: { method: "cash", backdateReason: "Beleg lag im Auto" },
      acknowledgeWarnings: ["cash_backdated"],
    });
    const [p] = await t.run((ctx) => ctx.db.query("payments").collect());
    expect(p?.backdateReason).toBe("Beleg lag im Auto");
  });

  test("VOU-138 CSH-023 „Privat bezahlt“ posts payable against Privateinlagen (T7)", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id, payment: { method: "private" } });
    const [p] = await t.run((ctx) => ctx.db.query("payments").collect());
    const [pe] = await entriesOf(t, p?._id as string, "payment");
    expect(pe?.explanation).toBe("T7");
    expect(accountsOf(pe as Doc<"journalEntries">)).toEqual([
      ["3300", "S", 11_900],
      ["2180", "H", 11_900],
    ]);
  });

  test("VOU-138 EC-VOU-42 E-ACC-30 for a GmbH „Privat bezahlt“ needs the shareholder clearing account — unmapped → nothing booked", async () => {
    const t = makeT();
    await setupCompany(t, { legalForm: "gmbh" });
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    const e = await errorOf(owner.mutation(api.vouchers.finalize, { id, payment: { method: "private" } }));
    expect(e.code).toBe("role_unmapped");
    expect((await voucher(t, id)).status).toBe("draft");
  });
});

describe("bank payments, Skonto and „Zahlung umbuchen“ (VOU-131, VOU-132, VOU-139)", () => {
  test("VOU-131 a bank debit is suggested and linked → paid; the transaction is matched", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id });
    const tx = await bookedTransaction(t, bank, {
      bookingDate: TODAY,
      amountCents: -11_900,
      purpose: "Büro Schmidt Rechnung",
      counterpartyName: "Büro Schmidt GmbH",
    });
    const s = await owner.query(api.vouchers.bankSuggestions, { id });
    expect(s.suggestions[0]).toMatchObject({ transactionId: tx, reasons: expect.arrayContaining(["Betrag", "Name"]) });
    expect(s.alreadySettled).toBeNull();
    await owner.mutation(api.vouchers.recordPayment, { id, method: "bank", transactionId: tx });
    expect((await voucher(t, id)).status).toBe("paid");
    const t1 = await t.run((ctx) => ctx.db.get(tx));
    expect(t1).toMatchObject({ status: "matched", allocatedCents: 11_900 });
  });

  test("VOU-132 UST-32 Skonto received on a voucher corrects input VAT per rate (V2+V3)", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id });
    const tx = await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: -11_662, purpose: "Skonto 2 %" });
    const r = await owner.mutation(api.vouchers.recordPayment, {
      id,
      method: "bank",
      transactionId: tx,
      differences: [{ reason: "skonto", amountCents: 238 }],
    });
    const [pe] = await entriesOf(t, r.paymentId, "payment");
    expect(pe?.explanation).toBe("V2+V3");
    expect(accountsOf(pe as Doc<"journalEntries">)).toEqual([
      ["3300", "S", 11_900],
      ["5736", "H", 200],
      ["1406", "H", 38],
      ["1800", "H", 11_662],
    ]);
    expect((await voucher(t, id)).status).toBe("paid");
  });

  test("VOU-139 EC-VOU-43 a bank debit for a voucher paid in cash: „Bereits als bar bezahlt erfasst“ → „Zahlung umbuchen“", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    await openingCash(t, 50_000);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id, payment: { method: "cash" } });
    const tx = await bookedTransaction(t, bank, {
      bookingDate: TODAY,
      amountCents: -11_900,
      purpose: "Kartenzahlung Büro Schmidt",
      counterpartyName: "Büro Schmidt GmbH",
    });
    const s = await owner.query(api.vouchers.bankSuggestions, { id });
    expect(s.alreadySettledLabel).toBe("Bereits als bar bezahlt erfasst");
    expect(s.suggestions[0]?.transactionId).toBe(tx);
    // Not offered as a payment: the voucher is paid.
    expect(
      (await errorOf(owner.mutation(api.vouchers.recordPayment, { id, method: "bank", transactionId: tx }))).data
        .reason,
    ).toBe("VOUCHER_NOT_OPEN");
    const r = await owner.mutation(api.vouchers.rebookPayment, { id, transactionId: tx, reason: "War Kartenzahlung" });
    expect(r.reversalIds).toHaveLength(1);
    const rows = await t.run((ctx) => ctx.db.query("payments").collect());
    expect(rows.map((p) => [p.source.kind, p.amountCents])).toEqual([
      ["cash", 11_900],
      ["cash", -11_900],
      ["bank", 11_900],
    ]);
    expect((await voucher(t, id)).status).toBe("paid");
  });
});

describe("correction and cancellation (VOU-008, VOU-009)", () => {
  test("VOU-008 GOBD-06 correcting a booked voucher reverses (same period, original tax points) and re-posts; version + 1, reason audited", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id });
    const v1 = await voucher(t, id);
    expect((await errorOf(owner.mutation(api.vouchers.correct, { id, input: {}, reason: "x" }))).message).toContain(
      "Grund",
    );
    await owner.mutation(api.vouchers.correct, {
      id,
      version: v1.version,
      input: { lines: [line({ account: "6815" })] },
      reason: "Falsches Konto",
    });
    const entries = (await entriesOf(t, id)).sort((a, b) => a.seq - b.seq);
    expect(entries.map((e) => e.explanation)).toEqual(["V1", "V-correction", "V1"]);
    expect(entries[1]?.date).toBe(entries[0]?.date);
    expect(entries[2]?.lines[0]?.account).toBe("6815");
    const v2 = await voucher(t, id);
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.journalEntryIds).toHaveLength(3);
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "voucher.correct"))
        .collect(),
    );
    expect(audit.some((a) => a.reason === "Falsches Konto")).toBe(true);
  });

  test("VOU-009 GOBD-06 after the period is locked: no correction; „Stornieren“ reverses in the open period; lines are frozen", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id });
    await t.model(OWNER, (ctx) =>
      auditedPatch(ctx, "vouchers", id, { lockedAt: Date.now() }, { action: "voucher.lock" }),
    );
    const e = await errorOf(
      owner.mutation(api.vouchers.correct, { id, input: { internalNote: "x" }, reason: "Korrektur" }),
    );
    expect(e.code).toBe("immutable_record");
    const [l] = await t.run((ctx) => ctx.db.query("voucherLines").collect());
    const frozen = await errorOf(
      t.model(OWNER, (ctx) =>
        auditedPatch(
          ctx,
          "voucherLines",
          l?._id as Id<"voucherLines">,
          { account: "6815" },
          { action: "voucher.correct" },
        ),
      ),
    );
    expect(frozen.code).toBe("immutable_record");
    await owner.mutation(api.vouchers.cancel, { id, reason: "Doppelt erfasst" });
    const v = await voucher(t, id);
    expect(v).toMatchObject({ status: "cancelled", cancelReason: "Doppelt erfasst", openAmountCents: 0 });
    const entries = (await entriesOf(t, id)).sort((a, b) => a.seq - b.seq);
    expect(entries.map((x) => x.explanation)).toEqual(["V1", "V-storno"]);
    expect(entries[1]?.date).toBe(TODAY);
    // „Duplizieren“: a new draft with the same data and files, not flagged as duplicate of the cancelled one.
    const copy = await owner.mutation(api.vouchers.duplicate, { id });
    const c = await voucher(t, copy);
    expect(c).toMatchObject({ status: "draft", supplierName: "Büro Schmidt GmbH", duplicateDismissals: [id] });
    expect(c.originalFiles[0]?.sha256).toBe(v.originalFiles[0]?.sha256);
  });

  test("VOU-009 a voucher with payments cannot be cancelled before the payments are reversed", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id, payment: { method: "private" } });
    expect((await errorOf(owner.mutation(api.vouchers.cancel, { id, reason: "Storno bitte" }))).data.reason).toBe(
      "ACTIVE_PAYMENTS",
    );
  });

  test("VOU-122 EC-161 replacing a booked voucher's file needs a reason and keeps the old version; after lock only additions", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id });
    const noReason = await errorOf(upload(t, owner, { voucherId: id, replaceIndex: 0 }));
    expect(noReason.message).toBe("Bitte angeben, warum die Datei ersetzt wird.");
    await upload(t, owner, { voucherId: id, replaceIndex: 0, reason: "Scan unleserlich" });
    const v = await voucher(t, id);
    expect(v.originalFiles).toHaveLength(2);
    expect(v.originalFiles[0]).toMatchObject({ replacedBy: 1 });
    expect(v.originalFiles[1]).toMatchObject({ replaceReason: "Scan unleserlich" });
    await t.model(OWNER, (ctx) =>
      auditedPatch(ctx, "vouchers", id, { lockedAt: Date.now() }, { action: "voucher.lock" }),
    );
    const locked = await errorOf(upload(t, owner, { voucherId: id, replaceIndex: 1, reason: "Nochmal" }));
    expect(locked.message).toBe("Originaldateien festgeschriebener Belege können nicht ersetzt werden.");
    await upload(t, owner, { voucherId: id });
    expect((await voucher(t, id)).originalFiles).toHaveLength(3);
  });
});

describe("duplicates (VOU-050…053, EC-160)", () => {
  test("VOU-050 EC-160 the same file uploaded twice is a strong duplicate that blocks booking until dismissed", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const bytes = pdfBytes("same-file");
    const { voucherId: a } = await upload(t, owner, { bytes });
    await owner.mutation(api.vouchers.updateDraft, { id: a, input: header({ documentNumber: "RE-1" }) });
    await owner.mutation(api.vouchers.finalize, { id: a });
    const { voucherId: b } = await upload(t, owner, { bytes });
    await owner.mutation(api.vouchers.updateDraft, {
      id: b,
      input: header({ documentNumber: "RE-2", documentDate: TODAY }),
    });
    const e = await errorOf(owner.mutation(api.vouchers.finalize, { id: b }));
    expect(e.data.reason).toBe("DUPLICATE_STRONG");
    expect(e.message).toContain(`Dublette von BE-${YEAR}-00001`);
    await owner.mutation(api.vouchers.dismissDuplicateOf, { id: b, otherId: a });
    await owner.mutation(api.vouchers.finalize, { id: b });
    expect((await voucher(t, b)).status).toBe("open");
  });
});

describe("Bewirtung and Eigenbeleg (VOU-060…063, MISC-05)", () => {
  const bewirtung = {
    occasionType: "geschaeftlich" as const,
    occasion: "Projektbesprechung Website-Relaunch mit Müller GmbH",
    participants: ["Anna Müller (Müller GmbH)", "Max Mustermann"],
    host: "Max Mustermann",
    place: "Restaurant Adler, Berlin",
    date: TODAY,
    tipCents: 1000,
    tseConfirmed: true,
  };

  test("VOU-060 VOU-061 VOU-062 MISC-05 EC-163 the Bewirtungsbeleg is approved as PDF (SHA-256) and the booking splits 70/30", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, {
      kind: "bewirtung",
      priceMode: "net",
      lines: [
        line({ account: "6640", description: "Speisen", amountCents: 10_000, vatRateBp: 700 }),
        line({ account: "6640", description: "Getränke", amountCents: 5000, vatRateBp: 1900 }),
        line({ account: "6640", description: "Trinkgeld", amountCents: 1000, vatRateBp: 0 }),
      ],
    });
    expect((await errorOf(owner.mutation(api.vouchers.finalize, { id }))).message).toContain(
      "Bitte zuerst den Bewirtungsbeleg freigeben.",
    );
    const generic = await errorOf(
      owner.action(api.vouchers.approveBewirtungBeleg, { id, data: { ...bewirtung, occasion: "Geschäftsessen" } }),
    );
    expect(generic.data.reason).toBe("BEWIRTUNG_OCCASION");
    await owner.action(api.vouchers.approveBewirtungBeleg, { id, data: bewirtung });
    const v = await voucher(t, id);
    expect(v.bewirtung?.approvedAt).toBeDefined();
    expect(v.bewirtung?.eigenbelegFile?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // VOU-062: a correction supersedes the approved version (reason required); the old PDF stays.
    expect((await errorOf(owner.action(api.vouchers.approveBewirtungBeleg, { id, data: bewirtung }))).data.reason).toBe(
      "REASON_REQUIRED",
    );
    await owner.action(api.vouchers.approveBewirtungBeleg, {
      id,
      data: { ...bewirtung, participants: [...bewirtung.participants, "Eva Schulz"] },
      reason: "Teilnehmerin ergänzt",
    });
    const v2 = await voucher(t, id);
    expect(v2.bewirtung?.versions).toHaveLength(1);
    expect(v2.bewirtung?.versions[0]?.reason).toBe("Teilnehmerin ergänzt");
    await owner.mutation(api.vouchers.finalize, { id });
    const [entry] = await entriesOf(t, id);
    expect(entry?.explanation).toBe("V5");
    const sum = (acc: string) =>
      (entry as Doc<"journalEntries">).lines.filter((l) => l.account === acc).reduce((s, l) => s + l.debitCents, 0);
    expect(sum("6640")).toBe(11_200);
    expect(sum("6644")).toBe(4800);
  });

  test("VOU-060 the approval is a personal act: an API key cannot approve a Bewirtungsbeleg", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, { kind: "bewirtung" });
    const key = await t.asApiKey(["vouchers:write", "vouchers:read"]);
    const e = await errorOf(key.action(api.vouchers.approveBewirtungBeleg, { id, data: bewirtung }));
    expect(e.code).toBe("forbidden_role");
  });

  test("VOU-063 GOBD-07 EC-EIG-01 an approved Eigenbeleg is the Beleg; booked without input VAT; immutable afterwards", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await owner.mutation(api.vouchers.create, {
      input: {
        kind: "eigenbeleg",
        documentDate: TODAY,
        taxRule: "no_input_vat",
        priceMode: "gross",
        lines: [line({ account: "6673", description: "Parkautomat", amountCents: 400, vatRateBp: 0 })],
      },
    });
    const data = {
      reason: "not_obtainable" as const,
      recipient: "Parkhaus Mitte",
      purpose: "Kundentermin Müller GmbH",
    };
    await owner.action(api.vouchers.approveEigenbelegBeleg, { id, data });
    expect((await errorOf(owner.action(api.vouchers.approveEigenbelegBeleg, { id, data }))).data.reason).toBe(
      "ALREADY_APPROVED",
    );
    await owner.mutation(api.vouchers.finalize, { id });
    const v = await voucher(t, id);
    expect(v).toMatchObject({ status: "open", taxRule: "no_input_vat" });
    expect(v.eigenbeleg?.file?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("tax payments, income vouchers, late vouchers (TAX-018, VOU-010, EC-162)", () => {
  test("TAX-018 an UStVA payment voucher posts X1 (vat.prepayment), not an expense", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, {
      kind: "tax_payment",
      supplierName: "Finanzamt Berlin",
      taxRule: "no_input_vat",
      taxPayment: { subtype: "ust_prepayment", period: `${YEAR}-09` },
      lines: [line({ account: "3820", description: "USt-VZ 09", amountCents: 50_000, vatRateBp: 0 })],
    });
    await owner.mutation(api.vouchers.finalize, { id });
    const [entry] = await entriesOf(t, id);
    expect(entry?.explanation).toBe("X1");
    expect(accountsOf(entry as Doc<"journalEntries">)).toEqual([
      ["3820", "S", 50_000],
      ["3300", "H", 50_000],
    ]);
  });

  test("VOU-010 EC-VOU-15 an income voucher on an own-sales revenue account warns (⚑) and posts VE", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner, {
      direction: "income",
      taxRule: "output_vat",
      supplierName: "Versicherung AG",
      lines: [line({ account: "4400", description: "Erstattung", amountCents: 11_900 })],
    });
    expect((await errorOf(owner.mutation(api.vouchers.finalize, { id }))).data.warnings).toBe("income_own_sales");
    await owner.mutation(api.vouchers.finalize, { id, acknowledgeWarnings: ["income_own_sales"] });
    const [entry] = await entriesOf(t, id);
    expect(entry?.explanation).toBe("VE");
  });

  test("EC-162 EC-VOU-09 GOBD-06 a voucher dated in a locked period is booked into the first open period, keeping its date", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const lockedMonth = `${YEAR}-01`;
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "periods",
        {
          period: lockedMonth,
          status: "locked",
          lockedAt: Date.now(),
          lockedBy: "user:test-owner",
          reason: "ustva_submitted",
        },
        { action: "period.lock" },
      ),
    );
    const id = await draft(t, owner, { documentDate: `${YEAR}-01-15` });
    const e = await errorOf(owner.mutation(api.vouchers.finalize, { id }));
    expect(e.data.warnings).toBe("period_locked_late");
    await owner.mutation(api.vouchers.finalize, { id, acknowledgeWarnings: ["period_locked_late"] });
    const [entry] = await entriesOf(t, id);
    expect(entry?.period).not.toBe(lockedMonth);
    expect(entry?.originalDate).toBe(`${YEAR}-01-15`);
    expect((await voucher(t, id)).documentDate).toBe(`${YEAR}-01-15`);
  });
});

describe("credit notes and refunds (VOU-012, VOU-134)", () => {
  test("VOU-012 VOU-134 a supplier credit note (negative) is linked to the original and settled by a bank refund", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const original = await draft(t, owner);
    await owner.mutation(api.vouchers.finalize, { id: original });
    const credit = await draft(t, owner, {
      creditNoteOfId: original,
      lines: [line({ amountCents: -2380 })],
    });
    await owner.mutation(api.vouchers.finalize, { id: credit });
    expect((await voucher(t, credit)).openAmountCents).toBe(-2380);
    const tx = await bookedTransaction(t, bank, {
      bookingDate: TODAY,
      amountCents: 2380,
      purpose: "Gutschrift Erstattung",
    });
    await owner.mutation(api.vouchers.recordPayment, { id: credit, method: "bank", transactionId: tx });
    expect((await voucher(t, credit)).status).toBe("paid");
  });
});

describe("recurring vouchers (VOU-064)", () => {
  test("VOU-064 EC-VOU-33 T06-116 the generator catches up missed occurrences in order and is idempotent", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const first = new Date(Date.UTC(YEAR, Number(TODAY.slice(5, 7)) - 3, 1)).toISOString().slice(0, 10);
    const rid = await owner.mutation(api.vouchers.createRecurring, {
      name: "Miete Büro",
      template: {
        direction: "expense",
        kind: "standard",
        supplierName: "Vermieter GmbH",
        currency: "EUR",
        priceMode: "gross",
        taxRule: "no_input_vat",
        lines: [line({ account: "6310", description: "Miete", amountCents: 80_000, vatRateBp: 0 })],
      },
      interval: "P1M",
      firstDate: first,
      createAs: "draft",
    });
    const r = await owner.mutation(api.vouchers.generateRecurringNow, { id: rid });
    expect(r.created).toHaveLength(3);
    const dates = (await t.run((ctx) => ctx.db.query("vouchers").collect())).map((v) => v.documentDate).sort();
    expect(dates[0]).toBe(first);
    expect((await owner.mutation(api.vouchers.generateRecurringNow, { id: rid })).created).toHaveLength(0);
    const tpl = await t.run((ctx) => ctx.db.get(rid));
    expect(tpl?.lastGeneratedIds).toHaveLength(3);
    expect((tpl?.nextDate ?? "") > TODAY).toBe(true);
  });
});

describe("missing receipts and unbooked items (VOU-110, VOU-111)", () => {
  test("VOU-110 GOBD-07 a bank debit without voucher is listed until „Beleg nicht erforderlich“ (reason) is recorded", async () => {
    const t = makeT();
    const { bank } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const tx = await bookedTransaction(t, bank, { bookingDate: TODAY, amountCents: -990, purpose: "Kontoführung" });
    expect((await owner.query(api.vouchers.missing, {})).transactions.map((x) => x.id)).toEqual([tx]);
    await owner.mutation(api.vouchers.waiveReceipt, { transactionId: tx, reason: "Bankgebühr – Kontoauszug genügt" });
    expect((await owner.query(api.vouchers.missing, {})).transactions).toEqual([]);
  });

  test("VOU-111 GOBD-04 drafts received more than 10 days ago appear under „Unbearbeitet > 10 Tage“", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const old = await draft(t, owner);
    await draft(t, owner);
    await t.model(OWNER, (ctx) =>
      auditedPatch(
        ctx,
        "vouchers",
        old,
        { receivedAt: Date.now() - 12 * 86_400_000 },
        { action: "voucher.update_draft" },
      ),
    );
    expect((await owner.query(api.vouchers.unbooked, {})).map((r) => r._id)).toEqual([old]);
    const page = await owner.query(api.vouchers.list, {
      paginationOpts: { numItems: 10, cursor: null },
      tab: "unbooked",
    });
    expect(page.page.map((r) => r._id)).toEqual([old]);
  });
});

describe("integrity (VOU-126, RI-21)", () => {
  test("VOU-126 GOBD-06 the nightly integrity run re-hashes voucher originals and reports a changed hash", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const id = await draft(t, owner);
    const ok = await t.action(internal.integrity.verify, { scope: "full" });
    expect(ok.findings.filter((f) => f.kind === "file_hash_mismatch")).toEqual([]);
    const v = await voucher(t, id);
    await t.model(OWNER, (ctx) =>
      auditedPatch(
        ctx,
        "vouchers",
        id,
        { originalFiles: v.originalFiles.map((f) => ({ ...f, sha256: "0".repeat(64) })) },
        { action: "voucher.update_draft" },
      ),
    );
    const bad = await t.action(internal.integrity.verify, { scope: "full" });
    expect(bad.findings.find((f) => f.kind === "file_hash_mismatch")?.detail).toContain("SHA-256 weicht ab");
  });
});

describe("Verfahrensdokumentation (VOU-125)", () => {
  test("VOU-125 GOBD-08 GOBD-10 the „Ersetzendes Scannen“ chapter is generated from members, keys and rules", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    await t.asMcp(["vouchers:read", "vouchers:write"]);
    await t.asApiKey(["vouchers:read"]); // read-only keys do not capture receipts
    const data = await owner.query(api.vouchers.scanningProcedure, {});
    expect(data).toMatchObject({
      companyName: "Muster Design",
      captureWithinDays: 10,
      retentionYears: 8,
      paperDestructionAllowed: false,
      channels: ["upload", "app", "mcp"],
    });
    expect(data.responsible.some((r) => r.endsWith("(Inhaber)"))).toBe(true);
    const doc = ersetzendesScannen(data);
    expect(doc.sections.map((s) => s.heading)).toEqual(
      expect.arrayContaining(["Zuständigkeit", "Sicherung bei der Erfassung", "Qualitätskontrolle", "Aufbewahrung"]),
    );
    expect(JSON.stringify(doc)).toContain("MCP-Schnittstelle");
  });
});

describe("list tabs (F06 §6.2)", () => {
  test("VOU-130 VOU-111 tabs Fällig and Teilbezahlt; counts per tab", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const due = await draft(t, owner, { dueDate: `${YEAR - 1}-12-31`, documentDate: `${YEAR - 1}-12-01` });
    await owner.mutation(api.vouchers.finalize, { id: due, acknowledgeWarnings: ["late_booking", "period_closed"] });
    const part = await draft(t, owner, { lines: [line({ amountCents: 23_800 })] });
    await owner.mutation(api.vouchers.finalize, {
      id: part,
      payment: { method: "private", amountCents: 10_000 },
    });
    await draft(t, owner, { lines: [line({ amountCents: 4_760 })] });
    const counts = await owner.query(api.vouchers.counts, {});
    expect(counts).toMatchObject({ all: 3, draft: 1, open: 2, overdue: 1, partially_paid: 1, paid: 0 });
    const page = await owner.query(api.vouchers.list, {
      paginationOpts: { numItems: 10, cursor: null },
      tab: "partially_paid",
    });
    expect(page.page.map((r) => r._id)).toEqual([part]);
  });
});
