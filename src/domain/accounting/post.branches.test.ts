import { describe, expect, test } from "vitest";
import type {
  AdvancePaymentReceivedEvent,
  AssetDisposalEvent,
  BankTransactionMarkedEvent,
  CashTransferEvent,
  CustomerRefundEvent,
  InvoiceCorrectedEvent,
  InvoiceFinalisedEvent,
  OpeningBalanceEvent,
  PaymentReceivedEvent,
  VatGroup,
  WriteOffRecoveredEvent,
} from "./events";
import { mergeLines, type PostingContext, postEvent, type RoleLine } from "./post";

const SOLL: PostingContext = { taxationMethod: "soll", legalForm: "einzelunternehmen", ustvaPeriod: [] };
const IST: PostingContext = { ...SOLL, taxationMethod: "ist" };
const GMBH: PostingContext = { ...SOLL, legalForm: "gmbh" };

const S19 = (net: number): VatGroup => ({ category: "S", rateBp: 1900, netCents: net, vatCents: (net * 19) / 100 });

const invoice = (over: Partial<InvoiceFinalisedEvent> = {}): InvoiceFinalisedEvent => ({
  kind: "invoice_finalised",
  documentId: "doc1",
  documentNumber: "RE-2026-0001",
  documentType: "invoice",
  date: "2026-03-10",
  supplyDate: { kind: "date", date: "2026-03-05" },
  taxCase: "domestic",
  contactId: "c1",
  counterpartyName: "Muster GmbH",
  vatGroups: [S19(100000)],
  ...over,
});

const payment = (over: Partial<PaymentReceivedEvent> = {}): PaymentReceivedEvent => ({
  kind: "payment_received",
  paymentId: "pay1",
  date: "2026-04-02",
  means: { kind: "bank_account", bankAccountId: "b1" },
  amountCents: 119000,
  target: { kind: "salesDocument", id: "doc1", number: "RE-2026-0001" },
  contactId: "c1",
  ...over,
});

function lines(r: ReturnType<typeof postEvent>): RoleLine[] {
  if (!r.ok) throw new Error(r.error.message);
  if (r.value.kind !== "entry") throw new Error(`no entry: ${r.value.reason}`);
  return r.value.posting.lines;
}
const posting = (r: ReturnType<typeof postEvent>) => {
  if (!r.ok || r.value.kind !== "entry") throw new Error("no entry");
  return r.value.posting;
};
const brief = (ls: RoleLine[]) =>
  ls.map((l) => [l.role ?? l.account, l.debitCents > 0 ? "S" : "H", l.debitCents || l.creditCents]);
const errorOf = (r: ReturnType<typeof postEvent>) => (r.ok ? null : r.error);

