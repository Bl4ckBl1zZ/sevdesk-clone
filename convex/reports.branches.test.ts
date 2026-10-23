import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { emptyProjectForm } from "../src/domain/schemas/projects";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { productForm } from "./catalog.fixtures";
import { b2bBuyer, finalizedInvoice, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { makeT, type TestT } from "./test.setup";

/** F08 RPT-003…RPT-007 report read models: input guards, drill-down Belegfeld 1, filters and grouping branches. */

const NOW = new Date("2026-10-12T10:00:00Z");
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

describe("report input guards (RPT-003…RPT-007)", () => {
  test("RPT-004 RPT-005 RPT-006 RPT-007 RPT-003 invalid dates and months are refused with the German message", async () => {
    const t = makeT();
    const u = await t.asUser("owner");
    const susa = await catching(u.query(api.reports.susa, { from: "2026-13-01", to: "2026-03-31" }));
    expect(errorCode(susa)).toBe("invalid_input");
    expect(messageOf(susa)).toBe("Ungültiges Datum (von).");
    const ledger = await catching(u.query(api.reports.ledger, { account: "1200", from: "2026-01-01", to: "x" }));
    expect(messageOf(ledger)).toBe("Ungültiges Datum (bis).");
    const opos = await catching(u.query(api.reports.openItems, { side: "debtors", asOf: "31.03.2026" }));
    expect(messageOf(opos)).toBe("Ungültiges Datum (Stichtag).");
    const revenue = await catching(
      u.query(api.reports.revenue, { groupBy: "month", basis: "cash", from: "2026-02-30", to: "2026-03-31" }),
    );
    expect(messageOf(revenue)).toBe("Ungültiges Datum (von).");
    const bwa = await catching(u.query(api.reports.bwa, { month: "2026-13", variant: "accrual" }));
    expect(messageOf(bwa)).toBe("Ungültiger Monat (JJJJ-MM).");
  });

  test("RPT-004 RPT-005 RPT-006 RPT-003 without company data the reports answer setup_incomplete", async () => {
    const t = makeT();
    const u = await t.asUser("owner");
    const range = { from: "2026-01-01", to: "2026-03-31" };
    expect(errorCode(await catching(u.query(api.reports.susa, range)))).toBe("setup_incomplete");
    expect(errorCode(await catching(u.query(api.reports.ledger, { ...range, account: "1200" })))).toBe(
      "setup_incomplete",
    );
    expect(errorCode(await catching(u.query(api.reports.openItems, { side: "creditors", asOf: "2026-03-31" })))).toBe(
      "setup_incomplete",
    );
    expect(errorCode(await catching(u.query(api.reports.bwa, { month: "2026-03", variant: "cash" })))).toBe(
      "setup_incomplete",
    );
  });
});

/** An invoice with a document cost centre and project, a product line, a period supply date; one payment; a Storno. */
async function richBooks(t: TestT) {
  const s = await setupInvoicing(t);
  const { owner } = s;
  const { personId, orgId } = await b2bBuyer(owner);
  await owner.mutation(api.lookups.saveCostCenter, { values: { number: "100", name: "Webdesign", isDefault: false } });
  const cc = (await owner.query(api.lookups.listCostCenters, {})).find((c) => c.number === "100")
    ?.costCenterId as string;
  const project = (
    await owner.mutation(api.projects.create, {
      values: { ...emptyProjectForm(), name: "Relaunch", hourlyRate: "90,00", contactId: personId },
    })
  ).id as string;
  const base = invoiceValues(personId);
  const first = await owner.mutation(api.invoices.createDraft, {
    values: {
      ...base,
      costCenterId: cc,
      projectId: project,
      supplyDate: { kind: "period", from: "2026-09-01" as CalendarDate, to: "2026-09-30" as CalendarDate },
    },
  });
  const r1 = await owner.action(api.invoices.finalize, { id: first.id, version: 1 });
  const product = (
    await owner.mutation(api.products.create, {
      values: productForm("Hosting-Paket", { type: "service", unitCode: "C62", price: "100,00" }),
    })
  ).id as string;
  const productLine = {
    ...(base.lines[0] as (typeof base.lines)[number]),
    name: "Hosting-Paket",
    quantityMilli: 1_000,
    productId: product,
    costCenterId: cc,
    projectId: project,
  };
  // the second invoice (cancelled below) has a product line with its own cost centre and project
  const second = await owner.mutation(api.invoices.createDraft, {
    values: { ...base, lines: [...base.lines, productLine], supplyDate: { kind: "month", month: "2026-08" } },
  });
  const r2 = await owner.action(api.invoices.finalize, { id: second.id, version: 1 });
  await settle(t);
  const pay = await owner.mutation(api.payments.recordForInvoice, {
    documentId: first.id as Id<"salesDocuments">,
    source: { kind: "clearing", accountId: s.bankAccount },
    date: "2026-10-12",
    amountCents: 50_000,
  });
  await owner.mutation(api.corrections.cancel, { id: second.id as Id<"salesDocuments"> });
  await settle(t);
  return {
    ...s,
    personId,
    orgId,
    cc,
    project,
    first: { id: first.id, number: r1.number },
    second: { id: second.id, number: r2.number },
    paymentId: pay.paymentIds[0] as Id<"payments">,
  };
}

describe("SuSa, Kontenblatt and BWA branches (RPT-003…RPT-005)", { timeout: 60_000 }, () => {
  test("RPT-005 the Kontenblatt shows Belegfeld 1 of the invoice and of the payment; a bank ledger account outside the chart is named after the bank", async () => {
    const t = makeT();
    const b = await richBooks(t);
    const payment = await t.run((ctx) => ctx.db.get(b.paymentId));
    const owner = b.owner;
    const recv = await owner.query(api.reports.ledger, { account: "1400", from: "2026-01-01", to: "2026-12-31" });
    const belege = recv.rows.map((r) => r.belegfeld1);
    expect(belege).toContain(b.first.number);
    if (payment?.number) expect(belege).toContain(payment.number);
    expect(recv.rows.some((r) => r.href === `/rechnungen/${b.first.id}`)).toBe(true);
    // a second bank account on a ledger account the chart does not know
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
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
    const sp = await owner.query(api.reports.ledger, { account: "1299", from: "2026-01-01", to: "2026-12-31" });
    expect(sp.rows).toEqual([]);
    const unknown = await owner.query(api.reports.ledger, { account: "9998", from: "2026-01-01", to: "2026-12-31" });
    expect(unknown.rows).toEqual([]);
  });

  test("RPT-004 the SuSa filters by account class, includes personal accounts and starts no earlier than the fiscal year", async () => {
    const t = makeT();
    const b = await richBooks(t);
    const all = await b.owner.query(api.reports.susa, {
      from: "2025-06-01",
      to: "2026-12-31",
      includePersonal: true,
    });
    expect(all.totals.periodDebitCents).toBe(all.totals.periodCreditCents);
    expect(all.meta.params).toMatchObject({ from: "2025-06-01", klasse: null });
    const klasse8 = await b.owner.query(api.reports.susa, { from: "2026-01-01", to: "2026-12-31", accountClass: "8" });
    expect(klasse8.rows.length).toBeGreaterThan(0);
    expect(klasse8.rows.every((r) => r.account.startsWith("8"))).toBe(true);
    expect(klasse8.meta.params).toMatchObject({ klasse: "8" });
  });

  test("RPT-003 BWA by cost centre only counts the cost centre's lines; the parameters carry the cost centre", async () => {
    const t = makeT();
    const b = await richBooks(t);
    const r = await b.owner.query(api.reports.bwa, { month: "2026-10", variant: "accrual", costCenterId: b.cc });
    expect(r.meta.params).toMatchObject({ monat: "2026-10", variante: "accrual", kostenstelle: b.cc });
    expect(r.rows.find((x) => x.key === "umsatz")).toMatchObject({ monthCents: 100_000 });
    const total = await b.owner.query(api.reports.bwa, { month: "2026-10", variant: "accrual" });
    // the cancelled second invoice nets to zero: Umsatz equals the first invoice in both views
    expect(total.rows.find((x) => x.key === "umsatz")?.monthCents).toBe(100_000);
    expect(total.meta.params).toMatchObject({ kostenstelle: null });
  });
});

describe("revenue report grouping and bases (RPT-007)", { timeout: 60_000 }, () => {
  test("RPT-007 revenue by cost centre, project and product; supply-date basis uses the period end and month end; cash basis the payments", async () => {
    const t = makeT();
    const b = await richBooks(t);
    const q = (groupBy: "cost_center" | "project" | "product" | "customer", basis = "document_date" as const) =>
      b.owner.query(api.reports.revenue, { groupBy, basis, from: "2026-01-01", to: "2026-12-31" });
    const byCc = await q("cost_center");
    // the Storno of the second invoice has no lines of its own: it is attributed through the cancelled invoice's
    // lines (negated), so the cancelled product line nets to zero in its cost centre, project and product
    expect(byCc.groups.find((g) => g.key === b.cc)).toMatchObject({ netCents: 100_000 });
    expect(byCc.groups.find((g) => g.key === "-")?.netCents ?? 0).toBe(0);
    const byProject = await q("project");
    expect(byProject.groups.find((g) => g.key === b.project)).toMatchObject({ netCents: 100_000 });
    expect(byProject.groups.find((g) => g.key === b.project)?.label).toContain("Relaunch");
    const byProduct = await q("product");
    expect(byProduct.totals.netCents).toBe(100_000);
    expect(byProduct.groups.find((g) => g.label === "Hosting-Paket")?.netCents ?? 0).toBe(0);
    expect(byProduct.groups.find((g) => g.label === "ohne Produkt")).toBeUndefined();
    const supply = await b.owner.query(api.reports.revenue, {
      groupBy: "month",
      basis: "supply_date",
      from: "2026-01-01",
      to: "2026-12-31",
    });
    const months = supply.groups.map((g) => g.key);
    expect(months).toContain("2026-09");
    expect(months).toContain("2026-08");
    const cash = await b.owner.query(api.reports.revenue, {
      groupBy: "customer",
      basis: "cash",
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(cash.totals.grossCents).toBe(50_000);
    expect(cash.meta.params).toMatchObject({ gruppierung: "customer", basis: "cash" });
  });
});

describe("open items branches (RPT-006, E-RPT-06)", { timeout: 60_000 }, () => {
  test("RPT-006 E-RPT-06 an overpayment kept as credit balance reduces the receivable like a negative item and still reconciles", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    await f.owner.mutation(api.payments.recordForInvoice, {
      documentId: f.id as Id<"salesDocuments">,
      source: { kind: "clearing", accountId: f.bankAccount },
      date: "2026-10-12",
      amountCents: 120_000,
      excess: { mode: "credit" },
    });
    const r = await f.owner.query(api.reports.openItems, { side: "debtors", asOf: "2026-10-12" });
    expect(r.items.filter((i) => i.kind === "salesDocument")).toEqual([]);
    expect(r.reconciliation.differenceCents).toBe(0);
    expect(r.reconciliation.accountBalanceCents).toBe(-1_000);
  });

  test("RPT-006 creditors: a voucher without supplier contact shows the supplier name and its due date; drafts are skipped", async () => {
    const t = makeT();
    const { header, setupCompany, upload, TODAY } = await import("./vouchers.fixtures");
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const { voucherId } = await upload(t, owner);
    await owner.mutation(api.vouchers.updateDraft, { id: voucherId, input: header({ dueDate: TODAY }) });
    await owner.mutation(api.vouchers.finalize, { id: voucherId });
    await upload(t, owner); // a second voucher stays a draft
    const r = await owner.query(api.reports.openItems, { side: "creditors", asOf: TODAY });
    expect(r.items).toEqual([
      expect.objectContaining({ id: voucherId, contactName: "Büro Schmidt GmbH", dueDate: TODAY, openCents: 11_900 }),
    ]);
    expect(r.reconciliation.differenceCents).toBe(0);
    const before = await owner.query(api.reports.openItems, { side: "creditors", asOf: "2000-01-01" });
    expect(before.items).toEqual([]);
  });
});

describe("Kontenblatt Belegfeld 1 for vouchers (RPT-005)", { timeout: 60_000 }, () => {
  test("RPT-005 the payable account shows the voucher's internal number and the payment's number as Belegfeld 1; a custom account is named in the chart", async () => {
    vi.useRealTimers();
    const t = makeT();
    const { header, setupCompany, upload, YEAR } = await import("./vouchers.fixtures");
    const { supplier } = await setupCompany(t);
    const owner = await t.asUser("owner");
    await owner.mutation(api.accounting.createAccount, { number: "6999", name: "Software-Abos", type: "expense" });
    const { voucherId } = await upload(t, owner);
    await owner.mutation(api.vouchers.updateDraft, { id: voucherId, input: header({ supplierContactId: supplier }) });
    await owner.mutation(api.vouchers.finalize, { id: voucherId });
    await owner.mutation(api.vouchers.recordPayment, { id: voucherId, method: "private" });
    const voucher = await t.run((ctx) => ctx.db.get(voucherId));
    const payment = (await t.run((ctx) => ctx.db.query("payments").collect()))[0];
    const range = { from: `${YEAR}-01-01`, to: `${YEAR}-12-31` };
    const l = await owner.query(api.reports.ledger, { ...range, account: "3300" });
    expect(l.rows).toHaveLength(2);
    expect(l.rows[0]?.belegfeld1).toBe(voucher?.internalNumber);
    expect(l.rows[1]?.belegfeld1).toBe(payment?.number);
    expect(l.closingCents).toBe(0);
    const custom = await owner.query(api.reports.ledger, { ...range, account: "6999" });
    expect(custom.name).toBe("Software-Abos");
  });
});

describe("open items: manual postings on the personal accounts (RPT-006, E-RPT-06)", { timeout: 60_000 }, () => {
  test("E-RPT-06 RPT-006 a manual posting on the receivable or payable account is listed as a cause of the difference on both sides", async () => {
    const t = makeT();
    const { setupBooks } = await import("./bookkeeping.fixtures");
    await setupBooks(t);
    const owner = await t.asUser("owner");
    const beleg = async () => ({
      storageId: await t.run((ctx) =>
        ctx.storage.store(new Blob(["%PDF-1.4 Eigenbeleg"], { type: "application/pdf" })),
      ),
      name: "eigenbeleg.pdf",
    });
    const manual = async (text: string, lines: { account: string; debitCents: number; creditCents: number }[]) => {
      const args = { date: "2026-09-10", text, lines, attachments: [await beleg()] };
      try {
        return await owner.mutation(api.manualEntries.create, args);
      } catch (e) {
        const warnings = String((e as { data?: { warnings?: string } }).data?.warnings ?? "");
        if (!warnings) throw e;
        return owner.mutation(api.manualEntries.create, { ...args, acknowledgedWarnings: warnings.split(",") });
      }
    };
    await manual("Altforderung Umbuchung", [
      { account: "1400", debitCents: 5_000, creditCents: 0 },
      { account: "1200", debitCents: 0, creditCents: 5_000 },
    ]);
    await manual("Altverbindlichkeit Umbuchung", [
      { account: "1200", debitCents: 3_000, creditCents: 0 },
      { account: "1600", debitCents: 0, creditCents: 3_000 },
    ]);
    const debtors = await owner.query(api.reports.openItems, { side: "debtors", asOf: "2026-09-30" });
    expect(debtors.account).toBe("1400");
    expect(debtors.reconciliation).toMatchObject({ accountBalanceCents: 5_000, differenceCents: 5_000 });
    expect(debtors.reconciliation.message).toContain("50,00");
    const creditors = await owner.query(api.reports.openItems, { side: "creditors", asOf: "2026-09-30" });
    expect(creditors.account).toBe("1600");
    expect(creditors.reconciliation).toMatchObject({ accountBalanceCents: 3_000, differenceCents: 3_000 });
    expect(JSON.stringify(creditors.reconciliation)).toContain("Altverbindlichkeit Umbuchung");
  });
});

describe("open items: dunning level (RPT-006)", { timeout: 60_000 }, () => {
  test("RPT-006 an open invoice with a running dunning case shows its dunning level", async () => {
    const t = makeT();
    const { dunningSetup } = await import("./dunning.fixtures");
    const s = await dunningSetup(t);
    vi.setSystemTime(new Date("2026-10-19T08:00:00Z"));
    const owner = await t.asUser("owner", { existingUserId: s.owner.userId });
    const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    await owner.mutation(api.dunning.finalize, { id: id as Id<"salesDocuments"> });
    await settle(t);
    const r = await owner.query(api.reports.openItems, { side: "debtors", asOf: "2026-10-19" });
    const item = r.items.find((i) => i.id === s.invoiceId);
    expect(item?.href).toBe(`/rechnungen/${s.invoiceId}`);
    expect(r.dunningLevels).toEqual({ [s.invoiceId]: 1 });
  });
});
