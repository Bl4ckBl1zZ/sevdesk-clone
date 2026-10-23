import { describe, expect, test, vi } from "vitest";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { addDays, type CalendarDate } from "../src/domain/time/calendar-date";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { auditedInsert, auditedPatch } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { postJournalEntry } from "./model/journal";
import { bookedTransaction } from "./payments.fixtures";
import { makeT, type TestT } from "./test.setup";

// Cash movements emit outbound events (BNK-080): the SSRF guard must never resolve DNS for real.
vi.mock("./lib/webhookDns", () => ({ resolveHost: async () => ["93.184.216.34"] }));

/**
 * F07 cash branch coverage (CSH-020…027, EC-CSH-06/19/30/31/32): the transfer checks before the Eigenbeleg is
 * rendered, the Eigenbeleg data per kind, stored notes and reasons, and every refusal of the CSH-027 reversal.
 * Dates are relative to the real Berlin today (the cash dating rules use it).
 */

const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const TODAY = berlinCalendarDate(Date.now());
const day = (n: number) => addDays(TODAY as CalendarDate, n);
const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);
const reasonOf = (e: unknown) => dataOf(e).reason;

async function setup(
  opts: { legalForm?: "einzelunternehmen" | "gmbh"; address?: boolean; openingCents?: number } = {},
) {
  const t = makeT();
  await t.model(OWNER, (ctx) =>
    patchCompanyProfile(
      ctx,
      {
        name: opts.legalForm === "gmbh" ? "Muster Consulting GmbH" : "Muster Consulting e.K.",
        legalForm: opts.legalForm ?? "einzelunternehmen",
        ...(opts.address === false
          ? {}
          : {
              address: {
                name: "Muster Consulting",
                street: "Hauptstr. 1",
                postalCode: "10115",
                city: "Berlin",
                countryCode: "DE",
              },
            }),
        chartOfAccounts: [{ validFromFiscalYear: 2020, chart: "SKR03" }],
        taxationMethod: [{ validFrom: "2020-01-01", method: "soll" }],
        ustvaPeriod: [{ year: Number(TODAY.slice(0, 4)), period: "monthly", dauerfrist: false }],
      },
      { action: "settings.tax.update" },
    ),
  );
  const owner = await t.asUser("owner");
  const bank = (currency: string, iban?: string) =>
    t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "bankAccounts",
        {
          kind: "bank",
          name: `Konto ${currency}`,
          currency,
          ...(iban ? { iban } : {}),
          accountHolder: "Max Muster",
          ledgerAccount: currency === "EUR" ? "1200" : "1210",
          showOnInvoices: false,
          isDefaultForInvoices: false,
          autoApplyMatches: false,
        },
        { action: "settings.bank_account.create" },
      ),
    );
  const eur = await bank("EUR", "DE89370400440532013000");
  const eurNoIban = await bank("EUR");
  const usd = await bank("USD", "LT443250010000000101");
  if (opts.openingCents) {
    await t.model(OWNER, (ctx) =>
      postJournalEntry(ctx, {
        kind: "opening_balance",
        fiscalYear: Number(TODAY.slice(0, 4)),
        date: `${TODAY.slice(0, 4)}-01-01`,
        part: { kind: "cash", amountCents: opts.openingCents as number },
      }),
    );
  }
  return { t, owner, eur, eurNoIban, usd };
}

const transfers = (t: TestT) => t.run((ctx) => ctx.db.query("cashTransfers").collect());