describe("posting engine — sales documents (ACC-002)", () => {
  test("ACC-001 the booking text is cut to 60 characters with an ellipsis (DATEV Buchungstext)", () => {
    const p = posting(postEvent(invoice({ counterpartyName: "Sehr lange Firmenbezeichnung ".repeat(4) }), SOLL));
    expect(p.text).toHaveLength(60);
    expect(p.text.endsWith("…")).toBe(true);
    expect(p.text.startsWith("Rechnung RE-2026-0001 Sehr lange")).toBe(true);
    expect(posting(postEvent(invoice({ counterpartyName: undefined }), SOLL)).text).toBe("Rechnung RE-2026-0001");
  });

  test("ACC-002 non-integer amounts are refused instead of being rounded", () => {
    const r = postEvent(invoice({ vatGroups: [{ category: "S", rateBp: 1900, netCents: 100.5, vatCents: 19 }] }), SOLL);
    expect(errorOf(r)).toMatchObject({ code: "invalid_event", message: "Beträge müssen ganze Cent sein." });
  });

  test("ACC-002 a group's own revenue account (product/line account) replaces the default revenue role", () => {
    const ls = lines(postEvent(invoice({ vatGroups: [{ ...S19(10000), revenueAccount: "8401" }] }), SOLL));
    expect(brief(ls)).toEqual([
      ["receivable", "S", 11900],
      ["8401", "H", 10000],
      ["vat.output.19", "H", 1900],
    ]);
    expect(ls[1]).toMatchObject({ taxKey: "USt19", taxPointDate: "2026-03-05" });
  });

  test("UST-41 advances can only be deducted in a Schlussrechnung; deduction rates and amounts are checked", () => {
    const deduction = { advanceDocumentId: "adv1", rateBp: 1900, netCents: 10000, vatCents: 1900 };
    expect(errorOf(postEvent(invoice({ advanceDeductions: [deduction] }), SOLL))?.message).toBe(
      "Anzahlungen können nur in einer Schlussrechnung verrechnet werden.",
    );
    const final = (d: typeof deduction) => invoice({ documentType: "final_invoice", advanceDeductions: [d] });
    expect(errorOf(postEvent(final({ ...deduction, rateBp: 1600 }), SOLL))).toMatchObject({
      code: "rate_not_supported",
      params: { rateBp: 1600 },
    });
    expect(errorOf(postEvent(final({ ...deduction, vatCents: 19.5 }), SOLL))?.message).toBe(
      "Beträge müssen ganze Cent sein.",
    );
  });

  test("UST-41 EC-073 Ist final invoice: a positive remainder is not yet due, a negative one corrects the advance VAT", () => {
    // 1 000 € net at 19 %, 300 € net advance at 19 % → 133 € VAT remainder, parked as not due.
    const positive = lines(
      postEvent(
        invoice({
          documentType: "final_invoice",
          advanceDeductions: [{ advanceDocumentId: "a", rateBp: 1900, netCents: 30000, vatCents: 5700 }],
        }),
        IST,
      ),
    );
    expect(brief(positive)).toEqual([
      ["receivable", "S", 119000],
      ["revenue.domestic.19", "H", 100000],
      ["vat.output.notdue.19", "H", 13300],
      ["advance.received.19", "S", 30000],
      ["receivable", "H", 35700],
    ]);
    // EC-073: rate changed 19 → 7 %; the final invoice has 7 % only, the 19 % advance VAT is corrected in the period.
    const negative = lines(
      postEvent(
        invoice({
          documentType: "final_invoice",
          vatGroups: [{ category: "S", rateBp: 700, netCents: 100000, vatCents: 7000 }],
          advanceDeductions: [{ advanceDocumentId: "a", rateBp: 1900, netCents: 30000, vatCents: 5700 }],
        }),
        IST,
      ),
    );
    expect(brief(negative)).toEqual([
      ["receivable", "S", 107000],
      ["revenue.domestic.7", "H", 100000],
      ["vat.output.19", "S", 5700],
      ["vat.output.notdue.7", "H", 7000],
      ["advance.received.19", "S", 30000],
      ["receivable", "H", 35700],
    ]);
    expect(negative.find((l) => l.role === "vat.output.19")?.taxPointDate).toBe("2026-03-10");
  });

  test("ACC-002 a correction with an imported unknown tax case or an unsupported rate is refused", () => {
    const corr = (over: Partial<InvoiceCorrectedEvent>): InvoiceCorrectedEvent => ({
      kind: "invoice_corrected",
      documentId: "k1",
      documentNumber: "RK-2026-0001",
      correctedDocumentId: "doc1",
      date: "2026-04-10",
      taxCase: "domestic",
      contactId: "c1",
      vatGroups: [S19(-10000)],
      ...over,
    });
    expect(errorOf(postEvent(corr({ taxCase: "unknown_imported" }), SOLL))?.code).toBe("tax_case_not_postable");
    expect(
      errorOf(postEvent(corr({ vatGroups: [{ category: "S", rateBp: 1600, netCents: -100, vatCents: -16 }] }), SOLL))
        ?.code,
    ).toBe("rate_not_supported");
  });
});

