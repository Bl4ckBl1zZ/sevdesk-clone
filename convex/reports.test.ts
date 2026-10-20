import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { invoiceEvent, OWNER, post, setupBooks } from "./bookkeeping.fixtures";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { defaultInvoiceAccount } from "./model/bankAccounts";
import { lockMonths } from "./model/periodLock";
import { makeT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Auswertungen read models (RPT-001, RPT-003…RPT-007)", () => {
  test("RPT-004 RPT-001 TST-RPT-08 SuSa: debit = credit, the open month is „vorläufig“ with parameters and rule versions", async () => {
    const t = makeT();
    const b = await setupBooks(t, { chart: "SKR04" });
    await post(t, invoiceEvent(b.customer, "d1", "2026-03-10", 100000));
    const u = await t.asUser("viewer");
    const s = await u.query(api.reports.susa, { from: "2026-03-01", to: "2026-03-31" });
    expect(s.totals.periodDebitCents).toBe(s.totals.periodCreditCents);
    expect(s.totals.periodDebitCents).toBe(119000);
    expect(s.rows.find((r) => r.account === "4400")).toMatchObject({ periodCreditCents: 100000 });
    expect(s.meta).toMatchObject({
      report: "susa",
      params: { from: "2026-03-01", to: "2026-03-31", klasse: null },
      provisional: true,
      notice: "Vorläufig – Zeitraum nicht festgeschrieben.",
      ruleVersions: ["chart-skr04"],
    });
  });

  test("TST-RPT-08 E-RPT-01 a fully locked month is not provisional", async () => {
    const t = makeT();
    const b = await setupBooks(t, { chart: "SKR04" });
    await post(t, invoiceEvent(b.customer, "d1", "2026-03-10", 100000));
    await t.model(OWNER, (ctx) => lockMonths(ctx, ["2026-03"], "manual"));
    const u = await t.asUser("owner");
    const s = await u.query(api.reports.susa, { from: "2026-03-01", to: "2026-03-31" });
    expect(s.meta.provisional).toBe(false);
    expect(s.meta.notice).toBeNull();
  });

  test("RPT-005 Kontenblatt: running balance, contra account and drill-down to the source", async () => {
    const t = makeT();
    const b = await setupBooks(t, { chart: "SKR04" });
    await post(t, invoiceEvent(b.customer, "d1", "2026-03-10", 100000));
    await post(t, invoiceEvent(b.customer, "d2", "2026-03-20", 50000));
    const u = await t.asUser("owner");
    const l = await u.query(api.reports.ledger, { account: "4400", from: "2026-03-01", to: "2026-03-31" });
    expect(l.rows.map((r) => r.balanceCents)).toEqual([-100000, -150000]);
    expect(l.rows[0]).toMatchObject({ contra: "1200", href: "/rechnungen/d1" });
  });

  test("RPT-003 BWA-light (Soll): revenue in the month and year to date", async () => {
    const t = makeT();
    const b = await setupBooks(t, { chart: "SKR04" });
    await post(t, invoiceEvent(b.customer, "d1", "2026-02-10", 30000));
    await post(t, invoiceEvent(b.customer, "d2", "2026-03-10", 100000));
    const u = await t.asUser("owner");
    const r = await u.query(api.reports.bwa, { month: "2026-03", variant: "accrual" });
    const revenue = r.rows.find((x) => x.key === "umsatz");
    expect(revenue).toMatchObject({ monthCents: 100000, ytdCents: 130000, priorYtdCents: 0 });
    expect(r.meta.params).toMatchObject({ monat: "2026-03", variante: "accrual" });
  });

  test("RPT-006 TST-RPT-02 E-RPT-06 OPOS as of a past date reconstructs the open invoice; today it is paid and the account reconciles", async () => {
    const t = makeT();
    const inv = await finalizedInvoice(t);
    vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
    const bk = await t.asUser("bookkeeper");
    const account = await t.run((ctx) => defaultInvoiceAccount(ctx));
    if (!account) throw new Error("no invoice bank account");
    await bk.mutation(api.payments.recordForInvoice, {
      documentId: inv.id,
      source: { kind: "clearing", accountId: account._id },
      date: "2026-10-15",
      amountCents: 119000,
    });
    const before = await bk.query(api.reports.openItems, { side: "debtors", asOf: "2026-10-14" });
    expect(before.items).toEqual([
      expect.objectContaining({ id: inv.id, number: inv.number, openCents: 119000, href: `/rechnungen/${inv.id}` }),
    ]);
    expect(before.reconciliation).toMatchObject({ accountBalanceCents: 119000, differenceCents: 0, message: null });
    const after = await bk.query(api.reports.openItems, { side: "debtors", asOf: "2026-10-20" });
    expect(after.items).toEqual([]);
    expect(after.reconciliation.differenceCents).toBe(0);
    expect(after.meta.params).toEqual({ seite: "debtors", stichtag: "2026-10-20" });
  });

  test("RPT-007 revenue by customer and by month (net, document date)", async () => {
    const t = makeT();
    const inv = await finalizedInvoice(t);
    const byCustomer = await inv.owner.query(api.reports.revenue, {
      groupBy: "customer",
      basis: "document_date",
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(byCustomer.totals.netCents).toBe(100000);
    expect(byCustomer.groups).toHaveLength(1);
    const byMonth = await inv.owner.query(api.reports.revenue, {
      groupBy: "month",
      basis: "document_date",
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(byMonth.groups).toEqual([expect.objectContaining({ key: "2026-10", netCents: 100000 })]);
  });

  test("RPT-014 AUD-001 a SuSa CSV download carries the footer and is audited; the auditor only gets granted years", async () => {
    const t = makeT();
    const b = await setupBooks(t, { chart: "SKR04" });
    await post(t, invoiceEvent(b.customer, "d1", "2026-03-10", 100000));
    const u = await t.asUser("owner");
    const csv = await u.action(api.reportsNode.download, {
      report: "susa",
      params: { from: "2026-03-01", to: "2026-03-31" },
      format: "csv",
    });
    expect(csv.name).toBe("SuSa_20260331.csv");
    const text = new TextDecoder().decode(csv.data);
    expect(text).toContain("Festschreibung;vorläufig (0 von 1 Monaten festgeschrieben)");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.filter((e) => e.action === "export.report").map((e) => e.entity.label)).toEqual(["SuSa_20260331.csv"]);
    const auditor = await t.asUser("auditor", { auditor: { purpose: "Betriebsprüfung", fiscalYears: [2025] } });
    const err = await auditor
      .action(api.reportsNode.download, {
        report: "susa",
        params: { from: "2026-03-01", to: "2026-03-31" },
        format: "csv",
      })
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("not_found");
  });
});
