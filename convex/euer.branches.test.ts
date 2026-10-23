import { afterEach, describe, expect, test, vi } from "vitest";
import type { BusinessEvent } from "../src/domain/accounting/events";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type Books, invoiceEvent, OWNER, post, setupBooks } from "./bookkeeping.fixtures";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { euerProfitCents, isBilanz, recordEuerSubmission } from "./model/euer";
import { makeT, type TestT } from "./test.setup";
import { header, line, setupCompany, upload, YEAR } from "./vouchers.fixtures";

/**
 * F08 TAX-015/TAX-016/TAX-022 EÜR: the branches of the read model (opening items, write-offs, credits, 10-day rule
 * for UStVA and recurring vouchers, manual entries on open-item accounts, AVEÜR groups) and of the submission record.
 */

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);

afterEach(() => {
  vi.useRealTimers();
});

type Owner = Awaited<ReturnType<TestT["asUser"]>>;

/** A payment row (the EÜR reads the target from `payments`) plus its journal entry. */
async function pay(
  t: TestT,
  b: Books,
  target: { kind: "salesDocument" | "opening_item"; id: string },
  date: string,
  amountCents: number,
  extra: Partial<Extract<BusinessEvent, { kind: "payment_received" }>> = {},
) {
  const paymentId = await t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "payments",
      {
        target,
        contactId: b.customer,
        date,
        amountCents,
        currency: "EUR",
        source: { kind: "cash" },
        differences: [],
        journalEntryIds: [],
        actor: OWNER.actor,
        recordedAt: Date.now(),
      },
      { action: "payment.record" },
    ),
  );
  await post(t, {
    kind: "payment_received",
    paymentId,
    date,
    means: { kind: "bank_account", bankAccountId: b.bank },
    amountCents,
    target,
    contactId: b.customer,
    ...extra,
  });
  return paymentId as Id<"payments">;
}

async function openingItems(owner: Owner, items: Record<string, unknown>[]) {
  await owner.mutation(api.accounting.postOpeningBalancePart, {
    fiscalYear: 2026,
    part: { kind: "receivables", items: items as never },
  });
  const status = await owner.query(api.accounting.openingBalanceStatus, { fiscalYear: 2026 });
  return status.openingItems.map((i) => i.id as string);
}

/** A booked expense voucher (SKR04) paid privately on `paidOn`. */
async function paidVoucher(t: TestT, owner: Owner, input: Record<string, unknown>, paidOn: string) {
  const { voucherId } = await upload(t, owner);
  await owner.mutation(api.vouchers.updateDraft, { id: voucherId, input: header(input) });
  await owner.mutation(api.vouchers.finalize, { id: voucherId });
  await owner.mutation(api.vouchers.recordPayment, {
    id: voucherId,
    method: "private",
    date: paidOn,
    backdateReason: "Nachtrag aus dem Kontoauszug",
  });
  return voucherId;
}

