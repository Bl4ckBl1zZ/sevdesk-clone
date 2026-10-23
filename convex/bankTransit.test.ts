import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { auditedInsert } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { postJournalEntry } from "./model/journal";
import { makeT, type TestT } from "./test.setup";

/**
 * F07 Geldtransit (BNK-061, CSH-024; F08 T4/T5, E-ACC-18/23/31): pairing of both sides of a transfer between own
 * accounts and of a cash deposit with its bank credit, and the derived open-transit warnings in `banking.todos`.
 */

const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message ?? String(e);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = makeT();
  await t.model(OWNER, (ctx) =>
    patchCompanyProfile(
      ctx,
      {
        name: "Muster Consulting e.K.",
        legalForm: "einzelunternehmen",
        chartOfAccounts: [{ validFromFiscalYear: 2026, chart: "SKR03" }],
        taxationMethod: [{ validFrom: "2026-01-01", method: "soll" }],
        ustvaPeriod: [{ year: 2026, period: "monthly", dauerfrist: false }],
      },
      { action: "settings.tax.update" },
    ),
  );
  const owner = await t.asUser("owner");
  const account = (name: string, currency: string, iban: string) =>
    owner.mutation(api.banking.createAccount, {
      values: { name, currency, iban, bic: "", accountHolder: "Max Muster", showOnInvoices: false },
    });
  const eur = await account("Revolut EUR", "EUR", "LT443250010000000101");
  const usd = await account("Revolut USD", "USD", "LT443250010000000101");
  const savings = await account("Tagesgeld", "EUR", "DE89370400440532013000");
  await t.model(OWNER, (ctx) =>
    postJournalEntry(ctx, {
      kind: "opening_balance",
      fiscalYear: 2026,
      date: "2026-01-01",
      part: { kind: "cash", amountCents: 100_000 },
    }),
  );
  return { t, owner, eur, usd, savings };
}

let n = 0;
async function booked(
  t: TestT,
  accountId: Id<"bankAccounts">,
  tx: {
    bookingDate: string;
    amountCents: number;
    currency?: string;
    purpose?: string;
    counterpartyIban?: string;
    instructed?: { amountMinor: number; currency: string };
  },
): Promise<Id<"bankTransactions">> {
  const i = n++;
  const raw = `transit-${i}-${tx.bookingDate}-${tx.amountCents}`;
  return t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankTransactions",
      {
        accountId,
        bookingDate: tx.bookingDate,
        amountCents: tx.amountCents,
        currency: tx.currency ?? "EUR",
        purpose: tx.purpose ?? "Umbuchung",
        ...(tx.counterpartyIban ? { counterpartyIban: tx.counterpartyIban } : {}),
        source: {
          kind: "camt053" as const,
          entryReference: `TR-${i}`,
          rawSha256: raw,
          ...(tx.instructed ? { instructedAmount: tx.instructed } : {}),
        },
        sources: [],
        dedupeKey: `${accountId}:er:TR-${i}`,
        contentHash: raw,
        status: "open" as const,
        allocatedCents: 0,
        recordedAt: Date.now(),
      },
      { action: "bank.import", label: `${tx.bookingDate} ${tx.amountCents}` },
    ),
  );
}

const txOf = (t: TestT, id: Id<"bankTransactions">) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"bankTransactions">);

async function jump(t: TestT, iso: string) {
  vi.setSystemTime(new Date(iso));
  return t.asUser("owner");
}

const transitTodos = async (owner: Awaited<ReturnType<TestT["asUser"]>>) =>
  (await owner.query(api.banking.todos, {}))
    .filter((x) => x.kind.startsWith("transit_") || x.kind === "cash_deposit_open")
    .map((x) => [x.kind, x.title]);

async function transitBalance(t: TestT) {
  const lines = await t.run((ctx) =>
    ctx.db
      .query("journalLines")
      .withIndex("by_account_date_seq", (q) => q.eq("account", "1360"))
      .collect(),
  );
  return lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0);
}

