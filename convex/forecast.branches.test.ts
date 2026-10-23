import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { invoiceEvent, OWNER, post, setupBooks } from "./bookkeeping.fixtures";
import { finalizedInvoice, invoiceValues, settle } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { defaultInvoiceAccount } from "./model/bankAccounts";
import { removePlannedItem, savePlannedItem } from "./model/forecast";
import { makeT, type TestT } from "./test.setup";
import { header, line, setupCompany, upload } from "./vouchers.fixtures";

/** Branch coverage of the Liquiditätsvorschau read model (F08 RPT-012) and the planned items (RPT-013). */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message ?? String(e);
type Owner = Awaited<ReturnType<TestT["asUser"]>>;

async function bankAccount(t: TestT, o: { name: string; currency: string; ledgerAccount: string }) {
  return t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankAccounts",
      {
        kind: "bank",
        name: o.name,
        currency: o.currency,
        accountHolder: "Muster",
        ledgerAccount: o.ledgerAccount,
        showOnInvoices: false,
        isDefaultForInvoices: false,
        autoApplyMatches: false,
      },
      { action: "settings.bank_account.create" },
    ),
  );
}

async function statement(t: TestT, accountId: Id<"bankAccounts">, closingBalanceCents?: number) {
  return t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankStatements",
      {
        accountId,
        periodFrom: "2026-09-01",
        periodTo: "2026-09-30",
        periodStartUtc: Date.parse("2026-08-31T22:00:00Z"),
        periodEndUtc: Date.parse("2026-09-30T22:00:00Z"),
        format: "camt053",
        ...(closingBalanceCents !== undefined ? { closingBalanceCents, openingBalanceCents: 0 } : {}),
        reconciled: true,
        uploadedAt: Date.now(),
        retentionUntil: "2036-12-31",
      },
      { action: "bank.import" },
    ),
  );
}

async function voucher(
  t: TestT,
  owner: Owner,
  over: Record<string, unknown>,
  o: { finalize?: boolean } = {},
): Promise<Id<"vouchers">> {
  const { voucherId } = await upload(t, owner);
  await owner.mutation(api.vouchers.updateDraft, {
    id: voucherId,
    input: header({ documentDate: "2026-10-01", ...over }),
  });
  if (o.finalize !== false) await owner.mutation(api.vouchers.finalize, { id: voucherId });
  return voucherId;
}