describe("EÜR read model branches (TAX-015, TAX-016, ACC-013)", () => {
  test("TAX-015 E-RPT-02 an invalid year is refused, a missing profile is incomplete; the Bilanz check uses the method valid in the year", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const bad = await owner.query(api.taxes.euer, { year: 1999 }).catch((e: unknown) => e);
    expect(errorCode(bad)).toBe("invalid_input");
    expect(messageOf(bad)).toBe("Ungültiges Jahr.");
    expect(errorCode(await owner.query(api.taxes.euer, { year: 2026 }).catch((e: unknown) => e))).toBe(
      "setup_incomplete",
    );
    expect(isBilanz(null, 2026)).toBe(false);
    const profile = {
      profitMethod: [
        { validFromFiscalYear: 2027, method: "bilanz" },
        { validFromFiscalYear: 2025, method: "euer" },
      ],
    } as never;
    expect(isBilanz(profile, 2026)).toBe(false);
    expect(isBilanz(profile, 2027)).toBe(true);
  });

  test("ACC-013 TAX-015 opening receivables: Ist with not-due VAT is split, a Soll item without split counts as taxable income with a notice", async () => {
    const t = makeT();
    const b = await setupBooks(t, { chart: "SKR04" });
    const owner = await t.asUser("owner");
    const [soll, ist] = await openingItems(owner, [
      {
        number: "SD-1",
        documentDate: "2025-12-10",
        counterpartyName: "Kunde A",
        grossCents: 119_000,
        openCents: 119_000,
        taxedAs: "soll",
      },
      {
        number: "SD-2",
        documentDate: "2025-12-20",
        counterpartyName: "Kunde B",
        grossCents: 59_500,
        openCents: 59_500,
        taxedAs: "ist",
        notDueVat: [{ rateBp: 1900, vatCents: 9_500 }],
      },
    ]);
    await pay(t, b, { kind: "opening_item", id: soll as string }, "2026-02-03", 119_000);
    await pay(t, b, { kind: "opening_item", id: ist as string }, "2026-02-04", 59_500, {
      ist: { notDueVat: [{ rateBp: 1900, vatCents: 9_500 }], payableCents: 59_500, settledBeforeCents: 0 },
    });
    const view = await owner.query(api.taxes.euer, { year: 2026 });
    expect(view.ku).toBe(false);
    expect(view.sheet.notices).toContain(
      "1 Eröffnungsposten ohne Steueraufteilung wurden als umsatzsteuerpflichtige Einnahmen angesetzt.",
    );
    // the Soll item (119 000, no split) + the net of the Ist item (50 000) are taxable receipts
    const taxable = view.sheet.lines.find((l) => l.kz === "112");
    expect(taxable?.valueCents).toBe(169_000);
    expect(taxable?.drillDown.map((d) => d.href)).toEqual([null, null]);
  });

  test("ACC-013 KU-05 a Kleinunternehmer's opening receivable without split is a KU receipt (Zeile 12)", async () => {
    const t = makeT();
    const b = await setupBooks(t, { ku: true, chart: "SKR04" });
    const owner = await t.asUser("owner");
    const [item] = await openingItems(owner, [
      {
        number: "SD-K",
        documentDate: "2025-12-10",
        counterpartyName: "Kunde K",
        grossCents: 40_000,
        openCents: 40_000,
        taxedAs: "soll",
      },
    ]);
    await pay(t, b, { kind: "opening_item", id: item as string }, "2026-03-01", 40_000);
    const view = await owner.query(api.taxes.euer, { year: 2026 });
    expect(view.ku).toBe(true);
    expect(view.values["111"]).toBe(40_000);
    expect(view.sheet.notices.join(" ")).not.toContain("Eröffnungsposten ohne Steueraufteilung");
  });

  test("TAX-015 RI-28 a manual entry on the receivable account is counted with a notice; the profit for the threshold monitor follows the sheet", async () => {
    const t = makeT();
    const b = await setupBooks(t, { chart: "SKR04" });
    const owner = await t.asUser("owner");
    const profile = await t.run((ctx) => ctx.db.query("companyProfile").first());
    if (!profile) throw new Error("no profile");
    // no journal entry in the year → no profit figure (SET-040)
    expect(await t.run((ctx) => euerProfitCents(ctx, profile, 2026))).toBeNull();
    await post(t, invoiceEvent(b.customer, "d1", "2026-02-10", 100_000));
    await pay(t, b, { kind: "salesDocument", id: "d1" }, "2026-03-10", 119_000);
    await owner.mutation(api.manualEntries.create, {
      date: "2026-04-10",
      text: "Umbuchung Forderung",
      lines: [
        { account: "1200", debitCents: 5_000, creditCents: 0 },
        { account: "4400", debitCents: 0, creditCents: 5_000 },
      ],
      attachments: [
        {
          storageId: await t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.4 Eigenbeleg"]))),
          name: "eigenbeleg.pdf",
        },
      ],
    });
    const view = await owner.query(api.taxes.euer, { year: 2026 });
    expect(view.sheet.notices).toContain(
      "1 manuelle Buchung(en) auf Forderungs- oder Verbindlichkeitskonten sind in der EÜR zum Buchungsdatum enthalten – bitte prüfen, ob der Zahlungszeitpunkt gemeint ist.",
    );
    const profit = await t.run((ctx) => euerProfitCents(ctx, profile, 2026));
    expect(profit).toBe(view.sheet.sums.gewinnCents);
    // a Bilanz year has no EÜR profit
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(
        ctx,
        { profitMethod: [{ validFromFiscalYear: 2026, method: "bilanz" }] },
        { action: "settings.tax.update" },
      ),
    );
    const bilanz = await t.run((ctx) => ctx.db.query("companyProfile").first());
    expect(await t.run((ctx) => euerProfitCents(ctx, bilanz as never, 2026))).toBeNull();
  });

  test("TAX-015 E-TAX-13 a written-off receivable is never income: the write-off reduces the cleared amount and its VAT", async () => {
    const t = makeT();
    const { owner, id, bankAccount } = await finalizedInvoice(t);
    const today = berlinCalendarDate(Date.now());
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "clearing", accountId: bankAccount },
      date: today,
      amountCents: 59_500,
    });
    await owner.mutation(api.payments.writeOff, {
      documentId: id,
      date: today,
      amountCents: 59_500,
      subReason: "insolvency",
    });
    const view = await owner.query(api.taxes.euer, { year: Number(today.slice(0, 4)) });
    // only the paid half (500 € net + 95 € USt) is income
    expect(view.values["112"]).toBe(50_000);
    expect(view.values["140"]).toBe(9_500);
    const pays = await t.run((ctx) => ctx.db.query("payments").collect());
    expect(pays.some((p) => p.differences.some((d) => d.reason === "write_off"))).toBe(true);
  });

  test("TAX-016 E-RPT-03 TST-TAX-17 a December UStVA paid 08.01. (due 10.01.) and recurring payments around the turn of the year belong to the previous year", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    await paidVoucher(
      t,
      owner,
      {
        kind: "tax_payment",
        supplierName: "Finanzamt Berlin",
        supplierVatId: undefined,
        taxRule: "no_input_vat",
        documentDate: `${YEAR}-01-05`,
        taxPayment: { subtype: "ust_prepayment", period: `${YEAR - 1}-12` },
        lines: [line({ account: "3820", description: "USt 12", amountCents: 30_000, vatRateBp: 0 })],
      },
      `${YEAR}-01-08`,
    );
    // recurring rent for December (period), due 02.01., paid 03.01.
    await paidVoucher(
      t,
      owner,
      {
        documentDate: `${YEAR}-01-02`,
        recurringPayment: true,
        dueDate: `${YEAR}-01-02`,
        supplyDate: { kind: "period", from: `${YEAR - 1}-12-01`, to: `${YEAR - 1}-12-31` },
        lines: [line({ amountCents: 11_900 })],
      },
      `${YEAR}-01-03`,
    );
    // recurring telephone for the month of December, due and paid 05.01.
    await paidVoucher(
      t,
      owner,
      {
        documentDate: `${YEAR}-01-04`,
        recurringPayment: true,
        dueDate: `${YEAR}-01-05`,
        supplyDate: { kind: "month", month: `${YEAR - 1}-12` },
        lines: [line({ amountCents: 5_950 })],
      },
      `${YEAR}-01-05`,
    );
    // recurring without supply date: the document date decides (current year)
    await paidVoucher(
      t,
      owner,
      {
        documentDate: `${YEAR}-01-06`,
        recurringPayment: true,
        dueDate: `${YEAR}-01-07`,
        lines: [line({ amountCents: 2_380 })],
      },
      `${YEAR}-01-07`,
    );
    const prev = await owner.query(api.taxes.euer, { year: YEAR - 1 });
    const drills = prev.sheet.lines.flatMap((l) => l.drillDown);
    expect(drills.filter((d) => d.tenDayRule).map((d) => d.tenDayRule)).toEqual(
      expect.arrayContaining([`UStVA 12/${YEAR - 1}`, "regelmäßig wiederkehrende Zahlung"]),
    );
    expect(drills.filter((d) => d.tenDayRule === "regelmäßig wiederkehrende Zahlung").length).toBeGreaterThanOrEqual(2);
    // the voucher drill-down links to the voucher
    expect(drills.some((d) => d.href?.startsWith("/belege/"))).toBe(true);
    const cur = await owner.query(api.taxes.euer, { year: YEAR });
    const curDrills = cur.sheet.lines.flatMap((l) => l.drillDown);
    expect(curDrills.some((d) => d.date === `${YEAR}-01-07`)).toBe(true);
    expect(curDrills.some((d) => d.date === `${YEAR}-01-08`)).toBe(false);
  });

  test("TAX-022 AST-012 TST-TAX-33 the AVEÜR groups assets by class and account role; GWG are not listed, Sammelposten per pool year", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const asset = (name: string, account: string, costCents: number, method: string, months?: number) =>
      owner.mutation(api.assets.create, {
        name,
        account,
        acquisitionDate: `${YEAR}-01-10`,
        costCents,
        method: method as never,
        ...(months ? { usefulLifeMonths: months } : {}),
        inputVatDeducted: true,
      });
    await asset("Software", "0135", 300_000, "linear", 36);
    await asset("Lagerhalle", "0240", 6_000_000, "linear", 396);
    await asset("PKW", "0520", 3_000_000, "linear", 72);
    await asset("Schreibtisch", "0650", 120_000, "linear", 156);
    await asset("Maschine", "0420", 500_000, "linear", 120);
    await asset("Locher", "0670", 20_000, "gwg");
    await asset("Stuhl", "0675", 60_000, "pool");
    const view = await owner.query(api.taxes.euer, { year: YEAR });
    const keys = view.aveuer?.groups.map((g) => g.key) ?? [];
    expect(keys).toEqual(expect.arrayContaining(["immateriell", "gebaeude", "kfz", "buero", "andere", `pool-${YEAR}`]));
    const pool = view.aveuer?.groups.find((g) => g.key === `pool-${YEAR}`);
    expect(pool?.fields.find((f) => f.label === "Bildung")?.valueCents).toBe(60_000);
    // AVEÜR values enter the sheet values with the AV prefix
    expect(Object.keys(view.values).some((k) => k.startsWith("AV"))).toBe(true);
  });
});