describe("cash deposit ↔ bank credit (CSH-024, T5)", () => {
  test("E-ACC-31 TST-ACC-32 CSH-024 a cash deposit pairs with the bank credit of exactly its amount; 499 € does not", async () => {
    let { t, owner, eur } = await setup();
    const dep = await owner.action(api.cash.recordTransfer, {
      kind: "deposit_to_bank",
      date: "2026-10-12",
      amountCents: 50_000,
      bankAccountId: eur,
    });
    owner = await jump(t, "2026-10-13T10:00:00Z");
    const wrong = await booked(t, eur, { bookingDate: "2026-10-13", amountCents: 49_900, purpose: "Bareinzahlung" });
    const e = await owner
      .action(api.banking.mark, { transactionId: wrong, as: "transfer", cashTransferId: dep.id })
      .catch((x) => x);
    expect(messageOf(e)).toBe(
      "Der Betrag der Gutschrift (499,00 €) entspricht nicht der Bareinzahlung vom 12.10.2026 (500,00 €).",
    );
    expect((await txOf(t, wrong)).status).toBe("open");
    const credit = await booked(t, eur, { bookingDate: "2026-10-13", amountCents: 50_000, purpose: "Bareinzahlung" });
    await owner.action(api.banking.mark, { transactionId: credit, as: "transfer" });
    expect((await txOf(t, credit)).transferCashId).toBe(dep.id);
    // cash leg S 1360 · H 1000 on 12.10., bank leg S 1200 · H 1360 on 13.10. → transit 0
    expect(await transitBalance(t)).toBe(0);
    owner = await jump(t, "2026-10-25T10:00:00Z");
    expect(await transitTodos(owner)).toEqual([]);
  });

  test("EC-CSH-15 CSH-024 a deposit whose bank credit is not booked stays open transit; after 7 days the warning", async () => {
    let { t, owner, eur } = await setup();
    const dep = await owner.action(api.cash.recordTransfer, {
      kind: "deposit_to_bank",
      date: "2026-10-12",
      amountCents: 20_000,
      bankAccountId: eur,
    });
    expect(await transitBalance(t)).toBe(20_000);
    owner = await jump(t, "2026-10-19T10:00:00Z");
    expect(await transitTodos(owner)).toEqual([]);
    owner = await jump(t, "2026-10-20T10:00:00Z");
    expect(await transitTodos(owner)).toEqual([
      ["cash_deposit_open", "Bareinzahlung vom 12.10.2026 (200,00 €) noch nicht auf dem Bankkonto gefunden."],
    ]);
    // The credit arrives (booked 8 days later, still within 10 days) → paired automatically, warning gone.
    const credit = await booked(t, eur, { bookingDate: "2026-10-20", amountCents: 20_000 });
    await owner.action(api.banking.mark, { transactionId: credit, as: "transfer" });
    expect(await transitTodos(owner)).toEqual([]);
    // A paired deposit is not reversed on its own; unmarking the credit reopens the transit.
    const blocked = await owner
      .mutation(api.cash.reverseTransfer, { id: dep.id, reason: "falsch erfasst" })
      .catch((x) => x);
    expect((blocked as { data?: { reason?: string } }).data?.reason).toBe("CASH_DEPOSIT_PAIRED");
    await owner.mutation(api.banking.unmark, { transactionId: credit, reason: "doch keine Bareinzahlung" });
    expect((await txOf(t, credit)).transferCashId).toBeUndefined();
    expect((await transitTodos(owner)).map(([k]) => k)).toEqual(["cash_deposit_open"]);
    expect(await transitBalance(t)).toBe(20_000);
  });
});