describe("RPT-012 Liquiditätsvorschau sources", () => {
  test("RPT-012 opening balance: a foreign-currency account is a notice, a statement closing balance is the bank-reported value, the till counts when not zero", async () => {
    const t = makeT();
    await setupBooks(t);
    const usd = await bankAccount(t, { name: "Revolut USD", currency: "USD", ledgerAccount: "1210" });
    const savings = await bankAccount(t, { name: "Tagesgeld", currency: "EUR", ledgerAccount: "1220" });
    await statement(t, savings, 250_000);
    await statement(t, usd, 99_999);
    const owner = await t.asUser("owner");
    await owner.mutation(api.accounting.postOpeningBalancePart, {
      fiscalYear: 2026,
      part: { kind: "cash", amountCents: 30_000 },
    });
    await owner.mutation(api.accounting.postOpeningBalancePart, {
      fiscalYear: 2026,
      part: {
        kind: "receivables",
        items: [
          {
            number: "ALT-7",
            documentDate: "2025-12-01",
            counterpartyName: "Altkunde",
            grossCents: 11_900,
            openCents: 11_900,
            taxedAs: "soll",
          },
        ],
      },
    });
    await owner.mutation(api.reports.savePlannedCashItem, {
      label: "Leasing",
      amountCents: -10_000,
      date: "2026-10-15",
      recurrence: "P1M",
      endDate: "2026-11-30",
      confidence: "high",
    });
    const f = await owner.query(api.reports.forecast, {});
    const opening = f.items.find((i) => i.source === "receivable");
    expect(opening).toMatchObject({ cents: 11_900, href: null });
    expect(opening?.label).toContain("ALT-7");
    expect(f.items.filter((i) => i.source === "planned").map((i) => i.expectedDate)).toEqual([
      "2026-10-15",
      "2026-11-15",
    ]);
    expect(f.notices).toContain("Konto „Revolut USD“ (USD) ist nicht in der Vorschau enthalten.");
    expect(f.openingParts).toEqual([
      { label: "Revolut EUR", cents: 0, reported: false },
      { label: "Tagesgeld", cents: 250_000, reported: true },
      { label: "Kasse", cents: 30_000, reported: false },
    ]);
    expect(f.openingCents).toBe(280_000);
    expect(f.end).toBe("2027-01-09");
  });

  test("RPT-012 a statement without a closing balance falls back to the ledger balance; a KU company gets no UStVA estimate", async () => {
    const t = makeT();
    const { bank, customer } = await setupBooks(t, { ku: true });
    await statement(t, bank);
    await post(t, {
      ...invoiceEvent(customer, "d1", "2026-10-02", 10_000),
      taxCase: "kleinunternehmer",
      vatGroups: [{ category: "E", rateBp: 0, netCents: 10_000, vatCents: 0 }],
    });
    const owner = await t.asUser("owner");
    const f = await owner.query(api.reports.forecast, {});
    expect(f.openingParts).toEqual([{ label: "Revolut EUR", cents: 0, reported: false }]);
    expect(f.items.filter((i) => i.source === "tax")).toEqual([]);
  });

  test("RPT-012 payables and tax vouchers: open amount, label, due date fallback; ESt/GewSt prepayments repeat the last amount at their deadlines", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const payable = await voucher(t, owner, { dueDate: "2026-10-30" });
    const noDue = await voucher(t, owner, {
      documentDate: "2026-10-02",
      lines: [line({ amountCents: 23_800 })],
    });
    await voucher(t, owner, { lines: [line({ amountCents: 35_700 })] }, { finalize: false }); // a draft is not a payable
    const est = await voucher(t, owner, {
      kind: "tax_payment",
      supplierName: "Finanzamt Berlin",
      supplierVatId: undefined,
      taxRule: "no_input_vat",
      documentDate: "2026-09-10",
      taxPayment: { subtype: "est_private" },
      lines: [line({ account: "2150", description: "ESt-VZ Q3", amountCents: 120_000, vatRateBp: 0 })],
    });
    await voucher(t, owner, {
      kind: "tax_payment",
      supplierName: "Finanzamt Berlin",
      supplierVatId: undefined,
      taxRule: "no_input_vat",
      documentDate: "2026-06-10",
      taxPayment: { subtype: "est_private" },
      lines: [line({ account: "2150", description: "ESt-VZ Q2", amountCents: 90_000, vatRateBp: 0 })],
    });
    await voucher(t, owner, {
      kind: "tax_payment",
      supplierName: "Bezirksamt",
      supplierVatId: undefined,
      taxRule: "no_input_vat",
      documentDate: "2026-08-15",
      taxPayment: { subtype: "gewerbesteuer" },
      lines: [line({ account: "7610", description: "GewSt-VZ Q3", amountCents: 45_000, vatRateBp: 0 })],
    });
    const f = await owner.query(api.reports.forecast, {});
    const byId = new Map(f.items.map((i) => [i.id, i]));
    expect(byId.get(payable)).toMatchObject({ source: "payable", cents: -11_900, href: `/belege/${payable}` });
    expect(byId.get(payable)?.label).toContain("Büro Schmidt GmbH");
    expect(byId.get(noDue)).toMatchObject({ source: "payable", cents: -23_800 });
    expect(byId.get(est)).toMatchObject({ source: "tax", cents: -120_000 });
    const prepayments = f.items.filter((i) => i.label.includes("(wie zuletzt)"));
    // 15.11.2026 is a Sunday → the GewSt deadline moves to Monday
    expect(prepayments.map((i) => [i.id, i.cents])).toEqual([
      ["gewst_prepayment:2026-11-16", -45_000],
      ["est_prepayment:2026-12-10", -120_000],
    ]);
  });

  test("RPT-012 recurring invoices (active, EUR, with payment terms) and recurring vouchers (net/gross, weekly interval, end date) enter the window", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedInvoice(t);
    const base = {
      draft: { paymentTerms: { dueDays: 14 } },
      skippedOccurrences: [],
      generatedCount: 0,
      automation: { finalize: false },
      createdBy: owner.actor,
      version: 1,
    };
    const schedule = (interval: "P1M" | "P7D", firstDate: string) => ({
      interval,
      firstDate,
      nextDate: firstDate,
      billing: "in_advance" as const,
      periodTextEnabled: false,
    });
    const active = await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "recurringTemplates",
        {
          ...base,
          name: "Wartungsvertrag",
          status: "active",
          contactId: personId,
          schedule: schedule("P1M", "2026-11-01"),
          amount: { netCents: 10_000, grossCents: 11_900, currency: "EUR" },
        },
        { action: "recurring.create" },
      ),
    );
    for (const [name, over] of [
      ["Pausiert", { status: "inactive" as const }],
      ["Archiviert", { archivedAt: Date.now() }],
      ["Ohne Betrag", {}],
      ["USD", { amount: { netCents: 1, grossCents: 1, currency: "USD" } }],
    ] as const) {
      await t.model(OWNER, (ctx) =>
        auditedInsert(
          ctx,
          "recurringTemplates",
          {
            ...base,
            name,
            status: "active",
            schedule: schedule("P1M", "2026-11-01"),
            ...("amount" in over || name === "Ohne Betrag"
              ? {}
              : { amount: { netCents: 1, grossCents: 1, currency: "EUR" } }),
            ...over,
          },
          { action: "recurring.create" },
        ),
      );
    }
    const supplierContactId = personId;
    const rv = (name: string, over: Record<string, unknown>, tpl: Record<string, unknown> = {}) =>
      t.model(OWNER, (ctx) =>
        auditedInsert(
          ctx,
          "recurringVouchers",
          {
            name,
            template: {
              direction: "expense",
              kind: "standard",
              supplierContactId,
              currency: "EUR",
              priceMode: "gross",
              taxRule: "no_input_vat",
              lines: [{ account: "6310", amountCents: 50_000, vatRateBp: 0 }],
              ...tpl,
            },
            interval: "P1M",
            firstDate: "2026-11-01",
            nextDate: "2026-11-01",
            active: true,
            createAs: "draft",
            lastGeneratedIds: [],
            actor: owner.actor,
            version: 1,
            ...over,
          } as never,
          { action: "voucher.recurring_create" },
        ),
      );
    const rent = await rv("Miete", {});
    const weekly = await rv(
      "Reinigung",
      { interval: "P2W", firstDate: "2026-10-20", nextDate: "2026-10-20", endDate: "2026-11-20" },
      { priceMode: "net", lines: [{ account: "6330", amountCents: 10_000, vatRateBp: 1900 }] },
    );
    await rv("Inaktiv", { active: false });
    await rv("Erlös", {}, { direction: "income" });
    await rv("Fremdwährung", {}, { currency: "USD" });
    const f = await owner.query(api.reports.forecast, {});
    const rec = f.items.filter((i) => i.source === "recurring_invoice");
    expect(rec.map((i) => [i.id, i.cents, i.label])).toEqual([
      [`${active}:2026-11-01`, 11_900, "Wartungsvertrag"],
      [`${active}:2026-12-01`, 11_900, "Wartungsvertrag"],
      // the 01.01.2027 run is due on 15.01.2027, after the 90-day window
    ]);
    expect(rec[0]?.expectedDate).toBe("2026-11-15");
    const vouchers = f.items.filter((i) => i.source === "recurring_voucher");
    expect(vouchers.filter((i) => i.id.startsWith(rent)).map((i) => i.cents)).toEqual([-50_000, -50_000, -50_000]);
    const cleaning = vouchers.filter((i) => i.id.startsWith(weekly));
    expect(cleaning.map((i) => [i.expectedDate, i.cents])).toEqual([
      ["2026-10-20", -11_900],
      ["2026-11-03", -11_900],
      ["2026-11-17", -11_900],
    ]);
    expect(vouchers.every((i) => i.label === "Miete" || i.label === "Reinigung")).toBe(true);
  });

  test("RPT-012 open receivables: a running dunning case carries its level; a paid invoice feeds the payment history", async () => {
    const t = makeT();
    const inv = await finalizedInvoice(t);
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "dunningCases",
        {
          invoiceId: inv.id,
          currentLevel: 2,
          status: "active",
          flatFeeCharged: false,
          reminders: [],
          limitationDate: "2029-12-31",
        },
        { action: "dunning.case.create" },
      ),
    );
    const f = await inv.owner.query(api.reports.forecast, {});
    const r = f.items.find((i) => i.source === "receivable");
    expect(r?.id).toBe(inv.id);
    expect(r?.expectedCents).toBe(119_000);
    // level 2: the cautious inflow is reduced by the dunning probability before the general cautious factor
    expect(r?.cautiousCents).toBeLessThan(107_100);
  });
});

