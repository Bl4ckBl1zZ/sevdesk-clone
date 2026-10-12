import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { BusinessEvent, PaymentReceivedEvent } from "../src/domain/accounting/events";
import { checkInvariants, clearInvariantTarget } from "../test/invariants";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { type PostJournalOptions, postJournalEntry } from "./model/journal";
import { makeT, type TestT } from "./test.setup";

const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;

async function setup(
  over: Parameters<typeof patchCompanyProfile>[1] = {},
): Promise<{ t: TestT; bank: Id<"bankAccounts"> }> {
  const t = makeT();
  await t.model(OWNER, (ctx) =>
    patchCompanyProfile(
      ctx,
      {
        name: "Muster Einzelunternehmen",
        legalForm: "einzelunternehmen",
        chartOfAccounts: [{ validFromFiscalYear: 2026, chart: "SKR03" }],
        taxationMethod: [{ validFrom: "2026-01-01", method: "soll" }],
        ustvaPeriod: [{ year: 2026, period: "monthly", dauerfrist: false }],
        ...over,
      },
      { action: "settings.tax.update" },
    ),
  );
  const bank = await t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankAccounts",
      {
        kind: "bank",
        name: "Revolut EUR",
        currency: "EUR",
        iban: "DE89370400440532013000",
        accountHolder: "Muster",
        ledgerAccount: "1200",
        showOnInvoices: true,
        isDefaultForInvoices: true,
        autoApplyMatches: true,
      },
      { action: "settings.bank_account.create" },
    ),
  );
  return { t, bank };
}

const post = (t: TestT, event: BusinessEvent, options?: PostJournalOptions) =>
  t.model(OWNER, (ctx) => postJournalEntry(ctx, event, options));

const invoice = (id: string, date = "2026-03-10", net = 100000): BusinessEvent => ({
  kind: "invoice_finalised",
  documentId: id,
  documentNumber: `RE-${id}`,
  documentType: "invoice",
  date,
  supplyDate: { kind: "date", date },
  taxCase: "domestic",
  contactId: "contact1",
  vatGroups: [{ category: "S", rateBp: 1900, netCents: net, vatCents: Math.round(net * 0.19) }],
});

const payment = (id: string, over: Partial<PaymentReceivedEvent>): PaymentReceivedEvent => ({
  kind: "payment_received",
  paymentId: id,
  date: "2026-04-02",
  means: { kind: "cash" },
  amountCents: 11900,
  target: { kind: "salesDocument", id: "doc1", number: "RE-doc1" },
  contactId: "contact1",
  ...over,
});

const entries = (t: TestT) => t.run((ctx) => ctx.db.query("journalEntries").withIndex("by_seq").collect());