describe("CSH-024 transfer checks before the Eigenbeleg (EC-CSH-06/19/30/31)", () => {
  test("CSH-024 without a company profile the cash dialog is refused as setup incomplete", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const e = await owner
      .query(api.cash.transferContext, { kind: "private_withdrawal", date: TODAY, amountCents: 100 })
      .catch(errorCode);
    expect(e).toBe("setup_incomplete");
  });

  test("EC-CSH-06 EC-CSH-19 EC-CSH-31 future date, amount 0, before the opening balance and a missing backdate reason are refused with their reason codes", async () => {
    const { owner } = await setup({ openingCents: 10_000 });
    const ctx = (date: string, amountCents = 100, backdateReason?: string) =>
      owner
        .query(api.cash.transferContext, {
          kind: "private_withdrawal",
          date,
          amountCents,
          ...(backdateReason ? { backdateReason } : {}),
        })
        .catch((x) => x);
    const future = await ctx(day(1));
    expect(errorCode(future)).toBe("invalid_input");
    expect(reasonOf(future)).toBe("CASH_DATE");
    expect(reasonOf(await ctx(TODAY, 0))).toBe("CASH_AMOUNT");
    expect(messageOf(await ctx(TODAY, 0))).toBe("Der Betrag muss größer als 0 sein.");
    const before = await ctx(`${Number(TODAY.slice(0, 4)) - 1}-12-31`, 100, "Nachtrag aus dem Vorjahr");
    expect(messageOf(before)).toMatch(/^Das Datum muss zwischen dem Anfangsbestand der Kasse \(01\.01\./);
    if (day(-11) >= `${TODAY.slice(0, 4)}-01-01`) {
      expect(reasonOf(await ctx(day(-11)))).toBe("BACKDATE_REASON_REQUIRED");
    }
  });

  test("CSH-024 a deposit needs an existing, active EUR bank account", async () => {
    const { t, owner, eur, usd } = await setup({ openingCents: 10_000 });
    const dep = (bankAccountId?: Id<"bankAccounts">) =>
      owner
        .query(api.cash.transferContext, {
          kind: "deposit_to_bank",
          date: TODAY,
          amountCents: 1_000,
          ...(bankAccountId ? { bankAccountId } : {}),
        })
        .catch((x) => x);
    expect(messageOf(await dep())).toBe("Bitte das Bankkonto angeben.");
    const foreign = await dep(usd);
    expect(errorCode(foreign)).toBe("invalid_input");
    expect(messageOf(foreign)).toBe("Bargeld kann nur auf ein EUR-Konto eingezahlt werden.");
    await t.model(OWNER, (ctx) =>
      auditedPatch(ctx, "bankAccounts", eur, { archivedAt: Date.now() }, { action: "settings.bank_account.update" }),
    );
    const archived = await dep(eur);
    expect(errorCode(archived)).toBe("not_found");
    expect(messageOf(archived)).toBe("Das Bankkonto existiert nicht.");
    expect(await transfers(t)).toHaveLength(0);
  });

  test("EC-CSH-32 a GmbH needs the shareholder name and a note; with both the Eigenbeleg is a shareholder withdrawal", async () => {
    const { owner } = await setup({ legalForm: "gmbh", openingCents: 10_000 });
    const args = { kind: "private_withdrawal" as const, date: TODAY, amountCents: 2_000 };
    const noNote = await owner
      .query(api.cash.transferContext, { ...args, shareholder: { name: "Max Muster", note: "  " } })
      .catch((x) => x);
    expect(reasonOf(noNote)).toBe("PRIVATE_WITHDRAWAL_CORPORATION");
    expect(messageOf(noNote)).toBe(
      "Kapitalgesellschaften haben kein Privatkonto. Bitte ‚Verrechnungskonto Gesellschafter‘ verwenden.",
    );
    const input = await owner.query(api.cash.transferContext, {
      ...args,
      shareholder: { name: "Max Muster", note: "Entnahme Oktober" },
    });
    expect(input).toMatchObject({
      kind: "cash_shareholder_withdrawal",
      shareholder: { name: "Max Muster", note: "Entnahme Oktober" },
      company: { name: "Muster Consulting GmbH", address: "Hauptstr. 1, 10115 Berlin" },
    });
    expect(input).not.toHaveProperty("account");
  });

  test("CSH-024 Eigenbeleg data: a sole trader's private withdrawal ignores shareholder data; note, reason and account label are carried", async () => {
    const { owner, eur, eurNoIban } = await setup({ address: false, openingCents: 10_000 });
    const priv = await owner.query(api.cash.transferContext, {
      kind: "private_withdrawal",
      date: day(-12),
      amountCents: 2_000,
      note: "Kaffeekasse",
      backdateReason: "Beleg nachgereicht",
      shareholder: { name: "Max Muster", note: "nicht relevant" },
    });
    expect(priv).toMatchObject({
      kind: "cash_private_withdrawal",
      note: "Kaffeekasse",
      backdateReason: "Beleg nachgereicht",
      reference: `Kasse ${day(-12)} 2000`,
      currency: "EUR",
    });
    expect(priv).not.toHaveProperty("shareholder");
    // no address entered: the Eigenbeleg shows the name only (blank address line)
    expect(priv?.company.name).toBe("Muster Consulting e.K.");
    expect(priv?.company.address?.trim()).toBe("");
    const withIban = await owner.query(api.cash.transferContext, {
      kind: "deposit_to_bank",
      date: TODAY,
      amountCents: 1_000,
      bankAccountId: eur,
    });
    expect(withIban).toMatchObject({ kind: "cash_deposit_to_bank", account: "Konto EUR (DE89370400440532013000)" });
    expect(withIban).not.toHaveProperty("note");
    const noIban = await owner.query(api.cash.transferContext, {
      kind: "deposit_to_bank",
      date: TODAY,
      amountCents: 1_000,
      bankAccountId: eurNoIban,
    });
    expect(noIban?.account).toBe("Konto EUR");
  });
});