describe("posting engine — payment differences (PAY-020)", () => {
  test("PAY-020 a customer credit balance carries no differences; difference amounts must be whole cents ≠ 0", () => {
    const credit = postEvent(
      payment({
        target: { kind: "contactCredit", id: "c1" },
        differences: [{ reason: "bank_fees", amountCents: 100 }],
      }),
      SOLL,
    );
    expect(errorOf(credit)?.message).toBe("Ein Kundenguthaben kann keine Differenzen enthalten.");
    expect(errorOf(postEvent(payment({ differences: [{ reason: "bank_fees", amountCents: 0 }] }), SOLL))?.message).toBe(
      "Differenzbeträge müssen ganze Cent ≠ 0 sein.",
    );
    expect(
      errorOf(postEvent(payment({ differences: [{ reason: "bank_fees", amountCents: 1.5 }] }), SOLL))?.message,
    ).toBe("Differenzbeträge müssen ganze Cent ≠ 0 sein.");
  });

  test("E-TAX-14 „Sonstige Differenz“ without VAT correction goes to the chosen account; with one it splits the VAT", () => {
    const plain = lines(
      postEvent(
        payment({ amountCents: 118000, differences: [{ reason: "other", amountCents: 1000, account: "4970" }] }),
        SOLL,
      ),
    );
    expect(brief(plain)).toEqual([
      ["bank.b1", "S", 118000],
      ["4970", "S", 1000],
      ["receivable", "H", 119000],
    ]);
    // A price reduction of 11.90 € gross at 19 % reduces the output VAT (§17 UStG).
    const withVat = lines(
      postEvent(
        payment({
          amountCents: 117810,
          differences: [
            {
              reason: "other",
              amountCents: 1190,
              account: "8700",
              vatCorrection: [{ rateBp: 1900, netCents: 1000, vatCents: 190 }],
            },
          ],
        }),
        SOLL,
      ),
    );
    expect(brief(withVat)).toEqual([
      ["bank.b1", "S", 117810],
      ["8700", "S", 1000],
      ["vat.output.19", "S", 190],
      ["receivable", "H", 119000],
    ]);
    expect(withVat[1]?.taxKey).toBe("USt19");
    expect(withVat[2]?.taxPointDate).toBe("2026-04-02");
  });

  test("UST-32 the VAT correction must add up to the difference and use a supported rate", () => {
    const skonto = (vatCorrection: { rateBp: number; netCents: number; vatCents: number }[], amountCents = 2380) =>
      postEvent(
        payment({ amountCents: 119000 - amountCents, differences: [{ reason: "skonto", amountCents, vatCorrection }] }),
        SOLL,
      );
    expect(errorOf(skonto([{ rateBp: 1900, netCents: 2000, vatCents: 300 }]))?.message).toBe(
      "Die Umsatzsteuerkorrektur ergibt nicht den Differenzbetrag.",
    );
    expect(errorOf(skonto([{ rateBp: 1600, netCents: 2052, vatCents: 328 }]))?.code).toBe("rate_not_supported");
    expect(errorOf(skonto([{ rateBp: 0, netCents: 2000, vatCents: 380 }]))?.message).toBe(
      "Ohne Steuersatz keine Umsatzsteuerkorrektur.",
    );
    // Skonto on a 0 % item has no Skonto role (only 19/7) → blocked rather than guessed.
    expect(errorOf(skonto([{ rateBp: 0, netCents: 2380, vatCents: 0 }]))?.code).toBe("rate_not_supported");
  });

  test("UST-30 a write-off of a tax-free item goes to writeoff.0 without a VAT line; a 0 € VAT share adds no VAT line", () => {
    const ls = lines(
      postEvent(
        payment({
          means: { kind: "none" },
          amountCents: 0,
          differences: [
            {
              reason: "write_off",
              amountCents: 15000,
              vatCorrection: [
                { rateBp: 0, netCents: 5000, vatCents: 0 },
                { rateBp: 1900, netCents: 10000, vatCents: 0 },
              ],
            },
          ],
        }),
        SOLL,
      ),
    );
    expect(brief(ls)).toEqual([
      ["writeoff.0", "S", 5000],
      ["writeoff.19", "S", 10000],
      ["receivable", "H", 15000],
    ]);
    expect(ls[0]?.taxKey).toBeUndefined();
    expect(ls[1]?.taxKey).toBe("USt19");
  });

  test("PAY-020 differences can never settle less than nothing", () => {
    const r = postEvent(
      payment({ amountCents: 1000, differences: [{ reason: "dunning_fees", amountCents: -2000 }] }),
      SOLL,
    );
    expect(errorOf(r)?.message).toBe("Die Differenzen übersteigen den Zahlbetrag.");
  });

  test("E-TAX-12 an Ist basis with an unsupported rate is refused", () => {
    const r = postEvent(
      payment({ ist: { notDueVat: [{ rateBp: 1600, vatCents: 1600 }], payableCents: 11600, settledBeforeCents: 0 } }),
      SOLL,
    );
    expect(errorOf(r)?.code).toBe("rate_not_supported");
  });

  test("PAY-032 booking texts without a document number: Ausfall, Verrechnung", () => {
    const writeOff = posting(
      postEvent(
        payment({
          means: { kind: "none" },
          amountCents: 0,
          target: { kind: "opening_item", id: "o1" },
          differences: [
            { reason: "write_off", amountCents: 500, vatCorrection: [{ rateBp: 0, netCents: 500, vatCents: 0 }] },
          ],
        }),
        SOLL,
      ),
    );
    expect(writeOff.text).toBe("Ausfall");
    expect(writeOff.explanation).toBe("P8");
    const credit = posting(
      postEvent(payment({ means: { kind: "customer_credit" }, target: { kind: "salesDocument", id: "doc1" } }), SOLL),
    );
    expect(credit.text).toBe("Verrechnung");
    expect(credit.explanation).toBe("P12");
    const plain = posting(postEvent(payment({ target: { kind: "salesDocument", id: "doc1" } }), SOLL));
    expect(plain.text).toBe("Zahlung");
  });
});