describe("EÜR submission record branches (TAX-021, TAX-022)", () => {
  const kuInvoice = (b: Books, id: string, date: string, gross: number) =>
    invoiceEvent(b.customer, id, date, gross, {
      taxCase: "kleinunternehmer",
      vatGroups: [{ category: "E", rateBp: 0, netCents: gross, vatCents: 0 }],
    });

  async function kuYear(t: TestT) {
    const b = await setupBooks(t, { ku: true, chart: "SKR04" });
    await post(t, kuInvoice(b, "d1", "2025-06-10", 200_000));
    await pay(t, b, { kind: "salesDocument", id: "d1" }, "2025-06-20", 200_000);
    return b;
  }

  async function record(u: Owner, over: Record<string, unknown> = {}) {
    const view = await u.query(api.taxes.euer, { year: 2025 });
    return u.mutation(api.taxes.recordFilingSubmission, {
      form: "euer",
      period: "2025",
      submittedOn: "2026-05-04",
      transferTicket: "et-euer-2025",
      crossCheckCents: view.sheet.sums.gewinnCents,
      sheetHash: view.guide.sheetHash,
      ...over,
    } as never);
  }

  test("TAX-021 E-UVA-01 E-UVA-18 no Transferticket, a date before the year end, a bad period, a changed sheet hash and a missing protocol are refused", async () => {
    const t = makeT();
    await kuYear(t);
    const u = await t.asUser("owner");
    const noTicket = await record(u, { transferTicket: "   " }).catch((e: unknown) => e);
    expect(errorCode(noTicket)).toBe("transfer_ticket_required");
    const early = await record(u, { submittedOn: "2025-12-31" }).catch((e: unknown) => e);
    expect(errorCode(early)).toBe("filing_blocked");
    expect(dataOf(early).reason).toBe("fiscal_year_not_ended");
    const badPeriod = await record(u, { period: "25" }).catch((e: unknown) => e);
    expect(messageOf(badPeriod)).toBe("Ungültiger Zeitraum (JJJJ).");
    const badDate = await t
      .model(OWNER, (ctx) =>
        recordEuerSubmission(ctx, {
          year: 2025,
          submittedOn: "04.05.2026",
          transferTicket: "et",
          crossCheckCents: 0,
          sheetHash: "x",
        }),
      )
      .catch((e: unknown) => e);
    expect(messageOf(badDate)).toBe("Das Übermittlungsdatum darf nicht in der Zukunft liegen.");
    const hash = await record(u, { sheetHash: "stale" }).catch((e: unknown) => e);
    expect(errorCode(hash)).toBe("sheet_changed");
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.4 Protokoll"])));
    await t.run((ctx) => ctx.storage.delete(storageId));
    const gone = await record(u, { protocolStorageId: storageId }).catch((e: unknown) => e);
    expect(errorCode(gone)).toBe("invalid_input");
    expect(messageOf(gone)).toBe("Das Übermittlungsprotokoll wurde nicht gefunden.");
    expect(await t.run((ctx) => ctx.db.query("taxFilings").collect())).toEqual([]);
  });

  test("TAX-022 E-UVA-21 E-UVA-03 a draft dated in the year blocks the EÜR guide with the drafts notice", async () => {
    const t = makeT();
    await kuYear(t);
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "vouchers",
        {
          direction: "expense",
          kind: "standard",
          status: "draft",
          documentDate: "2025-11-12",
          receivedAt: Date.parse("2025-11-12T10:00:00Z"),
          currency: "EUR",
          priceMode: "net",
          taxRule: "input_vat_deductible",
          totals: { netCents: 0, vatCents: 0, grossCents: 0, selfAssessedVatCents: 0, byRate: [] },
          openAmountCents: 0,
          originalFiles: [],
          renditions: [],
          duplicateDismissals: [],
          tags: [],
          journalEntryIds: [],
          recordedAt: Date.now(),
          retentionClass: "vouchers8",
          actor: OWNER.actor,
          version: 1,
        } as never,
        { action: "voucher.create" },
      ),
    );
    const u = await t.asUser("owner");
    const view = await u.query(api.taxes.euer, { year: 2025 });
    expect(view.guide.blocked).toBe(true);
    expect(view.blockers).toContain(
      "Es gibt 1 Entwürfe mit Leistungsdatum im Zeitraum. Bitte fertigstellen oder löschen.",
    );
    const err = await record(u).catch((e: unknown) => e);
    expect(errorCode(err)).toBe("filing_blocked");
    expect(dataOf(err).reason).toBe("blocked");
  });

  test("TAX-021 E-UVA-19 a different ELSTER Gewinn needs a reason; „abweichend übermittelt“ is stored with the protocol hash and opens the correction", async () => {
    const t = makeT();
    await kuYear(t);
    const u = await t.asUser("owner");
    const mismatch = await record(u, { crossCheckCents: 1 }).catch((e: unknown) => e);
    expect(errorCode(mismatch)).toBe("cross_check_mismatch");
    expect(dataOf(mismatch)).toMatchObject({ elsterCents: 1, appCents: 200_000 });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.4 Protokoll EÜR"])));
    const r = await record(u, {
      crossCheckCents: 199_000,
      valuesDifferReason: "Rundung in ELSTER korrigiert",
      protocolStorageId: storageId,
    });
    expect(r).toMatchObject({ kind: "euer", submittedValuesDiffer: true });
    expect(r.lockedMonths).toHaveLength(12);
    const [filing] = await t.run((ctx) => ctx.db.query("taxFilings").collect());
    expect(filing).toMatchObject({
      kind: "euer",
      period: "2025",
      submittedValuesDiffer: true,
      elsterReportedTotalCents: 199_000,
      valuesDifferReason: "Rundung in ELSTER korrigiert",
      protocolStorageId: storageId,
    });
    expect(filing?.protocolSha256).toMatch(/^[0-9a-f]{64}$|^[A-Za-z0-9+/=]+$/);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((a) => a.action === "tax_filing.submit")?.reason).toBe("Rundung in ELSTER korrigiert");
    // the view shows the filing and blocks a second record
    const view = await u.query(api.taxes.euer, { year: 2025 });
    expect(view.filing).toMatchObject({ submittedValuesDiffer: true, transmissionTicket: "et-euer-2025" });
    expect(view.blockers).toContain("Die EÜR 2025 ist bereits als übermittelt erfasst.");
    expect(view.status).toEqual({ lockedMonths: 12, provisional: false });
    const again = await record(u).catch((e: unknown) => e);
    expect(errorCode(again)).toBe("filing_blocked");
    expect(dataOf(again).reason).toBe("blocked");
  });
});
