import { describe, expect, test } from "vitest";
import {
  type AllocationInput,
  allocationsForInvoice,
  type PaymentInput,
  type PlanContext,
  planPayment,
  type SourceFacts,
  type TargetFacts,
  targetKey,
} from "./plan";

const TODAY = "2026-10-13";
const INV: TargetFacts = {
  ref: { kind: "salesDocument", id: "inv1" },
  contactId: "c1",
  number: "RE-2026-0001",
  docType: "invoice",
  status: "sent",
  paymentStatus: "open",
  currency: "EUR",
  documentDate: "2026-10-01",
  dueDate: "2026-10-31",
  payableCents: 119000,
  openAmountCents: 119000,
  groups: [{ category: "S", rateBp: 1900, grossCents: 119000 }],
  skonto: { percentBp: 200, deadline: "2026-10-23", agreedCents: 2380 },
  taxedAs: "soll",
  methodOnDate: "soll",
};
const OPENING: TargetFacts = {
  ref: { kind: "opening_item", id: "o1" },
  contactId: "c1",
  number: "RE-2025-0099",
  currency: "EUR",
  payableCents: 50000,
  openAmountCents: 50000,
};
const CREDIT: TargetFacts = {
  ref: { kind: "contactCredit", id: "c1" },
  currency: "EUR",
  payableCents: 0,
  openAmountCents: 0,
  creditBalanceCents: 4500,
};

function ctx(targets: TargetFacts[] = [INV, OPENING, CREDIT], over: Partial<PlanContext> = {}): PlanContext {
  return {
    today: TODAY,
    closedPeriods: new Set(),
    source: { kind: "clearing", clearing: { currency: "EUR" } },
    targets: new Map(targets.map((t) => [targetKey(t.ref), t])),
    ...over,
  };
}
const input = (allocations: AllocationInput[], over: Partial<PaymentInput> = {}): PaymentInput => ({
  source: { kind: "clearing", accountId: "acc" },
  date: TODAY,
  allocations,
  ...over,
});
const onInv = (amountCents: number, differences?: AllocationInput["differences"]): AllocationInput => ({
  target: INV.ref,
  amountCents,
  ...(differences ? { differences } : {}),
});
const errorOf = (r: ReturnType<typeof planPayment> | ReturnType<typeof allocationsForInvoice>) =>
  r.ok ? null : r.error;

describe("planPayment — input and source checks (PAY-010, PAY-011)", () => {
  test("PAY-010 a payment needs at least one allocation and no target twice", () => {
    expect(errorOf(planPayment(input([]), ctx()))?.code).toBe("no_allocations");
    expect(errorOf(planPayment(input([onInv(1000), onInv(2000)]), ctx()))?.code).toBe("duplicate_target");
  });

  test("PAY-010 the payment date must be a valid calendar date", () => {
    expect(errorOf(planPayment(input([onInv(1000)], { date: "2026-02-30" }), ctx()))).toEqual({
      code: "date_invalid",
      message: "Bitte ein gültiges Zahlungsdatum angeben.",
    });
  });

  test("PAY-061 a cash payment can't be dated before the cash opening balance", () => {
    const source: SourceFacts = { kind: "cash", cashOpeningDate: "2026-10-10" };
    const r = planPayment(
      input([onInv(1000)], { source: { kind: "cash" }, date: "2026-10-09" }),
      ctx(undefined, { source }),
    );
    expect(errorOf(r)).toEqual({
      code: "cash_date_range",
      message: "Das Datum muss zwischen dem Anfangsbestand der Kasse (10.10.2026) und heute liegen.",
    });
    const sameDay = planPayment(
      input([onInv(1000)], { source: { kind: "cash" }, date: "2026-10-12" }),
      ctx(undefined, { source }),
    );
    expect(sameDay.ok).toBe(true);
  });

  const bankCtx = (bank: SourceFacts["bank"]) =>
    ctx(undefined, { source: { kind: "bank", ...(bank ? { bank } : {}) } });
  const bankInput = (allocations: AllocationInput[]) =>
    input(allocations, { source: { kind: "bank", transactionId: "tx1" }, date: "1999-01-01" });
  const tx = { bookingDate: "2026-10-12", amountCents: 119000, allocatedCents: 0, currency: "EUR", status: "open" };

  test("PAY-011 EC-PAY-25 a bank source must be a booked, allocatable incoming transaction", () => {
    expect(errorOf(planPayment(bankInput([onInv(1000)]), bankCtx(undefined)))?.code).toBe("tx_not_allocatable");
    expect(errorOf(planPayment(bankInput([onInv(1000)]), bankCtx({ ...tx, status: "pending" })))?.code).toBe(
      "tx_not_allocatable",
    );
    expect(errorOf(planPayment(bankInput([onInv(1000)]), bankCtx({ ...tx, amountCents: -119000 })))?.code).toBe(
      "tx_direction",
    );
    // PAY-010: the bank booking date is the payment date, whatever the client sent.
    const ok = planPayment(bankInput([onInv(100000)]), bankCtx({ ...tx, status: "partially_matched" }));
    expect(ok.ok && ok.value).toMatchObject({ date: "2026-10-12", totalCents: 100000, unallocatedCents: 19000 });
  });

  test("PAY-010 an unknown target and fractional cents are refused", () => {
    expect(
      errorOf(planPayment(input([{ target: { kind: "salesDocument", id: "nope" }, amountCents: 1 }]), ctx())),
    ).toEqual({ code: "target_unknown", message: "Die Rechnung wurde nicht gefunden." });
    expect(errorOf(planPayment(input([onInv(100.5)]), ctx()))?.code).toBe("amount_invalid");
  });
});

