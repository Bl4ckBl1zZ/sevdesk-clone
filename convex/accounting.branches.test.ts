import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { invoiceEvent, OWNER, post, setupBooks } from "./bookkeeping.fixtures";
import { errorCode } from "./lib/errors";
import { openingContextForImport, settleOpeningItem } from "./model/accounting";
import { auditedInsert, auditedPatch } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { lockMonths } from "./model/periodLock";
import { makeT, type TestT } from "./test.setup";

/** Branch coverage of convex/model/accounting.ts (F08 ACC-007/008/009/013/014/025, RPT-008). */

const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message ?? String(e);
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return { code: errorCode(e), message: messageOf(e) };
  }
  throw new Error("expected an error");
};

const receivable = (over: Record<string, unknown> = {}) => ({
  number: "SD-1",
  documentDate: "2025-12-10",
  counterpartyName: "Kunde A",
  grossCents: 119_000,
  openCents: 119_000,
  taxedAs: "soll" as const,
  ...over,
});

let txN = 0;
async function openTx(t: TestT, accountId: Id<"bankAccounts">, ref: string) {
  const r = `${ref}-${++txN}`;
  return t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankTransactions",
      {
        accountId,
        bookingDate: "2025-06-03",
        amountCents: 1_000,
        currency: "EUR",
        counterpartyName: "Bank",
        counterpartySource: "statement" as const,
        purpose: "Zinsen",
        source: { kind: "camt053", entryReference: r, rawSha256: r },
        sources: [],
        dedupeKey: `${accountId}:${r}`,
        contentHash: r,
        status: "open",
        allocatedCents: 0,
        recordedAt: Date.now(),
      },
      { action: "bank.import", label: r },
    ),
  );
}

async function setStart(t: TestT, date: string) {
  await t.model(OWNER, (ctx) =>
    patchCompanyProfile(ctx, { bookkeepingStartDate: date }, { action: "settings.bookkeeping.update" }),
  );
}