describe("Geldtransit between own accounts (BNK-061, E-ACC-23, EC-BNK-68, EC-BNK-20)", () => {
  test("BNK-061 T4 a transfer to the own savings account pairs both sides; unmarking one side unpairs both", async () => {
    const { t, owner, eur, savings } = await setup();
    const out = await booked(t, eur, {
      bookingDate: "2026-10-12",
      amountCents: -25_000,
      counterpartyIban: "DE89370400440532013000",
    });
    const inc = await booked(t, savings, { bookingDate: "2026-10-12", amountCents: 25_000 });
    await owner.action(api.banking.mark, { transactionId: out, as: "transfer" });
    expect((await txOf(t, out)).transferPeerId).toBeUndefined();
    await owner.action(api.banking.mark, { transactionId: inc, as: "transfer" });
    expect((await txOf(t, inc)).transferPeerId).toBe(out);
    expect((await txOf(t, out)).transferPeerId).toBe(inc);
    expect(await transitBalance(t)).toBe(0);
    await owner.mutation(api.banking.unmark, { transactionId: inc, reason: "falsches Konto" });
    expect((await txOf(t, out)).transferPeerId).toBeUndefined();
    expect((await txOf(t, inc)).status).toBe("open");
  });

  test("E-ACC-23 EC-BNK-68 an exchange whose other pocket side is missing: after 3 days named, after 7 days a warning", async () => {
    let { t, owner, eur } = await setup();
    const out = await booked(t, eur, {
      bookingDate: "2026-10-12",
      amountCents: -92_000,
      purpose: "Exchanged to USD",
      instructed: { amountMinor: 100_000, currency: "USD" },
    });
    await owner.action(api.banking.mark, { transactionId: out, as: "transfer" });
    expect(await transitTodos(owner)).toEqual([]);
    owner = await jump(t, "2026-10-16T10:00:00Z");
    expect(await transitTodos(owner)).toEqual([
      ["transit_missing", "Devisentausch/Umbuchung vom 12.10.2026: Gegenbuchung im Konto Revolut USD (USD) fehlt."],
    ]);
    owner = await jump(t, "2026-10-20T10:00:00Z");
    expect(await transitTodos(owner)).toEqual([
      ["transit_open", "Geldtransit vom 12.10.2026 über 920,00 € ohne Gegenbuchung."],
    ]);
  });

  test("EC-BNK-20 an exchange into a currency account that is not mapped: own side on Geldtransit, warning to add the account", async () => {
    const { t, owner, eur } = await setup();
    const out = await booked(t, eur, {
      bookingDate: "2026-10-12",
      amountCents: -11_500,
      purpose: "Exchanged to GBP",
      instructed: { amountMinor: 10_000, currency: "GBP" },
    });
    await owner.action(api.banking.mark, { transactionId: out, as: "transfer" });
    expect((await txOf(t, out)).status).toBe("transfer");
    expect(await transitBalance(t)).toBe(11_500);
    expect(await transitTodos(owner)).toEqual([
      ["transit_unmapped", "Gegenbuchung in einem nicht übernommenen Konto (GBP). Bitte Konto übernehmen."],
    ]);
  });
});

describe("Darlehen (BNK-062)", () => {
  const entryLines = (t: TestT, id: Id<"bankTransactions">) =>
    t.run(async (ctx) => {
      const entries = await ctx.db
        .query("journalEntries")
        .withIndex("by_source", (q) => q.eq("source.kind", "bankTransaction").eq("source.id", id))
        .collect();
      return entries.map((e) => ({
        explanation: e.explanation,
        lines: e.lines.map((l) => [l.account, l.debitCents, l.creditCents]),
      }));
    });

  test("BNK-062 T07-092 disbursement to 0630; repayment split into principal (0630) and interest (2100) with an Eigenbeleg", async () => {
    const { t, owner, eur } = await setup();
    const disb = await booked(t, eur, { bookingDate: "2026-10-01", amountCents: 1_000_000, purpose: "Darlehen 4711" });
    await owner.action(api.banking.mark, { transactionId: disb, as: "loan" });
    expect(await entryLines(t, disb)).toEqual([
      {
        explanation: "L1",
        lines: [
          ["1200", 1_000_000, 0],
          ["0630", 0, 1_000_000],
        ],
      },
    ]);
    const rate = await booked(t, eur, { bookingDate: "2026-10-10", amountCents: -55_000, purpose: "Rate 4711" });
    await owner.action(api.banking.mark, { transactionId: rate, as: "loan", loan: { interestCents: 5_000 } });
    expect(await entryLines(t, rate)).toEqual([
      {
        explanation: "L2",
        lines: [
          ["0630", 50_000, 0],
          ["2100", 5_000, 0],
          ["1200", 0, 55_000],
        ],
      },
    ]);
    const d = await owner.query(api.banking.transaction, { id: rate });
    expect(d?.status).toBe("booked");
    expect(d?.eigenbelege[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // „Markierung aufheben“ reverses the entry (Generalumkehr) and reopens the row.
    await owner.mutation(api.banking.unmark, { transactionId: rate, reason: "Rate falsch aufgeteilt" });
    expect((await txOf(t, rate)).status).toBe("open");
    expect(await entryLines(t, rate)).toHaveLength(2);
  });

  test("EC-BNK-75 a principal above the payment is blocked; nothing is posted", async () => {
    const { t, owner, eur } = await setup();
    const rate = await booked(t, eur, { bookingDate: "2026-10-10", amountCents: -55_000, purpose: "Rate 4711" });
    const e = await owner
      .action(api.banking.mark, { transactionId: rate, as: "loan", loan: { principalCents: 60_000 } })
      .catch((x) => x);
    expect(messageOf(e)).toBe("Der Tilgungsanteil übersteigt den Zahlbetrag.");
    expect((await txOf(t, rate)).status).toBe("open");
    expect(await entryLines(t, rate)).toEqual([]);
  });
});