describe("planPayment — documents (PAY-014, PAY-017, PAY-020 ff.)", () => {
  test("PAY-014 only invoice-like documents can receive payments", () => {
    for (const docType of ["credit_note", "quote", undefined]) {
      const r = planPayment(input([onInv(1000)]), ctx([{ ...INV, docType }]));
      expect(errorOf(r)?.code, String(docType)).toBe("not_payable");
    }
    for (const docType of ["advance_invoice", "partial_invoice", "final_invoice"]) {
      expect(planPayment(input([onInv(1000)]), ctx([{ ...INV, docType }])).ok, docType).toBe(true);
    }
  });

  test("PAY-018 the EUR amount received must be whole positive cents", () => {
    const usd: TargetFacts = { ...INV, currency: "USD", fxRateToEur: "1.19", skonto: null };
    expect(errorOf(planPayment(input([{ ...onInv(119000), eurAmountCents: 1000.5 }]), ctx([usd])))?.code).toBe(
      "amount_invalid",
    );
    expect(errorOf(planPayment(input([{ ...onInv(119000), eurAmountCents: 0 }]), ctx([usd])))?.code).toBe(
      "amount_positive",
    );
    // An adjustment (Ausbuchung) on a foreign-currency invoice is deferred, not valued at a guessed rate.
    expect(
      errorOf(planPayment(input([{ ...onInv(0), eurAmountCents: 1 }], { source: { kind: "adjustment" } }), ctx([usd])))
        ?.code,
    ).toBe("fx_deferred");
  });

  test("PAY-025 an adjustment has no payment amount and only write-off or price reduction", () => {
    const adj = (a: AllocationInput) => planPayment(input([a], { source: { kind: "adjustment" } }), ctx());
    expect(errorOf(adj(onInv(100)))).toEqual({
      code: "adjustment_invalid",
      message: "Eine Ausbuchung ohne Zahlung hat keinen Zahlbetrag.",
    });
    expect(errorOf(adj(onInv(0, [{ reason: "bank_fees", amountCents: 100 }])))).toEqual({
      code: "adjustment_invalid",
      message: "Ohne Zahlung sind nur Forderungsausfall und Preisminderung möglich.",
    });
    const writeOff = adj(onInv(0, [{ reason: "write_off", amountCents: 119000, subReason: "insolvency" }]));
    expect(writeOff.ok && writeOff.value).toMatchObject({
      totalCents: 0,
      rows: [{ amountCents: 0, settlesCents: 119000, openAfterCents: 0 }],
    });
  });

  test("PAY-017 an Abschlagsrechnung takes only payments without differences", () => {
    const r = planPayment(
      input([onInv(1000, [{ reason: "bank_fees", amountCents: 100 }])]),
      ctx([{ ...INV, docType: "advance_invoice" }]),
    );
    expect(errorOf(r)).toEqual({
      code: "differences_not_allowed",
      message: "Auf Abschlagsrechnungen sind nur Zahlungen ohne Differenz möglich.",
    });
  });

  test("PAY-020 difference amounts are whole cents ≠ 0 and carry the right sign per reason", () => {
    const one = (d: NonNullable<AllocationInput["differences"]>[number]) =>
      errorOf(planPayment(input([onInv(100000, [d])]), ctx()));
    expect(one({ reason: "bank_fees", amountCents: 0 })?.message).toBe(
      "Differenzbeträge müssen ganze Cent ungleich 0 sein.",
    );
    expect(one({ reason: "bank_fees", amountCents: 1.5 })?.code).toBe("amount_invalid");
    expect(one({ reason: "skonto", amountCents: -100 })?.code).toBe("amount_positive");
    expect(one({ reason: "bank_fees", amountCents: -100 })?.code).toBe("amount_positive");
    expect(one({ reason: "write_off", amountCents: -100, subReason: "insolvency" })?.code).toBe("amount_positive");
    expect(one({ reason: "default_interest", amountCents: 100 })).toEqual({
      code: "amount_invalid",
      message: "Mahngebühren und Zinsen sind Mehrbeträge (negativ anzugeben).",
    });
  });

  test("PAY-024 default interest received is capped at the interest claimed", () => {
    const interest = (claimedInterestCents: number) =>
      planPayment(
        input([onInv(119800, [{ reason: "default_interest", amountCents: -800 }])]),
        ctx([{ ...INV, claimedInterestCents }]),
      );
    const r = interest(800);
    expect(r.ok && r.value.rows[0]).toMatchObject({
      differences: [{ reason: "default_interest", amountCents: -800 }],
      settlesCents: 119000,
      openAfterCents: 0,
    });
    expect(errorOf(interest(500))?.code).toBe("fees_exceed_claim");
  });

  test("PAY-024 fees alone can never settle the invoice (the amount must reduce the open amount)", () => {
    const r = planPayment(
      input([onInv(1700, [{ reason: "dunning_fees", amountCents: -1700 }])]),
      ctx([{ ...INV, claimedFeesCents: 1700 }]),
    );
    expect(errorOf(r)?.code).toBe("amount_positive");
  });

  test("EC-PAY-15 statute_barred needs a due date to compute the limitation date", () => {
    const r = planPayment(
      input([onInv(0, [{ reason: "write_off", amountCents: 119000, subReason: "statute_barred" }])], {
        source: { kind: "adjustment" },
      }),
      ctx([{ ...INV, dueDate: undefined }]),
    );
    expect(errorOf(r)).toMatchObject({ code: "not_yet_barred", params: { date: "" } });
  });

  test("PAY-027 EC-PAY-39 `other` without a reason text is incomplete; „ohne USt-Korrektur“ has no VAT split", () => {
    const other = (d: Partial<NonNullable<AllocationInput["differences"]>[number]>) =>
      planPayment(input([onInv(118000, [{ reason: "other", amountCents: 1000, account: "4970", ...d }])]), ctx());
    expect(errorOf(other({ text: undefined }))?.code).toBe("other_incomplete");
    expect(errorOf(other({ text: "Kulanz", account: " " }))?.code).toBe("other_incomplete");
    const noVat = other({ text: "  Kulanz wegen Lieferverzug ", withVat: false });
    expect(noVat.ok && noVat.value.rows[0]?.differences).toEqual([
      { reason: "other", amountCents: 1000, account: "4970", text: "Kulanz wegen Lieferverzug" },
    ]);
    const withVat = other({ text: "Preisminderung" });
    expect(withVat.ok && withVat.value.rows[0]?.differences[0]?.vatCorrection).toEqual([
      { rateBp: 1900, netCents: 840, vatCents: 160 },
    ]);
  });

  test("EC-PAY-17 an Ist invoice settled after the switch to Soll names „Ist-Versteuerung“", () => {
    const r = planPayment(
      input([onInv(116620, [{ reason: "skonto", amountCents: 2380 }])]),
      ctx([{ ...INV, taxedAs: "ist", methodOnDate: "soll" }]),
    );
    expect(r.ok && r.value.warnings.find((w) => w.code === "taxation_method_changed")?.message).toContain(
      "Ist-Versteuerung",
    );
    // Without a VAT-correcting difference the switch doesn't matter.
    const plain = planPayment(input([onInv(1000)]), ctx([{ ...INV, taxedAs: "ist", methodOnDate: "soll" }]));
    expect(plain.ok && plain.value.warnings).toEqual([]);
  });

  test("PAY-010 a row without contact or number (imported legacy document) carries neither", () => {
    const r = planPayment(input([onInv(1000)]), ctx([{ ...INV, contactId: undefined, number: undefined }]));
    expect(r.ok && r.value.rows[0]).not.toHaveProperty("contactId");
    expect(r.ok && r.value.rows[0]).not.toHaveProperty("number");
  });
});