describe("ACC-013 opening balances: validation and wizard state", () => {
  test("ACC-013 every invalid opening receivable is refused with its German message", async () => {
    const t = makeT();
    await setupBooks(t);
    const owner = await t.asUser("owner");
    const postItems = (items: ReturnType<typeof receivable>[]) =>
      fail(
        owner.mutation(api.accounting.postOpeningBalancePart, {
          fiscalYear: 2026,
          part: { kind: "receivables", items },
        }),
      );
    expect(await postItems([])).toEqual({
      code: "invalid_input",
      message: "Bitte mindestens eine offene Forderung erfassen.",
    });
    expect((await postItems([receivable({ number: "" })])).message).toBe(
      "Forderung: Bitte die Rechnungsnummer angeben.",
    );
    expect((await postItems([receivable({ counterpartyName: "" })])).message).toBe("SD-1: Bitte den Kunden angeben.");
    expect((await postItems([receivable({ documentDate: "10.12.2025" })])).message).toBe(
      "SD-1: Bitte ein gültiges Rechnungsdatum angeben.",
    );
    expect((await postItems([receivable({ grossCents: 1.5 })])).message).toBe("SD-1: Beträge in ganzen Cent.");
    expect((await postItems([receivable({ openCents: 0 })])).message).toBe(
      "SD-1: Der offene Betrag muss zwischen 0 und dem Bruttobetrag liegen.",
    );
    expect((await postItems([receivable({ openCents: 200_000 })])).message).toBe(
      "SD-1: Der offene Betrag muss zwischen 0 und dem Bruttobetrag liegen.",
    );
    expect(
      (await postItems([receivable({ taxedAs: "ist", notDueVat: [{ rateBp: 1900, vatCents: 119_000 }] })])).message,
    ).toBe("SD-1: Die noch nicht fällige Umsatzsteuer muss kleiner als der offene Betrag sein.");
    expect(
      (await postItems([receivable({ taxedAs: "ist", notDueVat: [{ rateBp: 1900, vatCents: -1 }] })])).message,
    ).toBe("SD-1: Die noch nicht fällige Umsatzsteuer muss kleiner als der offene Betrag sein.");
    expect(await t.run((ctx) => ctx.db.query("openingItems").collect())).toEqual([]);
  });

  test("ACC-013 an archived bank account gets no opening balance", async () => {
    const t = makeT();
    const { bank } = await setupBooks(t);
    await t.model(OWNER, (ctx) =>
      auditedPatch(ctx, "bankAccounts", bank, { archivedAt: Date.now() }, { action: "settings.bank_account.update" }),
    );
    const owner = await t.asUser("owner");
    expect(
      await fail(
        owner.mutation(api.accounting.postOpeningBalancePart, {
          fiscalYear: 2026,
          part: { kind: "bank", bankAccountId: bank, amountCents: 1000 },
        }),
      ),
    ).toEqual({ code: "not_found", message: "Das Bankkonto ist nicht eingerichtet." });
    const status = await owner.query(api.accounting.openingBalanceStatus, { fiscalYear: 2026 });
    expect(status.banks).toEqual([]);
  });

  test("ACC-013 ACC-014 the opening date is the Buchungsbeginn in its year, else the fiscal-year start; Ist receivables keep the not-due VAT", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t, { method: "ist" });
    expect(await t.run((ctx) => openingContextForImport(ctx))).toBeNull();
    await setStart(t, "2026-03-01");
    const owner = await t.asUser("owner");
    // no year requested → the Buchungsbeginn's fiscal year
    let status = await owner.query(api.accounting.openingBalanceStatus, {});
    expect(status).toMatchObject({
      fiscalYear: 2026,
      date: "2026-03-01",
      bookkeepingStartDate: "2026-03-01",
      canChangeBookkeepingStart: true,
      cash: null,
      receivables: null,
    });
    expect(status.banks[0]).toMatchObject({ iban: "DE89370400440532013000", posted: null });
    // another year → its fiscal-year start
    expect((await owner.query(api.accounting.openingBalanceStatus, { fiscalYear: 2027 })).date).toBe("2027-01-01");
    expect(await t.run((ctx) => openingContextForImport(ctx))).toEqual({
      date: "2026-03-01",
      fiscalYear: 2026,
      receivablesPosted: false,
      taxedAs: "ist",
    });
    await owner.mutation(api.accounting.postOpeningBalancePart, {
      fiscalYear: 2026,
      part: {
        kind: "receivables",
        items: [
          receivable({
            contactId: customer,
            dueDate: "2026-01-10",
            taxedAs: "ist",
            notDueVat: [{ rateBp: 1900, vatCents: 19_000 }],
          }),
        ],
      },
    });
    status = await owner.query(api.accounting.openingBalanceStatus, {});
    expect(status.canChangeBookkeepingStart).toBe(false);
    expect(status.receivables?.totalCents).toBeGreaterThan(0);
    expect(status.openingItems).toEqual([
      expect.objectContaining({ number: "SD-1", openCents: 119_000, openAmountCents: 119_000, taxedAs: "ist" }),
    ]);
    const [item] = await t.run((ctx) => ctx.db.query("openingItems").collect());
    expect(item).toMatchObject({
      contactId: customer,
      dueDate: "2026-01-10",
      notDueVat: [{ rateBp: 1900, vatCents: 19_000 }],
    });
    expect(await t.run((ctx) => openingContextForImport(ctx))).toMatchObject({ receivablesPosted: true });
  });

  test("ACC-013 settling an opening item: unknown item, zero or fractional amounts and over-settlement are refused; reversals restore the amount", async () => {
    const t = makeT();
    await setupBooks(t);
    const owner = await t.asUser("owner");
    await owner.mutation(api.accounting.postOpeningBalancePart, {
      fiscalYear: 2026,
      part: { kind: "receivables", items: [receivable({ grossCents: 50_000, openCents: 50_000 })] },
    });
    const [item] = await t.run((ctx) => ctx.db.query("openingItems").collect());
    const id = item?._id as Id<"openingItems">;
    const settle = (cents: number, target: Id<"openingItems"> = id) =>
      t.model(OWNER, (ctx) => settleOpeningItem(ctx, target, cents));
    expect(await settle(10_000)).toEqual({ openAmountCents: 40_000 });
    expect(await fail(settle(0))).toEqual({
      code: "invalid_input",
      message: "Bitte einen Betrag in ganzen Cent angeben.",
    });
    expect((await fail(settle(0.5))).code).toBe("invalid_input");
    expect((await fail(settle(40_001))).message).toBe("Der Betrag übersteigt den offenen Posten SD-1.");
    expect((await fail(settle(-10_001))).message).toBe("Der Betrag übersteigt den offenen Posten SD-1.");
    expect(await settle(-10_000)).toEqual({ openAmountCents: 50_000 });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.filter((a) => a.entity.label === "Offener Posten SD-1").map((a) => a.action)).toEqual([
      "journal.opening_balance",
      "payment.record",
      "payment.reverse",
    ]);
    // an id that no longer exists
    const ghost = await t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = item as NonNullable<typeof item>;
      const x = await ctx.db.insert("openingItems", { ...rest, number: "tmp" });
      await ctx.db.delete(x);
      return x as Id<"openingItems">;
    });
    expect(await fail(settle(1, ghost))).toEqual({
      code: "not_found",
      message: "Der offene Posten aus der Eröffnungsbilanz existiert nicht.",
    });
  });
});

