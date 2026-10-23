import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice, invoiceValues, settle } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { patchCompanyProfile } from "./model/companyProfile";
import {
  assignDatevAccounts,
  datevContext,
  datevEntriesPage,
  datevStatus,
  setDatevBelegnummer,
  startDatevExport,
} from "./model/datev";
import { createJob } from "./model/jobs";
import { lockMonths } from "./model/periodLock";
import { makeT, type TestT } from "./test.setup";

/** F09 EXP-002…EXP-016 DATEV export (database side): guards, context, entries page, account assignment. */

const NOW = new Date("2026-10-12T10:00:00Z");
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
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
const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message;
const ALL = ["revenue", "vouchers", "payments", "manual", "master_data", "documents"] as const;
const OCT = { from: "2026-10-01", to: "2026-10-31" };

async function withDatev(t: TestT) {
  await t.model(OWNER, (ctx) =>
    patchCompanyProfile(
      ctx,
      { datev: { consultantNumber: 1234567, clientNumber: 12345, accountLength: 4, personalAccounts: true } },
      { action: "settings.company.update" },
    ),
  );
}

describe("DATEV settings and guards (EXP-002, EXP-008, EXP-016, E-EXP-10, E-EXP-20)", () => {
  test("EXP-002 without company data the status shows defaults and the export context is refused", async () => {
    const t = makeT();
    expect(await t.run((ctx) => datevStatus(ctx))).toEqual({
      configured: false,
      formatVersion: 13,
      personalAccounts: true,
      fiscalYearStartMonth: 1,
      acceptance: null,
    });
    const err = await catching(t.run((ctx) => datevContext(ctx, { ...OCT, now: Date.now() })));
    expect(errorCode(err)).toBe("not_found");
    expect(messageOf(err)).toBe("Unternehmensdaten fehlen.");
  });

  test("EXP-008 E-EXP-20 an invalid range or an empty scope is refused before any job is created", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const range = "Bitte einen gültigen Zeitraum wählen (Beginn vor Ende, höchstens zwei Wirtschaftsjahre).";
    const reversed = await catching(
      owner.mutation(api.datev.start, { from: "2026-10-31", to: "2026-10-01", scope: [...ALL], mode: "new" }),
    );
    expect(errorCode(reversed)).toBe("invalid_input");
    expect(messageOf(reversed)).toBe(range);
    const bad = await catching(
      owner.mutation(api.datev.start, { from: "01.10.2026", to: "2026-10-31", scope: [...ALL], mode: "new" }),
    );
    expect(messageOf(bad)).toBe(range);
    const badTo = await catching(
      owner.mutation(api.datev.start, { from: "2026-10-01", to: "31.10.2026", scope: [...ALL], mode: "new" }),
    );
    expect(messageOf(badTo)).toBe(range);
    const empty = await catching(owner.mutation(api.datev.start, { ...OCT, scope: [], mode: "new" }));
    expect(messageOf(empty)).toBe("Bitte mindestens einen Umfang auswählen.");
    expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toEqual([]);
  });

  test("EXP-016 the acceptance needs the test-import date; remarks are trimmed and the label falls back to the date", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const err = await catching(
      owner.mutation(api.datev.recordAcceptance, { testedOn: "1.11.2026", formatVersion: 13, buKeysConfirmed: true }),
    );
    expect(messageOf(err)).toBe("Bitte das Datum des Testimports angeben.");
    await owner.mutation(api.datev.recordAcceptance, {
      testedOn: "2026-11-01",
      formatVersion: 12,
      buKeysConfirmed: false,
      advisorName: "   ",
      remarks: "  BU-Schlüssel geprüft  ",
    });
    const [row] = await t.run((ctx) => ctx.db.query("datevAcceptance").collect());
    expect(row).toMatchObject({ testedOn: "2026-11-01", formatVersion: 12, remarks: "BU-Schlüssel geprüft" });
    expect(row?.advisorName).toBeUndefined();
    const audit = (await t.run((ctx) => ctx.db.query("auditLog").collect())).find(
      (e) => e.action === "export.datev_acceptance",
    );
    expect(audit?.entity.label).toBe("   ");
    const status = await owner.query(api.datev.status, {});
    expect(status.acceptance).toMatchObject({ testedOn: "2026-11-01", formatVersion: 12, buKeysConfirmed: false });
    // without an advisor name the audit label is the test date
    await owner.mutation(api.datev.recordAcceptance, {
      testedOn: "2026-11-02",
      formatVersion: 13,
      buKeysConfirmed: true,
    });
    const labels = (await t.run((ctx) => ctx.db.query("auditLog").collect()))
      .filter((e) => e.action === "export.datev_acceptance")
      .map((e) => e.entity.label);
    expect(labels).toContain("2026-11-02");
  });

  test("E-EXP-10 a draft without a number cannot get a DATEV alias", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const draft = await f.owner.mutation(api.invoices.createDraft, { values: invoiceValues(f.personId) });
    const err = await catching(
      t.model(OWNER, (ctx) =>
        setDatevBelegnummer(ctx, { documentId: draft.id as Id<"salesDocuments">, alias: "RE-ALT-1" }),
      ),
    );
    expect(errorCode(err)).toBe("not_found");
    expect(messageOf(err)).toBe("Dokument nicht gefunden.");
  });
});