describe("RPT-012 payment history", () => {
  test("RPT-012 E-RPT-09 a fully paid invoice of the customer becomes payment history for the next open invoice", async () => {
    const t = makeT();
    const inv = await finalizedInvoice(t);
    const account = await t.run((ctx) => defaultInvoiceAccount(ctx));
    if (!account) throw new Error("no account");
    await inv.owner.mutation(api.payments.recordForInvoice, {
      documentId: inv.id,
      source: { kind: "clearing", accountId: account._id },
      date: "2026-10-12",
      amountCents: 119_000,
    });
    const { id: second } = await inv.owner.mutation(api.invoices.createDraft, { values: invoiceValues(inv.personId) });
    await inv.owner.action(api.invoices.finalize, { id: second, version: 1 });
    await settle(t);
    const f = await inv.owner.query(api.reports.forecast, {});
    expect(f.items.filter((i) => i.source === "receivable").map((i) => i.id)).toEqual([second]);
    expect(f.notices).not.toContain("Keine Zahlungshistorie – Fälligkeit angenommen.");
  });
});

describe("RPT-013 planned items: refusals", () => {
  test("RPT-013 editing or removing a planned item that does not exist is refused (not_found); an end date is stored", async () => {
    const t = makeT();
    await setupBooks(t);
    const id = await t.model(OWNER, (ctx) =>
      savePlannedItem(ctx, {
        label: " Leasing ",
        amountCents: -30_000,
        date: "2026-11-01",
        recurrence: "P1M",
        endDate: "2026-12-31",
        confidence: "medium",
      }),
    );
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ label: "Leasing", endDate: "2026-12-31", createdBy: OWNER.actor });
    await t.model(OWNER, (ctx) => removePlannedItem(ctx, id));
    const err = await t
      .model(OWNER, (ctx) =>
        savePlannedItem(ctx, {
          id,
          label: "Leasing",
          amountCents: -30_000,
          date: "2026-11-01",
          recurrence: "once",
          confidence: "medium",
        }),
      )
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("not_found");
    expect(messageOf(err)).toBe("Die geplante Position existiert nicht.");
    const err2 = await t.model(OWNER, (ctx) => removePlannedItem(ctx, id)).catch((e: unknown) => e);
    expect(messageOf(err2)).toBe("Die geplante Position existiert nicht.");
  });

  test("RPT-013 validation lists the failing fields", async () => {
    const t = makeT();
    await setupBooks(t);
    const err = await t
      .model(OWNER, (ctx) =>
        savePlannedItem(ctx, {
          label: "",
          amountCents: 0,
          date: "kein Datum",
          recurrence: "once",
          confidence: "low",
        }),
      )
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("invalid_input");
    expect((err as { data: { fields: string } }).data.fields.split(",").length).toBeGreaterThanOrEqual(2);
  });
});