describe("posting engine — advances, refunds, recoveries (UST-40, PAY-033, UST-30)", () => {
  const advance = (over: Partial<AdvancePaymentReceivedEvent> = {}): AdvancePaymentReceivedEvent => ({
    kind: "advance_payment_received",
    paymentId: "p1",
    date: "2026-03-20",
    means: { kind: "bank_account", bankAccountId: "b1" },
    amountCents: 11900,
    advance: {
      documentId: "adv1",
      vatGroups: [{ rateBp: 1900, netCents: 10000, vatCents: 1900 }],
      payableCents: 11900,
      settledBeforeCents: 0,
    },
    contactId: "c1",
    ...over,
  });

  test("UST-40 an advance payment needs a payment means, a positive amount and a supported rate", () => {
    const msg = "Eine Anzahlung braucht einen Zahlungsweg und einen Betrag > 0.";
    expect(errorOf(postEvent(advance({ means: { kind: "none" } }), SOLL))?.message).toBe(msg);
    expect(errorOf(postEvent(advance({ amountCents: 0 }), SOLL))?.message).toBe(msg);
    expect(errorOf(postEvent(advance({ amountCents: 10.5 }), SOLL))?.message).toBe(msg);
    const r16 = advance({
      advance: {
        documentId: "a",
        vatGroups: [{ rateBp: 1600, netCents: 100, vatCents: 16 }],
        payableCents: 116,
        settledBeforeCents: 0,
      },
      amountCents: 116,
    });
    expect(errorOf(postEvent(r16, SOLL))?.code).toBe("rate_not_supported");
  });

  test("UST-40 more than the open amount of the Abschlagsrechnung is refused; the text works without a number", () => {
    expect(errorOf(postEvent(advance({ amountCents: 20000 }), SOLL))?.message).toBe(
      "Die Anzahlung übersteigt den offenen Betrag der Abschlagsrechnung.",
    );
    const p = posting(postEvent(advance(), SOLL));
    expect(p.text).toBe("Anzahlung");
    expect(brief(p.lines)).toEqual([
      ["bank.b1", "S", 11900],
      ["advance.received.19", "H", 10000],
      ["vat.output.19", "H", 1900],
    ]);
  });

  const refund = (over: Partial<CustomerRefundEvent> = {}): CustomerRefundEvent => ({
    kind: "customer_refund",
    paymentId: "r1",
    date: "2026-05-02",
    means: { kind: "cash" },
    amountCents: 5000,
    contactId: "c1",
    ...over,
  });

  test("PAY-033 a refund must be positive; an Ist basis with an unsupported rate is refused", () => {
    expect(errorOf(postEvent(refund({ amountCents: 0 }), SOLL))?.message).toBe(
      "Der Erstattungsbetrag muss größer als 0 sein.",
    );
    expect(errorOf(postEvent(refund({ amountCents: -5 }), SOLL))?.message).toBe(
      "Der Erstattungsbetrag muss größer als 0 sein.",
    );
    const ist = refund({
      ist: { notDueVat: [{ rateBp: 500, vatCents: 238 }], payableCents: 5000, settledBeforeCents: 0 },
    });
    expect(errorOf(postEvent(ist, SOLL))?.code).toBe("rate_not_supported");
    // An Ist basis whose VAT is all zero (0 % credit) is a plain P11.
    const zero = posting(
      postEvent(
        refund({ ist: { notDueVat: [{ rateBp: 1900, vatCents: 0 }], payableCents: 5000, settledBeforeCents: 0 } }),
        SOLL,
      ),
    );
    expect(zero.explanation).toBe("P11");
    expect(zero.text).toBe("Erstattung");
    expect(brief(zero.lines)).toEqual([
      ["receivable", "S", 5000],
      ["cash", "H", 5000],
    ]);
  });

  const recovery = (recovered: WriteOffRecoveredEvent["recovered"], over: Partial<WriteOffRecoveredEvent> = {}) =>
    postEvent(
      {
        kind: "writeoff_recovered",
        paymentId: "w1",
        date: "2026-08-01",
        means: { kind: "bank_account", bankAccountId: "b1" },
        recovered,
        contactId: "c1",
        ...over,
      },
      SOLL,
    );

  test("UST-30 P9 a recovered write-off: VAT due again on receipt, a 0 % share has no VAT line", () => {
    const p = posting(
      recovery(
        [
          { rateBp: 1900, netCents: 10000, vatCents: 1900 },
          { rateBp: 0, netCents: 500, vatCents: 0 },
        ],
        { documentNumber: "RE-2025-0042" },
      ),
    );
    expect(p.explanation).toBe("P9");
    expect(p.text).toBe("Eingang abgeschr. Forderung RE-2025-0042");
    expect(brief(p.lines)).toEqual([
      ["bank.b1", "S", 12400],
      ["writeoff.recovery", "H", 10500],
      ["vat.output.19", "H", 1900],
    ]);
    expect(p.lines[2]?.taxPointDate).toBe("2026-08-01");
    expect(posting(recovery([{ rateBp: 0, netCents: 500, vatCents: 0 }])).text).toBe("Eingang abgeschr. Forderung");
  });

  test("UST-30 P9 a recovery needs an amount > 0 and a supported rate", () => {
    expect(errorOf(recovery([]))?.message).toBe("Es fehlt der wiedereingegangene Betrag.");
    expect(errorOf(recovery([{ rateBp: 1600, netCents: 100, vatCents: 16 }]))?.code).toBe("rate_not_supported");
    expect(errorOf(recovery([{ rateBp: 0, netCents: 0, vatCents: 0 }]))?.message).toBe(
      "Der wiedereingegangene Betrag muss größer als 0 sein.",
    );
  });
});