describe("DATEV export context (EXP-006, EXP-011, EXP-013, E-EXP-20)", { timeout: 60_000 }, () => {
  test("EXP-006 EXP-013 E-EXP-13 assigned personal accounts: contacts with a number are skipped; the context carries the billing address and channels", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    await withDatev(t);
    const n = await t.model(OWNER, (ctx) =>
      assignDatevAccounts(ctx, [
        { contactId: f.orgId, kind: "debtor" },
        { contactId: f.orgId, kind: "creditor" },
        { contactId: f.personId, kind: "debtor" },
      ]),
    );
    expect(n).toBe(3);
    // second run: every contact already has its number
    expect(
      await t.model(OWNER, (ctx) =>
        assignDatevAccounts(ctx, [
          { contactId: f.orgId, kind: "debtor" },
          { contactId: f.personId, kind: "debtor" },
        ]),
      ),
    ).toBe(0);
    const c = await t.run((ctx) => datevContext(ctx, { ...OCT, now: Date.now() }));
    expect(c.settings).toMatchObject({ consultantNumber: 1234567, clientNumber: 12345, formatVersion: 13 });
    expect(c.years).toHaveLength(1);
    expect(c.years[0]?.chart).toBe("SKR03");
    expect(c.years[0]?.accounts.some((a) => a.n === "1200")).toBe(true);
    const org = c.contacts.find((x) => x.id === f.orgId);
    expect(org?.debtorAccount).toBeTruthy();
    expect(org?.creditorAccount).toBeTruthy();
    expect(org?.address?.city).toBeTruthy();
    expect(org?.email).toBeTruthy();
    expect(c.usedAccounts.length).toBe(3);
    expect(c.running).toBe(false);
    expect(c.accepted).toBe(false);
    expect(c.lockBlockers).toEqual([]);
  });

  test("EXP-011 E-EXP-20 a reversed range has no fiscal years; an open job on an overlapping range marks the context running; the lock preview of a locked year is skipped", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    await withDatev(t);
    const empty = await t.run((ctx) => datevContext(ctx, { from: "2026-10-31", to: "2026-10-01", now: Date.now() }));
    expect(empty.years).toEqual([]);
    await t.model(OWNER, (ctx) =>
      createJob(ctx, {
        kind: "datev_export",
        label: "DATEV-Export",
        params: { ...OCT, scope: ["revenue"], mode: "new" },
        total: 3,
      }),
    );
    const running = await t.run((ctx) => datevContext(ctx, { ...OCT, now: Date.now() }));
    expect(running.running).toBe(true);
    // E-EXP-20: a second start on the same range is refused while the job is open
    const err = await catching(
      t.model(OWNER, (ctx) => startDatevExport(ctx, { ...OCT, scope: ["revenue"], mode: "new" })),
    );
    expect(messageOf(err)).toBe("Für diesen Zeitraum läuft bereits ein Export.");

    const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);
    await t.model(OWNER, (ctx) => lockMonths(ctx, months, "manual"));
    const locked = await t.run((ctx) => datevContext(ctx, { ...OCT, now: Date.now(), lockPeriod: true }));
    expect(locked.lockedMonths).toEqual(["2026-10"]);
    expect(locked.lockBlockers).toEqual([]);
  });

  test("EXP-011 with „Zeitraum festschreiben“ a draft in the range is a lock blocker; the months the lock covers count as locked for the preview", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    await withDatev(t);
    await f.owner.mutation(api.invoices.createDraft, {
      values: { ...invoiceValues(f.personId), documentDate: "2026-10-10" } as never,
    });
    const c = await t.run((ctx) => datevContext(ctx, { ...OCT, now: Date.now(), lockPeriod: true }));
    expect(c.lockedMonths).toContain("2026-10");
    expect(c.lockBlockers.length).toBeGreaterThan(0);
  });

  test("EXP-011 GOBD-06 starting with the lock when the fiscal year is already locked skips the lock and creates the job", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);
    await t.model(OWNER, (ctx) => lockMonths(ctx, months, "manual"));
    const jobId = await t.model(OWNER, (ctx) =>
      startDatevExport(ctx, { ...OCT, scope: ["revenue"], mode: "new", lockPeriod: true }),
    );
    const job = await t.run((ctx) => ctx.db.get(jobId));
    expect(job).toMatchObject({
      kind: "datev_export",
      status: "queued",
      label: "DATEV-Export 2026-10-01 – 2026-10-31",
    });
  });
});