describe("planPayment — opening items and credit balances (ACC-013, PAY-031, PAY-032)", () => {
  const onOpening = (amountCents: number, differences?: AllocationInput["differences"]): AllocationInput => ({
    target: OPENING.ref,
    amountCents,
    ...(differences ? { differences } : {}),
  });

  test("ACC-013 an open opening receivable takes plain payments up to its open amount", () => {
    const r = planPayment(input([onOpening(20000)]), ctx());
    expect(r.ok && r.value.rows[0]).toEqual({
      target: OPENING.ref,
      contactId: "c1",
      number: "RE-2025-0099",
      amountCents: 20000,
      differences: [],
      settlesCents: 20000,
      openAfterCents: 30000,
    });
    const bare = planPayment(input([onOpening(20000)]), ctx([{ ...OPENING, contactId: undefined, number: undefined }]));
    expect(bare.ok && bare.value.rows[0]).not.toHaveProperty("contactId");
    expect(errorOf(planPayment(input([onOpening(60000)]), ctx()))).toMatchObject({
      code: "excess",
      params: { excessCents: 10000 },
    });
  });

  test("ACC-013 opening items take no differences, no adjustment and no zero amount", () => {
    expect(errorOf(planPayment(input([onOpening(100, [{ reason: "bank_fees", amountCents: 5 }])]), ctx()))?.code).toBe(
      "differences_not_allowed",
    );
    expect(errorOf(planPayment(input([onOpening(0)]), ctx()))?.code).toBe("amount_positive");
    expect(errorOf(planPayment(input([onOpening(0)], { source: { kind: "adjustment" } }), ctx()))?.code).toBe(
      "amount_positive",
    );
  });

  const onCredit = (amountCents: number, differences?: AllocationInput["differences"]): AllocationInput => ({
    target: CREDIT.ref,
    amountCents,
    ...(differences ? { differences } : {}),
  });

  test("PAY-031 a credit balance row adds to the contact's balance; no differences, positive only", () => {
    const r = planPayment(input([onInv(119000), onCredit(1000)]), ctx());
    expect(r.ok && r.value.rows[1]).toEqual({
      target: CREDIT.ref,
      contactId: "c1",
      amountCents: 1000,
      differences: [],
      settlesCents: 0,
      openAfterCents: 5500,
    });
    expect(errorOf(planPayment(input([onCredit(100, [{ reason: "bank_fees", amountCents: 5 }])]), ctx()))?.code).toBe(
      "differences_not_allowed",
    );
    expect(errorOf(planPayment(input([onCredit(-100)]), ctx()))?.code).toBe("amount_positive");
    expect(errorOf(planPayment(input([onCredit(0)], { source: { kind: "adjustment" } }), ctx()))?.code).toBe(
      "amount_positive",
    );
    // A contact without any credit yet starts from 0.
    const fresh = planPayment(
      input([onInv(119000), onCredit(700)]),
      ctx([INV, { ...CREDIT, creditBalanceCents: undefined }]),
    );
    expect(fresh.ok && fresh.value.rows[1]?.openAfterCents).toBe(700);
  });

  test("PAY-032 applying credit must be one negative credit row paired with document rows of the same sum", () => {
    const credit = (allocations: AllocationInput[]) =>
      planPayment(input(allocations, { source: { kind: "credit" } }), ctx());
    expect(errorOf(credit([onCredit(1000), onInv(1000)]))?.code).toBe("credit_pair_unbalanced");
    expect(errorOf(credit([onInv(1000)]))?.code).toBe("credit_pair_unbalanced");
    expect(errorOf(credit([onCredit(-1000), onInv(900)]))?.code).toBe("credit_pair_unbalanced");
    const ok = credit([onCredit(-1000), onInv(1000)]);
    expect(ok.ok && ok.value).toMatchObject({
      totalCents: 0,
      rows: [{ openAfterCents: 3500 }, { openAfterCents: 118000 }],
    });
  });
});