describe("posting engine — cash transfers and bank marks (CSH-024/025, BNK-060/061/028)", () => {
  const transfer = (over: Partial<CashTransferEvent>): CashTransferEvent => ({
    kind: "cash_transfer",
    cashTransferId: "t1",
    transferKind: "deposit_to_bank",
    date: "2026-03-01",
    amountCents: 50000,
    ...over,
  });

  test("CSH-024 a transfer must be positive; the bank leg of a deposit needs the bank account", () => {
    expect(errorOf(postEvent(transfer({ amountCents: 0 }), SOLL))?.message).toBe("Der Betrag muss größer als 0 sein.");
    expect(errorOf(postEvent(transfer({ amountCents: 1.5 }), SOLL))?.message).toBe(
      "Der Betrag muss größer als 0 sein.",
    );
    expect(errorOf(postEvent(transfer({ leg: "bank" }), SOLL))?.message).toBe("Bitte das Bankkonto angeben.");
    expect(errorOf(postEvent(transfer({ transferKind: "bank_withdrawal_to_cash" }), SOLL))?.message).toBe(
      "Bitte das Bankkonto angeben.",
    );
  });

  test("CSH-025 an ATM fee must be whole cents ≥ 0; without a fee the bank is credited with the cash amount", () => {
    const atm = (feeCents?: number) =>
      postEvent(transfer({ transferKind: "bank_withdrawal_to_cash", bankAccountId: "b1", feeCents }), SOLL);
    expect(errorOf(atm(-1))?.message).toBe("Die Gebühr ist ungültig.");
    expect(errorOf(atm(0.5))?.message).toBe("Die Gebühr ist ungültig.");
    expect(brief(lines(atm()))).toEqual([
      ["transit", "S", 50000],
      ["bank.b1", "H", 50000],
      ["cash", "S", 50000],
      ["transit", "H", 50000],
    ]);
  });

  const mark = (over: Partial<BankTransactionMarkedEvent>): BankTransactionMarkedEvent => ({
    kind: "bank_transaction_marked",
    transactionId: "tx1",
    mark: "private",
    date: "2026-03-03",
    amountCents: -20000,
    bankAccountId: "b1",
    ...over,
  });

  test("BNK-060 invalid bank amounts are refused (zero, fractions, negative fee, fee ≥ outflow)", () => {
    const msg = "Der Betrag des Bankumsatzes ist ungültig.";
    expect(errorOf(postEvent(mark({ amountCents: 0 }), SOLL))?.message).toBe(msg);
    expect(errorOf(postEvent(mark({ amountCents: -10.5 }), SOLL))?.message).toBe(msg);
    expect(errorOf(postEvent(mark({ feeCents: -1 }), SOLL))?.message).toBe(msg);
    expect(errorOf(postEvent(mark({ feeCents: 0.5 }), SOLL))?.message).toBe(msg);
    expect(errorOf(postEvent(mark({ feeCents: 20000 }), SOLL))?.message).toBe(msg);
  });

  test("BNK-060 ACC-028 E-ACC-30 a corporation's private mark goes to the shareholder clearing account", () => {
    expect(errorOf(postEvent(mark({}), GMBH))?.code).toBe("private_withdrawal_corporation");
    expect(errorOf(postEvent(mark({ shareholder: { name: "Anna", note: " " } }), GMBH))?.message).toContain(
      "Bei einer GmbH gibt es keine Privatentnahmen",
    );
    const out = posting(postEvent(mark({ shareholder: { name: "Anna Muster", note: "Darlehen" } }), GMBH));
    expect(out).toMatchObject({ explanation: "T1-corp", text: "Entnahme Verrechnung Anna Muster" });
    expect(brief(out.lines)).toEqual([
      ["shareholder.clearing", "S", 20000],
      ["bank.b1", "H", 20000],
    ]);
    const inflow = posting(
      postEvent(mark({ amountCents: 30000, shareholder: { name: "Anna Muster", note: "Einlage" } }), {
        ...SOLL,
        legalForm: "ug",
      }),
    );
    expect(inflow).toMatchObject({ explanation: "T2-corp", text: "Einlage Verrechnung Anna Muster" });
    expect(brief(inflow.lines)).toEqual([
      ["bank.b1", "S", 30000],
      ["shareholder.clearing", "H", 30000],
    ]);
  });

  const fx = (eurCents: number, costCents: number) => ({
    currency: "USD",
    eurCents,
    costCents,
    rate: { rate: "1.0850", source: "ecb_daily" as const, date: "2026-03-03" },
  });

  test("BNK-028 an invalid EUR valuation of a foreign-currency transfer is refused", () => {
    const msg = "Die EUR-Bewertung des Fremdwährungsumsatzes ist ungültig.";
    const t = (over: Partial<BankTransactionMarkedEvent>) => postEvent(mark({ mark: "transfer", ...over }), SOLL);
    expect(errorOf(t({ fx: fx(10000, 10000), feeCents: 100 }))?.message).toBe(msg);
    expect(errorOf(t({ fx: fx(0, 0) }))?.message).toBe(msg);
    expect(errorOf(t({ fx: fx(10000, -1) }))?.message).toBe(msg);
    expect(errorOf(t({ fx: fx(100.5, 100) }))?.message).toBe(msg);
    expect(errorOf(t({ fx: fx(100, 100.5) }))?.message).toBe(msg);
  });

  test("BNK-028 ACC-023 R2 an outflow with zero moving-average cost books the whole EUR value as FX gain", () => {
    const ls = lines(postEvent(mark({ mark: "transfer", fx: fx(10000, 0) }), SOLL));
    expect(brief(ls)).toEqual([
      ["transit", "S", 10000],
      ["income.fx_gain", "H", 10000],
    ]);
  });
});