describe("DATEV entries page (EXP-005, EXP-008, EXP-014)", { timeout: 60_000 }, () => {
  test("EXP-008 EXP-014 the scope filters the entries; revenue entries carry Belegfeld 1, supply and due date, the buyer's USt-IdNr and the archived files", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    await f.owner.mutation(api.payments.recordForInvoice, {
      documentId: f.id as Id<"salesDocuments">,
      source: { kind: "clearing", accountId: f.bankAccount },
      date: "2026-10-12",
      amountCents: 10_000,
    });
    await settle(t);
    const page = await t.run((ctx) =>
      datevEntriesPage(ctx, { ...OCT, scope: ["revenue"], cursor: null, documents: true }),
    );
    expect(page.isDone).toBe(true);
    expect(page.entries.length).toBeGreaterThan(0);
    const beleg = page.belege[f.id];
    expect(beleg).toMatchObject({ belegfeld1: f.number, internalId: f.id, supplyDate: "2026-10-09" });
    expect(beleg?.dueDate).toBeTruthy();
    expect(page.docs).toEqual([expect.objectContaining({ sourceId: f.id, belegfeld1: f.number, numbered: false })]);
    expect(page.docs[0]?.files.map((x) => x.ext)).toContain("pdf");
    expect(page.contacts.length).toBeGreaterThan(0);

    // manual scope only: none of the invoice/payment entries
    const manual = await t.run((ctx) =>
      datevEntriesPage(ctx, { ...OCT, scope: ["manual"], cursor: null, documents: false }),
    );
    expect(manual.entries).toEqual([]);
    // a range that starts after the entries' dates (same period) yields nothing
    const late = await t.run((ctx) =>
      datevEntriesPage(ctx, { from: "2026-10-20", to: "2026-10-31", scope: [...ALL], cursor: null, documents: true }),
    );
    expect(late.entries).toEqual([]);
    // without documents no files are collected
    const noDocs = await t.run((ctx) =>
      datevEntriesPage(ctx, { ...OCT, scope: [...ALL], cursor: null, documents: false }),
    );
    expect(noDocs.docs).toEqual([]);
    expect(noDocs.entries.length).toBeGreaterThan(page.entries.length - 1);
  });
});