describe("ACC-014 Buchungsbeginn", () => {
  test("ACC-014 E-ACC-14 invalid date refused, same date is a no-op, after the first posting a change is blocked", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    const owner = await t.asUser("owner");
    expect(await fail(owner.mutation(api.accounting.setBookkeepingStartDate, { date: "2026-13-01" }))).toEqual({
      code: "invalid_input",
      message: "Bitte ein gültiges Datum angeben.",
    });
    await owner.mutation(api.accounting.setBookkeepingStartDate, { date: "2026-01-01" });
    await post(t, invoiceEvent(customer, "d1", "2026-02-10", 10_000));
    // unchanged date: no error even after postings
    await owner.mutation(api.accounting.setBookkeepingStartDate, { date: "2026-01-01" });
    expect(await fail(owner.mutation(api.accounting.setBookkeepingStartDate, { date: "2026-02-01" }))).toEqual({
      code: "bookkeeping_start_locked",
      message: "Der Buchungsbeginn kann nach der ersten Buchung nicht mehr geändert werden.",
    });
    const audits = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audits.filter((a) => a.action === "settings.bookkeeping.update")).toHaveLength(1);
  });

  test("ACC-014 without a company profile the bookkeeping functions refuse with setup_incomplete", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    expect((await fail(owner.mutation(api.accounting.setBookkeepingStartDate, { date: "2026-01-01" }))).code).toBe(
      "setup_incomplete",
    );
    expect((await fail(owner.query(api.accounting.openingBalanceStatus, {}))).code).toBe("setup_incomplete");
  });
});

describe("ACC-008 role overrides", () => {
  test("ACC-008 unknown role, invalid date, short source text and an unknown account are refused; a custom account can carry a role", async () => {
    const t = makeT();
    await setupBooks(t, { chart: "SKR04" });
    const owner = await t.asUser("owner");
    const set = (over: Record<string, string>) =>
      owner.mutation(api.accounting.setRoleMapping, {
        role: "cash",
        account: "1600",
        validFrom: "2026-01-01",
        sourceText: "DATEV SKR04 Kasse",
        ...over,
      });
    expect(await fail(set({ role: "nonsense.role" }))).toEqual({
      code: "invalid_input",
      message: "Unbekannte Kontenrolle.",
    });
    expect((await fail(set({ validFrom: "01.01.2026" }))).message).toBe(
      "Bitte ein gültiges „Gültig ab“-Datum angeben.",
    );
    expect((await fail(set({ sourceText: " ab " }))).message).toBe(
      "Bitte eine Begründung bzw. Quelle angeben (mindestens 5 Zeichen).",
    );
    expect(await fail(set({ account: "0001" }))).toEqual({
      code: "account_unknown",
      message: "Konto 0001 ist im Kontenrahmen SKR04 nicht vorhanden.",
    });
    await owner.mutation(api.accounting.createAccount, { number: "6999", name: "Software-Abos", type: "expense" });
    await set({ account: "6999" });
    await set({});
    const rows = await t.run((ctx) => ctx.db.query("accountRoleMappings").collect());
    const overrides = rows.filter((r) => r.source === "override");
    expect(overrides.map((r) => r.mappingVersion)).toEqual(["override-1", "override-2"]);
    expect(overrides[0]).toMatchObject({ account: "6999", chart: "SKR04", sourceText: "DATEV SKR04 Kasse" });
    // the viewer may not
    const viewer = await t.asUser("viewer");
    expect(
      errorCode(
        await viewer
          .mutation(api.accounting.setRoleMapping, {
            role: "cash",
            account: "1600",
            validFrom: "2026-01-01",
            sourceText: "DATEV SKR04 Kasse",
          })
          .catch((e: unknown) => e),
      ),
    ).toBe("forbidden_role");
  });
});