describe("posting engine — opening balances and assets (ACC-013, AST-009, AST-010)", () => {
  const opening = (part: OpeningBalanceEvent["part"]) =>
    postEvent({ kind: "opening_balance", fiscalYear: 2026, date: "2026-01-01", part }, SOLL);

  test("ACC-013 the cash opening balance can't be negative; zero produces no entry", () => {
    expect(errorOf(opening({ kind: "cash", amountCents: -1 }))?.message).toBe(
      "Der Kassenbestand kann nicht negativ sein (Kasse nie im Minus).",
    );
    expect(errorOf(opening({ kind: "cash", amountCents: 1.5 }))?.code).toBe("invalid_event");
    expect(opening({ kind: "cash", amountCents: 0 })).toEqual({
      ok: true,
      value: { kind: "none", reason: "zero_amount" },
    });
  });

  test("ACC-013 bank opening balances: whole cents, zero is no entry, a negative balance (overdraft) is credited", () => {
    expect(errorOf(opening({ kind: "bank", bankAccountId: "b1", amountCents: 0.5 }))?.message).toBe(
      "Beträge müssen ganze Cent sein.",
    );
    expect(opening({ kind: "bank", bankAccountId: "b1", amountCents: 0 })).toEqual({
      ok: true,
      value: { kind: "none", reason: "zero_amount" },
    });
    const p = posting(opening({ kind: "bank", bankAccountId: "b1", amountCents: 250000 }));
    expect(p).toMatchObject({ text: "Eröffnungsbilanz 2026 Bank", explanation: "ACC-013-bank" });
    expect(brief(p.lines)).toEqual([
      ["bank.b1", "S", 250000],
      ["opening.gl", "H", 250000],
    ]);
  });

  test("ACC-013 open receivables: at least one item, each > 0, contact optional, Ist VAT with a supported rate", () => {
    expect(errorOf(opening({ kind: "receivables", items: [] }))?.message).toBe(
      "Es sind keine offenen Forderungen angegeben.",
    );
    const item = { openingItemId: "o1", number: "RE-2025-0099", openCents: 11900, taxedAs: "soll" as const };
    expect(errorOf(opening({ kind: "receivables", items: [{ ...item, openCents: 0 }] }))?.message).toBe(
      "Offener Betrag von RE-2025-0099 muss größer als 0 sein.",
    );
    expect(
      errorOf(
        opening({
          kind: "receivables",
          items: [{ ...item, taxedAs: "ist", notDueVat: [{ rateBp: 1600, vatCents: 1600 }] }],
        }),
      )?.code,
    ).toBe("rate_not_supported");
    const p = posting(
      opening({
        kind: "receivables",
        items: [item, { ...item, openingItemId: "o2", number: "RE-2025-0100", taxedAs: "ist" }],
      }),
    );
    expect(brief(p.lines)).toEqual([
      ["receivable", "S", 11900],
      ["opening.debtors", "H", 11900],
      ["receivable", "S", 11900],
      ["opening.debtors", "H", 11900],
    ]);
    expect(p.lines[0]?.contactId).toBeUndefined();
  });

  const depreciation = (amountCents: number) =>
    postEvent(
      {
        kind: "asset_depreciation",
        assetId: "as1",
        inventoryNumber: "INV-0001",
        name: "Laptop",
        period: "2026-03",
        date: "2026-03-31",
        amountCents,
        assetAccount: "0650",
        afaRole: "afa.tangible",
      },
      SOLL,
    );

  test("AST-009 a negative or fractional AfA amount is refused", () => {
    expect(errorOf(depreciation(-100))?.message).toBe("Der AfA-Betrag ist ungültig.");
    expect(errorOf(depreciation(10.5))?.message).toBe("Der AfA-Betrag ist ungültig.");
  });

  const disposal = (over: Partial<AssetDisposalEvent>, ctx = SOLL) =>
    postEvent(
      {
        kind: "asset_disposal",
        assetId: "as1",
        inventoryNumber: "INV-0001",
        name: "Laptop",
        date: "2026-06-30",
        disposalKind: "withdrawal",
        assetAccount: "0650",
        rbwCents: 40000,
        ...over,
      },
      ctx,
    );

  test("AST-010 disposal: invalid book value, withdrawal values checked, a corporation cannot withdraw", () => {
    expect(errorOf(disposal({ rbwCents: -1 }))?.message).toBe("Der Restbuchwert ist ungültig.");
    expect(errorOf(disposal({ rbwCents: 1.5 }))?.message).toBe("Der Restbuchwert ist ungültig.");
    expect(errorOf(disposal({ withdrawal: { teilwertCents: -1, vatCents: 0 } }))?.message).toBe(
      "Teilwert oder Umsatzsteuer der Entnahme sind ungültig.",
    );
    expect(errorOf(disposal({ withdrawal: { teilwertCents: 100, vatCents: -19 } }))?.message).toBe(
      "Teilwert oder Umsatzsteuer der Entnahme sind ungültig.",
    );
    expect(errorOf(disposal({}, GMBH))?.message).toContain("Bitte die Überlassung an den Gesellschafter als Verkauf");
  });

  test("AST-010 D7 a withdrawal without Teilwert data books only the book value; with VAT the revenue gets USt19", () => {
    expect(brief(lines(disposal({})))).toEqual([
      ["disposal.rbw.loss", "S", 40000],
      ["0650", "H", 40000],
    ]);
    const withVat = lines(disposal({ withdrawal: { teilwertCents: 30000, vatCents: 5700 } }));
    expect(brief(withVat)).toEqual([
      ["private.withdrawal", "S", 35700],
      ["revenue.withdrawal.19", "H", 30000],
      ["vat.output.19", "H", 5700],
      ["disposal.rbw.loss", "S", 40000],
      ["0650", "H", 40000],
    ]);
    expect(withVat[1]?.taxKey).toBe("USt19");
    const noVat = lines(disposal({ withdrawal: { teilwertCents: 30000, vatCents: 0 } }));
    expect(noVat.find((l) => l.role === "revenue.withdrawal.19")?.taxKey).toBeUndefined();
  });
});