describe("DATEV entries page: vouchers (EXP-008, EXP-014)", { timeout: 60_000 }, () => {
  test("EXP-008 EXP-014 a voucher entry carries the internal number, the supplier's invoice number and USt-IdNr and its original; the voucher payment its payment number", async () => {
    vi.useRealTimers();
    const t = makeT();
    const { header, line, setupCompany, upload, YEAR } = await import("./vouchers.fixtures");
    const { supplier } = await setupCompany(t);
    const owner = await t.asUser("owner");
    const { voucherId } = await upload(t, owner);
    await owner.mutation(api.vouchers.updateDraft, {
      id: voucherId,
      input: header({ supplierContactId: supplier, documentNumber: "LS-4711", supplierVatId: "DE 123 456 789" }),
    });
    await owner.mutation(api.vouchers.finalize, { id: voucherId });
    await owner.mutation(api.vouchers.recordPayment, { id: voucherId, method: "private" });
    const voucher = await t.run((ctx) => ctx.db.get(voucherId));
    const range = { from: `${YEAR}-01-01`, to: `${YEAR}-12-31` };
    const page = await t.run((ctx) =>
      datevEntriesPage(ctx, { ...range, scope: ["vouchers", "payments"], cursor: null, documents: true }),
    );
    expect(page.belege[voucherId]).toMatchObject({
      belegfeld1: voucher?.internalNumber,
      supplierNumber: "LS-4711",
      internalId: voucherId,
    });
    expect(page.belege[voucherId]?.euVatId).toMatch(/^DE\d+$/);
    expect(page.docs).toEqual([
      expect.objectContaining({ sourceId: voucherId, belegfeld1: voucher?.internalNumber, numbered: true }),
    ]);
    expect(page.docs[0]?.files.map((f) => f.ext)).toEqual(["pdf"]);
    const payment = (await t.run((ctx) => ctx.db.query("payments").collect()))[0];
    if (payment?.number) expect(page.belege[payment._id]).toEqual({ belegfeld1: payment.number });
    expect(page.contacts.map((c) => c.id)).toContain(supplier);
    // the vouchers scope alone drops the payment entry
    const only = await t.run((ctx) =>
      datevEntriesPage(ctx, { ...range, scope: ["vouchers"], cursor: null, documents: false }),
    );
    expect(only.entries.length).toBeGreaterThan(0);
    expect(only.entries.every((e) => e.source.kind === "voucher")).toBe(true);
    expect(only.docs).toEqual([]);
    // a second voucher without supplier USt-IdNr has no EU-USt-IdNr column value
    const second = await upload(t, owner);
    await owner.mutation(api.vouchers.updateDraft, {
      id: second.voucherId,
      input: {
        ...header({ supplierContactId: supplier, lines: [line({ amountCents: 5_950 })] }),
        supplierVatId: undefined,
      },
    });
    await owner.mutation(api.vouchers.finalize, { id: second.voucherId });
    const both = await t.run((ctx) =>
      datevEntriesPage(ctx, { ...range, scope: ["vouchers"], cursor: null, documents: false }),
    );
    expect(both.belege[second.voucherId]?.belegfeld1).toBeTruthy();
    expect(both.belege[second.voucherId]?.euVatId).toBeUndefined();
  });
});

describe("DATEV entries page: reversals and Storno (E-EXP-09, EXP-005)", { timeout: 60_000 }, () => {
  test("E-EXP-09 EXP-005 a reversed payment carries reversalOfId; the Storno has no due date; an invoice to an organisation carries its USt-IdNr; a bank account outside the chart is a known account", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    await withDatev(t);
    const pay = await f.owner.mutation(api.payments.recordForInvoice, {
      documentId: f.id as Id<"salesDocuments">,
      source: { kind: "clearing", accountId: f.bankAccount },
      date: "2026-10-12",
      amountCents: 10_000,
    });
    await f.owner.mutation(api.payments.reverse, {
      paymentId: pay.paymentIds[0] as Id<"payments">,
      reason: "Falsch zugeordnet",
    });
    await f.owner.mutation(api.corrections.cancel, { id: f.id as Id<"salesDocuments"> });
    const org = await f.owner.mutation(api.invoices.createDraft, { values: invoiceValues(f.orgId) });
    const orgInvoice = await f.owner.action(api.invoices.finalize, { id: org.id, version: 1 });
    await settle(t);
    const page = await t.run((ctx) =>
      datevEntriesPage(ctx, { ...OCT, scope: [...ALL], cursor: null, documents: true }),
    );
    expect(page.entries.some((e) => e.reversalOfId !== undefined)).toBe(true);
    const storno = await t.run(async (ctx) =>
      (await ctx.db.query("salesDocuments").collect()).find((d) => d.type === "cancellation"),
    );
    expect(page.belege[storno?._id as string]).toMatchObject({ belegfeld1: storno?.number });
    expect(page.belege[storno?._id as string]?.dueDate).toBeUndefined();
    const orgBeleg = page.belege[org.id];
    expect(orgBeleg).toMatchObject({ belegfeld1: orgInvoice.number });
    expect(orgBeleg?.euVatId).toMatch(/^DE\d{9}$/);

    const { auditedInsert } = await import("./model/audit");
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankAccounts",
        {
          kind: "bank",
          name: "Sparkonto",
          currency: "EUR",
          iban: "DE02120300000000202051",
          accountHolder: "Muster",
          ledgerAccount: "1299",
          showOnInvoices: false,
          isDefaultForInvoices: false,
          autoApplyMatches: false,
        },
        { action: "settings.bank_account.create" },
      ),
    );
    const c = await t.run((ctx) => datevContext(ctx, { ...OCT, now: Date.now() }));
    expect(c.years[0]?.accounts).toContainEqual({ n: "1299", auto: false });
  });
});