describe("allocationsForInvoice — excess resolution (PAY-030, EC-PAY-50)", () => {
  const invoice = { id: "inv1", contactId: "c1", openAmountCents: 119000 };

  test("PAY-030 a payment within the open amount keeps its differences on the one allocation", () => {
    const r = allocationsForInvoice({
      invoice,
      sourceKind: "bank",
      amountCents: 116620,
      differences: [{ reason: "skonto", amountCents: 2380 }],
    });
    expect(r.ok && r.value).toEqual([
      {
        target: { kind: "salesDocument", id: "inv1" },
        amountCents: 116620,
        differences: [{ reason: "skonto", amountCents: 2380 }],
      },
    ]);
  });

  test("PAY-030 c the excess can only become a credit balance when the invoice has a contact", () => {
    const r = allocationsForInvoice({
      invoice: { id: "inv1", openAmountCents: 119000 },
      sourceKind: "bank",
      amountCents: 120000,
      excess: { mode: "credit" },
    });
    expect(errorOf(r)).toMatchObject({ code: "excess", params: { excessCents: 1000 } });
  });

  test("PAY-030 a the further allocations must take exactly the excess; differences stay on the first invoice", () => {
    const missing = allocationsForInvoice({
      invoice,
      sourceKind: "bank",
      amountCents: 120000,
      excess: { mode: "allocate" },
    });
    expect(errorOf(missing)).toMatchObject({ code: "excess", params: { excessCents: 1000 } });
    const short = allocationsForInvoice({
      invoice,
      sourceKind: "bank",
      amountCents: 120000,
      excess: { mode: "allocate", allocations: [{ invoiceId: "inv2", amountCents: 400 }] },
    });
    expect(errorOf(short)).toMatchObject({ params: { excessCents: 600 } });
    const withDiff = allocationsForInvoice({
      invoice,
      sourceKind: "bank",
      amountCents: 119500,
      differences: [{ reason: "bank_fees", amountCents: 500 }],
      excess: { mode: "allocate", allocations: [{ invoiceId: "inv2", amountCents: 1000 }] },
    });
    expect(withDiff.ok && withDiff.value).toEqual([
      {
        target: { kind: "salesDocument", id: "inv1" },
        amountCents: 118500,
        differences: [{ reason: "bank_fees", amountCents: 500 }],
      },
      { target: { kind: "salesDocument", id: "inv2" }, amountCents: 1000 },
    ]);
  });

  test("PAY-024 b an excess above the claimed fees and interest is refused; only fees claimed → only a fee line", () => {
    const tooMuch = allocationsForInvoice({
      invoice,
      sourceKind: "bank",
      amountCents: 125000,
      excess: { mode: "fees" },
    });
    expect(errorOf(tooMuch)?.code).toBe("fees_exceed_claim");
    const feesOnly = allocationsForInvoice({
      invoice: { ...invoice, claimedFeesCents: 500 },
      sourceKind: "bank",
      amountCents: 119500,
      excess: { mode: "fees" },
    });
    expect(feesOnly.ok && feesOnly.value[0]?.differences).toEqual([{ reason: "dunning_fees", amountCents: -500 }]);
    const interestOnly = allocationsForInvoice({
      invoice: { ...invoice, claimedInterestCents: 300 },
      sourceKind: "bank",
      amountCents: 119300,
      excess: { mode: "fees" },
    });
    expect(interestOnly.ok && interestOnly.value[0]?.differences).toEqual([
      { reason: "default_interest", amountCents: -300 },
    ]);
  });

  test("EC-PAY-50 only a bank excess may stay unallocated (not a clearing amount)", () => {
    const r = allocationsForInvoice({
      invoice,
      sourceKind: "clearing",
      amountCents: 120000,
      excess: { mode: "unallocated" },
    });
    expect(errorOf(r)).toMatchObject({ code: "excess", params: { excessCents: 1000 } });
  });
});