describe("ACC-007 ACC-025 RPT-008 journal views", () => {
  test("ACC-025 invalid filters are refused with the German messages", async () => {
    const t = makeT();
    await setupBooks(t);
    const owner = await t.asUser("owner");
    const search = (a: Record<string, unknown>) => fail(owner.query(api.accounting.searchJournal, a));
    expect(await search({ from: "2026-02-30" })).toEqual({
      code: "invalid_input",
      message: "Bitte gültige Datumsangaben (TT.MM.JJJJ) verwenden.",
    });
    expect((await search({ from: "2026-03-01", to: "2026-02-01" })).message).toBe(
      "Das Von-Datum liegt nach dem Bis-Datum.",
    );
    expect((await search({ minCents: -1 })).message).toBe("Bitte gültige Beträge angeben.");
    expect((await search({ minCents: 10, maxCents: 5 })).message).toBe(
      "Der Mindestbetrag liegt über dem Höchstbetrag.",
    );
    expect((await fail(owner.query(api.accounting.journalReport, { to: "x" }))).code).toBe("invalid_input");
  });

  test("ACC-025 open-ended ranges, paging limits, late postings and the line details (tax key, contact, cost centre)", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    const owner = await t.asUser("owner");
    await post(t, invoiceEvent(customer, "d1", "2026-01-10", 10_000));
    await post(t, invoiceEvent(customer, "d2", "2026-02-10", 20_000));
    await post(t, invoiceEvent(customer, "d3", "2026-03-10", 30_000));
    expect((await owner.query(api.accounting.searchJournal, { from: "2026-02-01" })).total).toBe(2);
    expect((await owner.query(api.accounting.searchJournal, { to: "2026-02-28" })).total).toBe(2);
    const paged = await owner.query(api.accounting.searchJournal, { offset: -5, limit: 0.4 });
    expect(paged).toMatchObject({ offset: 0, limit: 1, total: 3 });
    expect(paged.page.map((e) => e.seq)).toEqual([3]);
    expect((await owner.query(api.accounting.searchJournal, { limit: 5000, offset: 2 })).limit).toBe(200);
    const all = await owner.query(api.accounting.searchJournal, { sort: "date_asc" });
    expect(all.totalCents).toBe(Math.round(60_000 * 1.19));
    const [first] = all.page;
    expect(first?.source).toMatchObject({ kind: "salesDocument", label: "Verkaufsbeleg" });
    expect(first?.lines.some((l) => l.contactId === customer)).toBe(true);
    expect(first?.lines.some((l) => l.taxPointDate === "2026-01-10")).toBe(true);
    expect(first?.lines.find((l) => l.account === "1200")).toBeUndefined();
    expect(first?.lines.find((l) => l.account === "1400")?.accountName).toBeTruthy();
    // late postings: the invoice dated in a locked month moves to the first open month
    expect((await owner.query(api.accounting.searchJournal, { late: true })).total).toBe(0);
    const entry = await owner.query(api.accounting.getJournalEntry, { entryId: first?.id as Id<"journalEntries"> });
    expect(entry).toMatchObject({ seq: first?.seq, locked: false });
    expect(entry?.explanationText).toBeTruthy();
  });

  test("ACC-007 ACC-009 the chart of accounts of another fiscal year shows custom, archived and bank accounts (own number, incomplete ledger)", async () => {
    const t = makeT();
    const { customer, bank } = await setupBooks(t, { chart: "SKR04" });
    const owner = await t.asUser("owner");
    const second = await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankAccounts",
        {
          kind: "bank",
          name: "Sparkonto",
          currency: "EUR",
          iban: "DE02120300000000202051",
          accountHolder: "Muster",
          ledgerAccount: "1810",
          showOnInvoices: false,
          isDefaultForInvoices: false,
          autoApplyMatches: false,
        },
        { action: "settings.bank_account.create" },
      ),
    );
    await openTx(t, second, "k1");
    await openTx(t, bank, "k2");
    await owner.mutation(api.accounting.createAccount, { number: "6999", name: "Software-Abos", type: "expense" });
    await post(t, invoiceEvent(customer, "d1", "2025-06-10", 10_000));
    const chart2025 = await owner.query(api.accounting.chartOfAccounts, { fiscalYear: 2025 });
    expect(chart2025).toMatchObject({
      fiscalYear: 2025,
      from: "2025-01-01",
      to: "2025-12-31",
      chart: "SKR04",
      journalEntries: true,
    });
    expect(chart2025.accounts.find((a) => a.number === "1810")).toMatchObject({
      name: "Sparkonto",
      type: "bank",
      verified: true,
    });
    expect(chart2025.accounts.find((a) => a.number === "1810")?.incomplete).toBe(true);
    expect(chart2025.accounts.find((a) => a.number === "1200")).toMatchObject({
      name: "Forderungen aus Lieferungen und Leistungen – Revolut EUR",
      incomplete: true,
    });
    expect(chart2025.accounts.find((a) => a.number === "6999")).toMatchObject({ custom: true, name: "Software-Abos" });
    const used = chart2025.accounts.filter((a) => a.used).map((a) => a.number);
    expect(used.length).toBeGreaterThan(1);
    const chart2024 = await owner.query(api.accounting.chartOfAccounts, { fiscalYear: 2024 });
    expect(chart2024.journalEntries).toBe(false);
  });

  test("ACC-009 RPT-008 E-ACC-03 custom account names, cost centres and late postings reach the journal view and the Buchungsjournal", async () => {
    const t = makeT();
    await setupBooks(t, { chart: "SKR04" });
    const owner = await t.asUser("owner");
    await owner.mutation(api.accounting.createAccount, { number: "6999", name: "Software-Abos", type: "expense" });
    await owner.mutation(api.lookups.saveCostCenter, {
      values: { number: "100", name: "Webdesign", isDefault: false },
    });
    const cc = (await owner.query(api.lookups.listCostCenters, {})).find((c) => c.number === "100")
      ?.costCenterId as string;
    const file = await t.run((ctx) => ctx.storage.store(new Blob(["beleg"], { type: "application/pdf" })));
    const m = await owner.mutation(api.manualEntries.create, {
      date: "2026-03-15",
      text: "Umbuchung Software",
      lines: [
        { account: "6999", debitCents: 5_000, creditCents: 0, costCenterId: cc },
        { account: "6805", debitCents: 0, creditCents: 5_000 },
      ],
      attachments: [{ storageId: file, name: "beleg.pdf" }],
    });
    await t.model(OWNER, (ctx) => lockMonths(ctx, ["2026-01"], "manual"));
    await owner.mutation(api.assets.create, {
      name: "Schreibtisch",
      account: "0650",
      acquisitionDate: "2026-01-10",
      costCents: 120_000,
      method: "linear",
      usefulLifeMonths: 120,
      inputVatDeducted: true,
    });
    await owner.mutation(api.assets.depreciateNow, { through: "2026-01" });

    const view = await owner.query(api.accounting.getJournalEntry, { entryId: m.entryId });
    expect(view?.lines.map((l) => [l.account, l.accountName, l.costCenterId ?? null])).toEqual([
      ["6999", "Software-Abos", cc],
      ["6805", expect.any(String), null],
    ]);
    expect(view?.source.label).toBe("Manuelle Buchung");
    const late = await owner.query(api.accounting.searchJournal, { late: true });
    expect(late.total).toBe(1);
    expect(late.page[0]).toMatchObject({ period: "2026-02", originalDate: "2026-01-31" });
    expect(late.page[0]?.source).toMatchObject({ kind: "asset_depreciation", label: "Abschreibung" });
    expect(late.page[0]?.latePostingReason).toBeTruthy();

    const report = await owner.query(api.accounting.journalReport, {});
    const manual = report.find((r) => r.text === "Umbuchung Software");
    expect(manual?.lines[0]).toMatchObject({
      account: "6999",
      accountName: "Software-Abos",
      costCenter: "100 Webdesign",
    });
    expect(manual?.lines[1]?.costCenter).toBeUndefined();
    const lateRow = report.find((r) => r.originalDate === "2026-01-31");
    expect(lateRow).toMatchObject({ period: "2026-02", locked: false });
    expect(lateRow?.latePostingReason).toBeTruthy();
    expect(report.find((r) => r.period === "2026-01")).toBeUndefined();
  });
});