describe("CSH-024 recording and CSH-027 reversal", () => {
  test("CSH-024 a backdated private withdrawal stores the trimmed note and reason, warns about daily recording, and is listed", async () => {
    const { t, owner } = await setup({ openingCents: 10_000 });
    const r = await owner.action(api.cash.recordTransfer, {
      kind: "private_withdrawal",
      date: day(-2),
      amountCents: 2_500,
      note: "  Kaffeekasse  ",
      backdateReason: "  Beleg nachgereicht  ",
    });
    expect(r.warning).toBe(
      "Bareinnahmen und -ausgaben sind täglich aufzuzeichnen (§ 146 Abs. 1 S. 2 AO). Bitte künftig am Tag der Zahlung erfassen.",
    );
    const [row] = await transfers(t);
    expect(row).toMatchObject({
      note: "Kaffeekasse",
      backdateReason: "Beleg nachgereicht",
      kind: "private_withdrawal",
    });
    expect(row?.bankAccountId).toBeUndefined();
    expect(row?.journalEntryIds).toHaveLength(1);
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .collect()
        .then((xs) => xs.filter((a) => a.action === "cash.transfer" && a.reason === "  Beleg nachgereicht  ")),
    );
    expect(audit.length).toBeGreaterThan(0);
    const ov = await owner.query(api.cash.overview, {});
    expect(ov.balanceCents).toBe(7_500);
    expect(ov.transfers[0]).toMatchObject({ note: "Kaffeekasse", fromBank: false, reversed: false });
    expect(ov.bankAccounts.map((a) => a.name).sort()).toEqual(["Konto EUR", "Konto EUR"]);

    // CSH-027: the reversal of a withdrawal without bank account is dated today and stores no bank account
    const id = row?._id as Id<"cashTransfers">;
    const rev = await owner.mutation(api.cash.reverseTransfer, { id, reason: "doppelt erfasst" });
    const reversal = await t.run((ctx) => ctx.db.get(rev));
    expect(reversal).toMatchObject({ date: TODAY, reversalOfId: id, reason: "doppelt erfasst" });
    expect(reversal?.bankAccountId).toBeUndefined();
    expect((await owner.query(api.cash.overview, {})).balanceCents).toBe(10_000);
  });

  test("CSH-027 reversal refusals: unknown id, reversing a reversal, a short reason, twice, and a deposit paired with a bank credit", async () => {
    const { t, owner, eur } = await setup({ openingCents: 50_000 });
    const dep = await owner.action(api.cash.recordTransfer, {
      kind: "deposit_to_bank",
      date: TODAY,
      amountCents: 10_000,
      bankAccountId: eur,
    });
    expect(await owner.mutation(api.cash.reverseTransfer, { id: dep.id, reason: "kurz" }).catch(messageOf)).toBe(
      "Bitte einen Grund angeben (mindestens 5 Zeichen).",
    );

    // the bank credit of the deposit is marked Geldtransit and pairs with it (EC-CSH-15 resolved)
    const credit = await bookedTransaction(t, eur, {
      bookingDate: TODAY,
      amountCents: 10_000,
      purpose: "Bareinzahlung",
    });
    await owner.action(api.banking.mark, { transactionId: credit, as: "transfer", cashTransferId: dep.id });
    expect((await t.run((ctx) => ctx.db.get(credit)))?.transferCashId).toBe(dep.id);
    const paired = await owner
      .mutation(api.cash.reverseTransfer, { id: dep.id, reason: "falscher Betrag" })
      .catch((x) => x);
    expect(reasonOf(paired)).toBe("CASH_DEPOSIT_PAIRED");
    expect(messageOf(paired)).toBe(
      "Die Bareinzahlung ist einer Gutschrift auf dem Bankkonto zugeordnet. Bitte zuerst die Markierung der Gutschrift aufheben.",
    );
    // unmark the credit first, then the deposit can be reversed (E-ACC-31)
    await owner.mutation(api.banking.unmark, { transactionId: credit, reason: "falscher Betrag" });
    const rev = await owner.mutation(api.cash.reverseTransfer, { id: dep.id, reason: "falscher Betrag" });
    expect((await t.run((ctx) => ctx.db.get(rev)))?.bankAccountId).toBe(eur);

    const twice = await owner
      .mutation(api.cash.reverseTransfer, { id: dep.id, reason: "falscher Betrag" })
      .catch(errorCode);
    expect(twice).toBe("already_reversed");
    const ofReversal = await owner
      .mutation(api.cash.reverseTransfer, { id: rev, reason: "Storno vom Storno" })
      .catch(messageOf);
    expect(ofReversal).toBe("Eine Stornobuchung kann nicht storniert werden.");
    const ov = await owner.query(api.cash.overview, {});
    expect(ov.transfers.find((x) => x.id === dep.id)?.reversed).toBe(true);
    expect(ov.balanceCents).toBe(50_000);

    await t.run((ctx) => ctx.db.delete(rev));
    expect(await owner.mutation(api.cash.reverseTransfer, { id: rev, reason: "gibt es nicht" }).catch(errorCode)).toBe(
      "not_found",
    );
  });

  test("CSH-025 CSH-027 an ATM withdrawal into the till is reversed by unmarking the bank row, not in the cash book", async () => {
    const { t, owner, eur } = await setup();
    const atm = await bookedTransaction(t, eur, { bookingDate: TODAY, amountCents: -20_000, purpose: "ATM" });
    await owner.action(api.banking.mark, { transactionId: atm, as: "cash_withdrawal" });
    const [fromBank] = await transfers(t);
    const e = await owner
      .mutation(api.cash.reverseTransfer, { id: fromBank?._id as Id<"cashTransfers">, reason: "doch nicht abgehoben" })
      .catch((x) => x);
    expect(reasonOf(e)).toBe("CASH_TRANSFER_FROM_BANK");
    expect(messageOf(e)).toBe("Bargeldabhebungen werden über „Markierung aufheben“ am Bankumsatz zurückgenommen.");
    expect(await transfers(t)).toHaveLength(1);
  });

  test("CSH-026 CSH-030 the projection and the report work on the cash account; a planned outflow beyond the balance is not ok", async () => {
    const { owner } = await setup({ openingCents: 10_000 });
    expect(await owner.query(api.cash.project, { date: TODAY, amountCents: 5_000 })).toMatchObject({ ok: true });
    expect(await owner.query(api.cash.project, { date: TODAY, amountCents: 15_000 })).toMatchObject({
      ok: false,
      minBalanceCents: -5_000,
    });
    const report = await owner.query(api.cash.reportCsv, { from: `${TODAY.slice(0, 4)}-01-01`, to: TODAY });
    expect(report.closingCents).toBe(10_000);
  });
});