describe("mergeLines (ACC-023)", () => {
  test("ACC-023 merged foreign-currency lines keep the summed source amount; lines without FX stay without", () => {
    const fxRate = { rate: "1.10", source: "manual" as const, date: "2026-03-01" };
    const merged = mergeLines([
      { account: "1200", debitCents: 1000, creditCents: 0, currency: "USD", amountFx: 1100, fxRate },
      { account: "1200", debitCents: 500, creditCents: 0, currency: "USD", amountFx: 550, fxRate },
      { account: "1200", debitCents: 200, creditCents: 0, currency: "USD", fxRate },
      { account: "8400", debitCents: 0, creditCents: 100 },
      { account: "8400", debitCents: 0, creditCents: 50 },
    ]);
    expect(merged).toEqual([
      { account: "1200", debitCents: 1700, creditCents: 0, currency: "USD", amountFx: 1650, fxRate },
      { account: "8400", debitCents: 0, creditCents: 150 },
    ]);
    const firstWithout = mergeLines([
      { account: "1200", debitCents: 200, creditCents: 0, currency: "USD", fxRate },
      { account: "1200", debitCents: 500, creditCents: 0, currency: "USD", amountFx: 550, fxRate },
    ]);
    expect(firstWithout[0]?.amountFx).toBe(550);
  });
});