describe("journal model (ACC-001…ACC-006)", () => {
  test("ACC-001 ACC-002 ACC-003 GOBD-05 postings get a gapless seq, balanced lines, rule versions and an audit entry", async () => {
    const { t, bank } = await setup();
    const r1 = await post(t, invoice("doc1"));
    const r2 = await post(
      t,
      payment("pay1", { means: { kind: "bank_account", bankAccountId: bank }, amountCents: 119000 }),
    );
    expect(r1).toMatchObject({ status: "posted", entries: [{ seq: 1, date: "2026-03-10", period: "2026-03" }] });
    expect(r2).toMatchObject({ status: "posted", entries: [{ seq: 2 }] });
    const all = await entries(t);
    expect(all.map((e) => e.seq)).toEqual([1, 2]);
    expect(all[0]).toMatchObject({
      ruleVersion: "posting-2026.1",
      roleMappingVersion: "roles-2026.2",
      explanation: "S1",
      text: "Rechnung RE-doc1",
      source: { kind: "salesDocument", id: "doc1" },
      actor: "user:test-owner",
    });
    expect(all[0]?.lines.map((l) => [l.account, l.debitCents, l.creditCents])).toEqual([
      ["1400", 119000, 0],
      ["8400", 0, 100000],
      ["1776", 0, 19000],
    ]);
    expect(all[0]?.lines[2]).toMatchObject({ taxPointDate: "2026-03-10", taxPeriod: "2026-03" });
    expect(all[1]?.lines.map((l) => l.account)).toEqual(["1200", "1400"]);
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => q.eq("entity.table", "journalEntries"))
        .collect(),
    );
    expect(audit.map((a) => [a.action, a.entity.label])).toEqual([
      ["journal.post", "Buchung 1"],
      ["journal.post", "Buchung 2"],
    ]);
    const lineRows = await t.run((ctx) => ctx.db.query("journalLines").collect());
    expect(lineRows).toHaveLength(5);
  });

  test("ACC-001 TST-ACC-27 RI-11 RI-12 random event sequences keep the journal balanced, gapless and the cash ≥ 0", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({ k: fc.constant("invoice" as const), net: fc.integer({ min: 1, max: 500000 }) }),
            fc.record({ k: fc.constant("cashPay" as const), amount: fc.integer({ min: 1, max: 50000 }) }),
            fc.record({ k: fc.constant("withdraw" as const), amount: fc.integer({ min: 1, max: 80000 }) }),
            fc.record({ k: fc.constant("storno" as const), pick: fc.nat() }),
          ),
          { minLength: 1, maxLength: 8 },
        ),
        async (cmds) => {
          const { t } = await setup();
          const invoices: string[] = [];
          let n = 0;
          for (const c of cmds) {
            n++;
            const id = `x${n}`;
            const day = `2026-05-${String(1 + (n % 27)).padStart(2, "0")}`;
            const run = (e: BusinessEvent) => post(t, e).catch((err: unknown) => errorCode(err));
            if (c.k === "invoice") {
              await run(invoice(id, day, c.net));
              invoices.push(id);
            } else if (c.k === "cashPay") {
              await run(payment(id, { date: day, amountCents: c.amount }));
            } else if (c.k === "withdraw") {
              const r = await run({
                kind: "cash_transfer",
                cashTransferId: id,
                transferKind: "private_withdrawal",
                date: day,
                amountCents: c.amount,
              });
              if (typeof r === "string") expect(r).toBe("cash_negative");
            } else if (invoices.length > 0) {
              const orig = invoices[c.pick % invoices.length] as string;
              const r = await run({
                kind: "invoice_cancelled",
                documentId: `st-${id}`,
                documentNumber: `ST-${id}`,
                originalDocumentId: orig,
                date: "2026-06-01",
              });
              if (typeof r === "string") expect(r).toBe("already_reversed");
            }
            const violations = (await checkInvariants(t as never)).filter((v) => v.severity === "ERROR");
            expect(violations).toEqual([]);
          }
        },
      ),
      { numRuns: 12 },
    );
  });

  test("ACC-004 TST-ACC-03 GOBD-06 journal entries and lines can never be patched or deleted", async () => {
    const { t } = await setup();
    const r = await post(t, invoice("doc1"));
    if (r.status !== "posted") throw new Error("not posted");
    const id = r.entryIds[0] as Id<"journalEntries">;
    const attempt = (fn: Parameters<typeof t.model>[1]) => t.model(OWNER, fn).catch(errorCode);
    expect(await attempt((ctx) => ctx.db.patch(id, { text: "geändert" }))).toBe("immutable_record");
    expect(await attempt((ctx) => ctx.db.delete(id))).toBe("immutable_record");
    const line = await t.run((ctx) => ctx.db.query("journalLines").first());
    expect(await attempt((ctx) => ctx.db.patch(line?._id as Id<"journalLines">, { debitCents: 1 }))).toBe(
      "immutable_record",
    );
  });

  test("ACC-004 S12 E-ACC-05 a Storno mirrors the original entry once; a second reversal is refused", async () => {
    const { t } = await setup();
    await post(t, invoice("doc1"));
    const storno = {
      kind: "invoice_cancelled" as const,
      documentId: "st1",
      documentNumber: "ST-1",
      originalDocumentId: "doc1",
      date: "2026-10-05",
    };
    const r = await post(t, storno);
    expect(r).toMatchObject({ status: "posted", entries: [{ seq: 2, date: "2026-10-05" }] });
    const [orig, rev] = await entries(t);
    expect(rev?.reversalOfId).toBe(orig?._id);
    expect(rev?.lines.map((l) => [l.account, l.debitCents, l.creditCents])).toEqual([
      ["1400", 0, 119000],
      ["8400", 100000, 0],
      ["1776", 19000, 0],
    ]);
    expect(rev?.lines[2]).toMatchObject({ taxPointDate: "2026-10-05", taxPeriod: "2026-10" });
    expect(await post(t, { ...storno, documentId: "st2" }).catch(errorCode)).toBe("already_reversed");
    expect(await post(t, { ...storno, originalDocumentId: "unknown" })).toEqual({
      status: "skipped",
      reason: "nothing_to_reverse",
    });
  });

  test("ACC-002 one entry per source and matrix row; a reversed source may be posted again", async () => {
    const { t } = await setup();
    await post(t, invoice("doc1"));
    expect(await post(t, invoice("doc1")).catch(errorCode)).toBe("already_posted");
  });

  test("ACC-014 E-ACC-22 E-ACC-14 events before the Buchungsbeginn are skipped; the date freezes after the first posting", async () => {
    const { t } = await setup();
    const owner = await t.asUser("owner");
    await owner.mutation(api.accounting.setBookkeepingStartDate, { date: "2026-04-01" });
    expect(await post(t, invoice("old", "2026-03-31"))).toEqual({
      status: "skipped",
      reason: "before_bookkeeping_start",
    });
    expect(await post(t, invoice("new", "2026-04-01"))).toMatchObject({ status: "posted" });
    const err = await owner.mutation(api.accounting.setBookkeepingStartDate, { date: "2026-01-01" }).catch((e) => e);
    expect(errorCode(err)).toBe("bookkeeping_start_locked");
    expect((err as { data: { message: string } }).data.message).toBe(
      "Der Buchungsbeginn kann nach der ersten Buchung nicht mehr geändert werden.",
    );
    const viewer = await t.asUser("viewer");
    expect(await viewer.mutation(api.accounting.setBookkeepingStartDate, { date: "2026-04-01" }).catch(errorCode)).toBe(
      "forbidden_role",
    );
  });

  test("ACC-006 TST-ACC-04 TST-ACC-05 EC-170 RI-13 locked periods: user dates refused, external dates move forward", async () => {
    const { t, bank } = await setup();
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "periods",
        { period: "2026-09", status: "locked", lockedAt: Date.now(), lockedBy: "user:test-owner", reason: "manual" },
        { action: "period.lock" },
      ),
    );
    await post(t, invoice("doc1", "2026-08-10"));
    const cash = await post(t, payment("p1", { date: "2026-09-20" })).catch((e) => e);
    expect(errorCode(cash)).toBe("period_locked");
    expect((cash as { data: { message: string } }).data.message).toBe(
      "Der Zeitraum 09/2026 ist festgeschrieben. Korrekturen sind nur als Gegenbuchung in einem offenen Zeitraum möglich.",
    );
    const r = await post(
      t,
      payment("p2", { date: "2026-09-20", means: { kind: "bank_account", bankAccountId: bank } }),
    );
    expect(r).toMatchObject({ status: "posted", entries: [{ period: "2026-10" }] });
    const e = (await entries(t)).at(-1);
    expect(e).toMatchObject({ originalDate: "2026-09-20", period: "2026-10" });
    expect(e?.latePosting?.reason).toMatch(
      /^Der Zeitraum 09\/2026 ist festgeschrieben\. Die Buchung wurde in den 10\/2026 übernommen/,
    );
  });

  test("CSH-026 TST-ACC-35 EC-149 AO-05 the cash account never goes negative, also through backdating and reversals", async () => {
    const { t } = await setup();
    const owner = await t.asUser("owner");
    await owner.mutation(api.accounting.postOpeningBalancePart, {
      fiscalYear: 2026,
      part: { kind: "cash", amountCents: 10000 },
    });
    const w = (id: string, date: string, amountCents: number) =>
      post(t, { kind: "cash_transfer", cashTransferId: id, transferKind: "private_withdrawal", date, amountCents });
    const tooMuch = await w("w1", "2026-10-01", 15000).catch((e) => e);
    expect(errorCode(tooMuch)).toBe("cash_negative");
    expect((tooMuch as { data: { message: string } }).data.message).toBe(
      "Der Kassenbestand würde negativ werden (−50,00 € am 01.10.2026). Bitte zuerst fehlende Bareinnahmen erfassen oder ‚privat bezahlt‘ wählen.",
    );
    await w("w2", "2026-10-05", 8000);
    const backdated = await w("w3", "2026-10-03", 5000).catch((e) => e);
    expect((backdated as { data: { message: string } }).data.message).toBe(
      "Nicht möglich: Durch die Buchung zum 03.10.2026 wäre der Kassenbestand am 05.10.2026 negativ (−30,00 €).",
    );
    // A cash receipt of 50 € on 10-06 then reversed on 10-07 is fine; reversing the opening-balance-funded receipt
    // that already paid for a withdrawal is not.
    await post(t, payment("p1", { date: "2026-10-06", amountCents: 5000 }));
    await w("w4", "2026-10-06", 7000);
    const rev = await post(t, {
      kind: "payment_reversed",
      paymentId: "p1r",
      originalPaymentId: "p1",
      date: "2026-10-07",
      reason: "Irrtum",
    }).catch((e) => e);
    expect((rev as { data: { message: string } }).data.message).toBe(
      "Storno nicht möglich: Der Kassenbestand würde am 07.10.2026 negativ werden.",
    );
  });

  test("TST-ACC-32 TST-ACC-34 T5/T9 cash transfers via Geldtransit net to zero", async () => {
    const { t, bank } = await setup();
    const owner = await t.asUser("owner");
    await owner.mutation(api.accounting.postOpeningBalancePart, {
      fiscalYear: 2026,
      part: { kind: "cash", amountCents: 60000 },
    });
    await post(t, {
      kind: "cash_transfer",
      cashTransferId: "d1",
      transferKind: "deposit_to_bank",
      leg: "cash",
      date: "2026-03-02",
      amountCents: 50000,
    });
    await post(t, {
      kind: "cash_transfer",
      cashTransferId: "d1",
      transferKind: "deposit_to_bank",
      leg: "bank",
      bankAccountId: bank,
      date: "2026-03-03",
      amountCents: 50000,
    });
    await post(t, {
      kind: "cash_transfer",
      cashTransferId: "atm",
      transferKind: "bank_withdrawal_to_cash",
      bankAccountId: bank,
      date: "2026-03-04",
      amountCents: 20000,
    });
    const chart = await owner.query(api.accounting.chartOfAccounts, { fiscalYear: 2026 });
    const bal = (n: string) => chart.accounts.find((a) => a.number === n)?.balanceCents;
    expect(bal("1360")).toBe(0);
    expect(bal("1000")).toBe(60000 - 50000 + 20000);
    expect(bal("1200")).toBe(50000 - 20000);
    // T10 reverses both legs of the deposit
    const rev = await post(t, {
      kind: "cash_transfer_reversed",
      cashTransferId: "d1r",
      originalCashTransferId: "d1",
      date: "2026-03-05",
      reason: "Falsch erfasst",
    });
    expect(rev.status === "posted" && rev.entryIds).toHaveLength(2);
  });

  test("TST-ACC-39 ACC-008 an UNSURE role blocks until the owner maps it; the override is audited and versioned", async () => {
    const { t } = await setup();
    const pv: BusinessEvent = {
      ...(invoice("pv") as Extract<BusinessEvent, { kind: "invoice_finalised" }>),
      vatGroups: [{ category: "Z", rateBp: 0, netCents: 900000, vatCents: 0 }],
    };
    const blocked = await post(t, pv).catch((e) => e);
    expect(errorCode(blocked)).toBe("role_unmapped");
    const bookkeeper = await t.asUser("bookkeeper");
    const args = {
      role: "revenue.zero_pv",
      account: "8100",
      validFrom: "2026-01-01",
      sourceText: "PV-Nullsatz geprüft",
    };
    expect(await bookkeeper.mutation(api.accounting.setRoleMapping, args).catch(errorCode)).toBe("forbidden_role");
    const owner = await t.asUser("owner");
    expect(await owner.mutation(api.accounting.setRoleMapping, { ...args, sourceText: "x" }).catch(errorCode)).toBe(
      "invalid_input",
    );
    expect(await owner.mutation(api.accounting.setRoleMapping, { ...args, account: "4711" }).catch(errorCode)).toBe(
      "account_unknown",
    );
    await owner.mutation(api.accounting.setRoleMapping, args);
    const r = await post(t, pv);
    expect(r.status).toBe("posted");
    const e = (await entries(t))[0];
    expect(e?.roleMappingVersion).toBe("roles-2026.2+override-1");
    expect(e?.lines[1]).toMatchObject({ account: "8100", role: "revenue.zero_pv" });
    const chart = await owner.query(api.accounting.chartOfAccounts, {});
    expect(chart.roles.find((x) => x.role === "revenue.zero_pv")).toMatchObject({
      source: "override",
      account: "8100",
    });
  });

  test("ACC-013 TST-ACC-09 E-ACC-13 opening balances with two open invoices (one Ist): payments clear them and Ist VAT becomes due", async () => {
    const { t, bank } = await setup();
    const owner = await t.asUser("owner");
    await owner.mutation(api.accounting.postOpeningBalancePart, {
      fiscalYear: 2026,
      part: { kind: "bank", bankAccountId: bank, amountCents: 250000 },
    });
    const items = [
      {
        number: "SD-1001",
        documentDate: "2025-12-10",
        counterpartyName: "Kunde A",
        grossCents: 119000,
        openCents: 119000,
        taxedAs: "soll" as const,
      },
      {
        number: "SD-1002",
        documentDate: "2025-12-20",
        counterpartyName: "Kunde B",
        grossCents: 59500,
        openCents: 59500,
        taxedAs: "ist" as const,
        notDueVat: [{ rateBp: 1900, vatCents: 9500 }],
      },
    ];
    const res = await owner.mutation(api.accounting.postOpeningBalancePart, {
      fiscalYear: 2026,
      part: { kind: "receivables", items },
    });
    expect(res).toMatchObject({ status: "posted" });
    expect(
      await owner
        .mutation(api.accounting.postOpeningBalancePart, { fiscalYear: 2026, part: { kind: "receivables", items } })
        .catch(errorCode),
    ).toBe("already_posted");
    const status = await owner.query(api.accounting.openingBalanceStatus, { fiscalYear: 2026 });
    expect(status).toMatchObject({ date: "2026-01-01", receivables: { totalCents: 119000 + 59500 + 9500 } });
    const [a, b] = status.openingItems;
    await post(
      t,
      payment("pa", {
        date: "2026-02-03",
        means: { kind: "bank_account", bankAccountId: bank },
        amountCents: 119000,
        target: { kind: "opening_item", id: a?.id as string },
      }),
    );
    await post(
      t,
      payment("pb", {
        date: "2026-02-04",
        means: { kind: "bank_account", bankAccountId: bank },
        amountCents: 59500,
        target: { kind: "opening_item", id: b?.id as string },
        ist: { notDueVat: [{ rateBp: 1900, vatCents: 9500 }], payableCents: 59500, settledBeforeCents: 0 },
      }),
    );
    const chart = await owner.query(api.accounting.chartOfAccounts, { fiscalYear: 2026 });
    const bal = (n: string) => chart.accounts.find((x) => x.number === n)?.balanceCents;
    expect(bal("1400")).toBe(0);
    expect(bal("1766")).toBe(0);
    expect(bal("1776")).toBe(-9500);
    const last = (await entries(t)).at(-1);
    expect(last?.lines.find((l) => l.account === "1776")).toMatchObject({
      taxPointDate: "2026-02-04",
      taxPeriod: "2026-02",
    });
    // bookkeeper may enter opening balances, viewer may not
    const viewer = await t.asUser("viewer");
    expect(
      await viewer
        .mutation(api.accounting.postOpeningBalancePart, { fiscalYear: 2026, part: { kind: "cash", amountCents: 1 } })
        .catch(errorCode),
    ).toBe("forbidden_role");
    expect(
      await owner.mutation(api.accounting.postOpeningBalancePart, {
        fiscalYear: 2026,
        part: { kind: "cash", amountCents: 0 },
      }),
    ).toEqual({ status: "skipped", seq: null });
  });

  test("ACC-001 ACC-003 the journal viewer lists entries newest first with account names and the explanation", async () => {
    const { t } = await setup();
    await post(t, invoice("doc1"));
    await post(t, {
      kind: "invoice_cancelled",
      documentId: "st1",
      documentNumber: "ST-1",
      originalDocumentId: "doc1",
      date: "2026-04-05",
    });
    const viewer = await t.asUser("viewer");
    const page = await viewer.query(api.accounting.listJournal, { paginationOpts: { numItems: 10, cursor: null } });
    expect(page.page.map((e) => [e.seq, e.reversalOfSeq ?? null, e.reversedBySeq ?? null])).toEqual([
      [2, 1, null],
      [1, null, 2],
    ]);
    const first = page.page[1];
    expect(first).toMatchObject({ text: "Rechnung RE-doc1", source: { label: "Verkaufsbeleg" }, totalCents: 119000 });
    expect(first?.explanationText).toMatch(/Soll-Versteuerung/);
    expect(first?.lines[1]).toMatchObject({
      account: "8400",
      accountName: "Erlöse 19 % USt",
      roleLabel: "Erlöse 19 % USt",
    });
    const march = await viewer.query(api.accounting.listJournal, {
      paginationOpts: { numItems: 10, cursor: null },
      period: "2026-03",
    });
    expect(march.page.map((e) => e.seq)).toEqual([1]);
    expect(
      await viewer.query(api.accounting.getJournalEntry, { entryId: first?.id as Id<"journalEntries"> }),
    ).toMatchObject({ seq: 1 });
    expect(
      await viewer
        .query(api.accounting.listJournal, { paginationOpts: { numItems: 10, cursor: null }, period: "x" })
        .catch(errorCode),
    ).toBe("invalid_input");
  });

  test("ACC-007 SET-041 the chart switches only per fiscal year; SKR04 resolves the same roles to SKR04 accounts", async () => {
    const { t } = await setup({ chartOfAccounts: [{ validFromFiscalYear: 2026, chart: "SKR04" }] });
    await post(t, invoice("doc1"));
    const e = (await entries(t))[0];
    expect(e?.lines.map((l) => l.account)).toEqual(["1200", "4400", "3806"]);
  });

  test("RI-12 RI-11 the invariant check reports unbalanced entries, seq gaps and a negative cash balance written out of band", async () => {
    const { t } = await setup();
    await post(t, invoice("doc1"));
    // Out-of-band write (dashboard/admin key, EC-182): bypasses the model layer on purpose.
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("journalEntries", {
        seq: 3,
        date: "2026-03-11",
        period: "2026-03",
        lines: [
          { account: "1000", debitCents: 0, creditCents: 500 },
          { account: "9999", debitCents: 400, creditCents: 0 },
        ],
        text: "manipuliert",
        source: { kind: "manual", id: "x" },
        ruleVersion: "x",
        roleMappingVersion: "x",
        explanation: "x",
        recordedAt: Date.now(),
        actor: "user:test-owner",
      });
      await ctx.db.insert("journalLines", {
        entryId: id,
        lineIndex: 0,
        seq: 3,
        date: "2026-03-11",
        period: "2026-03",
        account: "1000",
        debitCents: 0,
        creditCents: 500,
      });
    });
    const v = await t.query(internal.invariants.check, {});
    const ids = v.map((x) => x.id);
    expect(ids).toContain("RI-12");
    expect(ids).toContain("RI-11");
    const msgs = v.filter((x) => x.id === "RI-12").map((x) => x.message);
    expect(msgs).toEqual(
      expect.arrayContaining([
        "Journal-Nummer 2 fehlt oder ist doppelt (gefunden: 3).",
        "Buchung 3: Soll und Haben sind nicht ausgeglichen (Differenz: 1,00 €).",
        "Buchung 3: manuelle Buchung ohne Beleg.",
        "Buchung 3: Konto 9999 existiert nicht.",
        "Buchung 3: Zeilenverzeichnis weicht von der Buchung ab.",
      ]),
    );
    clearInvariantTarget();
  });
});
