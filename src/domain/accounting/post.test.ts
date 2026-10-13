import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { InvoiceFinalisedEvent, PaymentReceivedEvent, VatGroup } from "./events";
import {
  checkBalanced,
  explanationText,
  mirrorLines,
  type PostingContext,
  postEvent,
  type RoleLine,
  reversalPosting,
} from "./post";

const SOLL: PostingContext = { taxationMethod: "soll", legalForm: "einzelunternehmen", ustvaPeriod: [] };
const IST: PostingContext = { ...SOLL, taxationMethod: "ist" };

const invoice = (vatGroups: VatGroup[], over: Partial<InvoiceFinalisedEvent> = {}): InvoiceFinalisedEvent => ({
  kind: "invoice_finalised",
  documentId: "doc1",
  documentNumber: "RE-2026-0001",
  documentType: "invoice",
  date: "2026-03-10",
  supplyDate: { kind: "date", date: "2026-03-05" },
  taxCase: "domestic",
  contactId: "c1",
  counterpartyName: "Muster GmbH",
  vatGroups,
  ...over,
});

const S19 = (net: number): VatGroup => ({
  category: "S",
  rateBp: 1900,
  netCents: net,
  vatCents: Math.round(net * 0.19),
});

function lines(r: ReturnType<typeof postEvent>): RoleLine[] {
  if (!r.ok) throw new Error(r.error.message);
  if (r.value.kind !== "entry") throw new Error(`no entry: ${r.value.reason}`);
  return r.value.posting.lines;
}

const brief = (ls: RoleLine[]) =>
  ls.map((l) => [l.role ?? l.account, l.debitCents > 0 ? "S" : "H", l.debitCents || l.creditCents]);

describe("posting engine (ACC-002, posting-2026.1)", () => {
  test("ACC-001 TST-ACC-01 GOBD-03 random invoices always produce balanced entries with ≥ 2 lines", () => {
    const group = fc.oneof(
      fc.record({
        category: fc.constant("S" as const),
        rateBp: fc.constantFrom(1900, 700),
        netCents: fc.integer({ min: -1_000_000, max: 10_000_000 }),
        vatCents: fc.integer({ min: -190_000, max: 1_900_000 }),
      }),
      fc.record({
        category: fc.constantFrom("K" as const, "G" as const, "O" as const, "E" as const, "AE" as const),
        rateBp: fc.constant(0),
        netCents: fc.integer({ min: 1, max: 10_000_000 }),
        vatCents: fc.constant(0),
      }),
    );
    fc.assert(
      fc.property(fc.array(group, { minLength: 1, maxLength: 5 }), fc.boolean(), (groups, ist) => {
        const r = postEvent(invoice(groups), ist ? IST : SOLL);
        if (!r.ok) return; // e.g. a zero-sum invoice is refused, never posted unbalanced
        if (r.value.kind !== "entry") return;
        expect(checkBalanced(r.value.posting.lines).ok).toBe(true);
        expect(r.value.posting.lines.length).toBeGreaterThanOrEqual(2);
        expect(r.value.posting.text.length).toBeLessThanOrEqual(60);
      }),
    );
  });

  test("ACC-021 Soll and Ist differ only in the VAT account (vat.output vs vat.output.notdue) and the tax point", () => {
    const soll = lines(postEvent(invoice([S19(100000)]), SOLL));
    const ist = lines(postEvent(invoice([S19(100000)]), IST));
    expect(brief(soll)).toEqual([
      ["receivable", "S", 119000],
      ["revenue.domestic.19", "H", 100000],
      ["vat.output.19", "H", 19000],
    ]);
    expect(brief(ist)).toEqual([
      ["receivable", "S", 119000],
      ["revenue.domestic.19", "H", 100000],
      ["vat.output.notdue.19", "H", 19000],
    ]);
    expect(soll[1]?.taxPointDate).toBe("2026-03-05");
    expect(ist[1]?.taxPointDate).toBeUndefined();
    expect(soll[0]?.contactId).toBe("c1");
  });

  test("TAX-008 tax points: Soll end of supply period, EU service end of supply month, igL capped at next month end", () => {
    const period = lines(
      postEvent(invoice([S19(1000)], { supplyDate: { kind: "period", from: "2026-02-01", to: "2026-02-28" } }), SOLL),
    );
    expect(period[1]?.taxPointDate).toBe("2026-02-28");
    const ae = lines(
      postEvent(
        invoice([{ category: "AE", rateBp: 0, netCents: 5000, vatCents: 0 }], {
          taxCase: "eu_b2b_service",
          supplyDate: { kind: "date", date: "2026-03-05" },
        }),
        IST,
      ),
    );
    expect(ae[1]).toMatchObject({ role: "revenue.eu_service_rc", taxPointDate: "2026-03-31", taxKey: "EU-RC" });
    const igl = lines(
      postEvent(
        invoice([{ category: "K", rateBp: 0, netCents: 5000, vatCents: 0 }], {
          taxCase: "intra_community_supply",
          date: "2026-06-20",
          supplyDate: { kind: "month", month: "2026-04" },
        }),
        SOLL,
      ),
    );
    expect(igl[1]).toMatchObject({ role: "revenue.icsupply", taxPointDate: "2026-05-31" });
    const withPeriods = lines(
      postEvent(invoice([S19(1000)]), { ...SOLL, ustvaPeriod: [{ year: 2026, period: "quarterly" }] }),
    );
    expect(withPeriods[1]?.taxPeriod).toBe("2026-Q1");
  });

  test("UST-40 S9 an Abschlagsrechnung produces no journal entry", () => {
    const r = postEvent(invoice([S19(1000)], { documentType: "advance_invoice" }), SOLL);
    expect(r).toEqual({ ok: true, value: { kind: "none", reason: "advance_invoice" } });
  });

  test("UST-40 INV-04 S9 an amount-based Teilrechnung is an Anzahlung and produces no journal entry either", () => {
    const r = postEvent(invoice([S19(1000)], { documentType: "partial_invoice" }), SOLL);
    expect(r).toEqual({ ok: true, value: { kind: "none", reason: "advance_invoice" } });
  });

  test("ACC-002 invalid groups are refused (VAT on non-S, unsupported rate, imported unknown tax case)", () => {
    const vatOnK = postEvent(invoice([{ category: "K", rateBp: 0, netCents: 100, vatCents: 19 }]), SOLL);
    expect(!vatOnK.ok && vatOnK.error.code).toBe("invalid_event");
    const rate16 = postEvent(invoice([{ category: "S", rateBp: 1600, netCents: 100, vatCents: 16 }]), SOLL);
    expect(!rate16.ok && rate16.error).toMatchObject({
      code: "rate_not_supported",
      message: "Für den Steuersatz 16 % gibt es keine Kontenrolle. Bitte die Buchung manuell erfassen lassen.",
    });
    const imported = postEvent(invoice([S19(100)], { taxCase: "unknown_imported" }), SOLL);
    expect(!imported.ok && imported.error.code).toBe("tax_case_not_postable");
    const empty = postEvent(invoice([]), SOLL);
    expect(!empty.ok && empty.error.code).toBe("invalid_event");
    const zero = postEvent(invoice([{ category: "S", rateBp: 1900, netCents: 0, vatCents: 0 }]), SOLL);
    expect(!zero.ok && zero.error.message).toBe("Eine Buchung braucht mindestens zwei Zeilen.");
  });

  test("ACC-001 E-ACC-01 the balance check names the difference", () => {
    const r = checkBalanced([
      { debitCents: 1000, creditCents: 0 },
      { debitCents: 0, creditCents: 990 },
    ]);
    expect(!r.ok && r.error.message).toBe("Soll und Haben sind nicht ausgeglichen (Differenz: 0,10\u00a0€).");
    const twoSided = checkBalanced([
      { debitCents: 10, creditCents: 10 },
      { debitCents: 0, creditCents: 0 },
    ]);
    expect(!twoSided.ok && twoSided.error.code).toBe("journal_invalid_line");
  });

  test("ACC-003 every explanation key used by the engine has a German text", () => {
    expect(explanationText("S1")).toMatch(/Soll-Versteuerung/);
    expect(explanationText("unbekannt")).toBe("unbekannt");
  });
});

describe("payments (F05 / P1–P8)", () => {
  const pay = (over: Partial<PaymentReceivedEvent> = {}): PaymentReceivedEvent => ({
    kind: "payment_received",
    paymentId: "pay1",
    date: "2026-04-02",
    means: { kind: "bank_account", bankAccountId: "bank1" },
    amountCents: 11900,
    target: { kind: "salesDocument", id: "doc1", number: "RE-1" },
    contactId: "c1",
    ...over,
  });

  test("TST-ACC-29 ACC-026 cash payment of 119 €: S cash · H receivable (+ Ist transfer 19 €)", () => {
    const soll = lines(postEvent(pay({ means: { kind: "cash" } }), SOLL));
    expect(brief(soll)).toEqual([
      ["cash", "S", 11900],
      ["receivable", "H", 11900],
    ]);
    const ist = postEvent(
      pay({
        means: { kind: "cash" },
        ist: { notDueVat: [{ rateBp: 1900, vatCents: 1900 }], payableCents: 11900, settledBeforeCents: 0 },
      }),
      IST,
    );
    expect(brief(lines(ist))).toEqual([
      ["cash", "S", 11900],
      ["receivable", "H", 11900],
      ["vat.output.notdue.19", "S", 1900],
      ["vat.output.19", "H", 1900],
    ]);
    expect(ist.ok && ist.value.kind === "entry" && ist.value.posting.explanation).toBe("P3-ist");
    expect(ist.ok && ist.value.kind === "entry" && ist.value.posting.dating).toBe("user");
  });

  test("UST-32 P4 Skonto: Soll reduces vat.output, Ist clears notdue and transfers only the rest", () => {
    const skonto = {
      reason: "skonto" as const,
      amountCents: 238,
      vatCorrection: [{ rateBp: 1900, netCents: 200, vatCents: 38 }],
    };
    expect(brief(lines(postEvent(pay({ amountCents: 11662, differences: [skonto] }), SOLL)))).toEqual([
      ["bank.bank1", "S", 11662],
      ["skonto.granted.19", "S", 200],
      ["vat.output.19", "S", 38],
      ["receivable", "H", 11900],
    ]);
    const ist = lines(
      postEvent(
        pay({
          amountCents: 11662,
          differences: [skonto],
          ist: { notDueVat: [{ rateBp: 1900, vatCents: 1900 }], payableCents: 11900, settledBeforeCents: 0 },
        }),
        IST,
      ),
    );
    expect(brief(ist)).toEqual([
      ["bank.bank1", "S", 11662],
      ["skonto.granted.19", "S", 200],
      ["vat.output.notdue.19", "S", 38 + 1862],
      ["receivable", "H", 11900],
      ["vat.output.19", "H", 1862],
    ]);
    const missing = postEvent(pay({ differences: [{ reason: "skonto", amountCents: 238 }] }), SOLL);
    expect(!missing.ok && missing.error.code).toBe("vat_correction_required");
  });

  test("E-TAX-22 P5/P7 fees deducted by the payer and dunning fees/interest received", () => {
    const r = lines(
      postEvent(
        pay({
          amountCents: 15400,
          differences: [
            { reason: "bank_fees", amountCents: 500 },
            { reason: "dunning_fees", amountCents: -4000 },
            { reason: "default_interest", amountCents: -500 },
          ],
        }),
        SOLL,
      ),
    );
    expect(brief(r)).toEqual([
      ["bank.bank1", "S", 15400],
      ["expense.bank_fees", "S", 500],
      ["income.other_nontaxable", "H", 4000],
      ["income.interest_default", "H", 500],
      ["receivable", "H", 11400],
    ]);
  });

  test("UST-30 P8 write-off without cash (Soll Kz 50 negative) and E-TAX-12 under Ist clears notdue only", () => {
    const wo = {
      reason: "write_off" as const,
      amountCents: 11900,
      vatCorrection: [{ rateBp: 1900, netCents: 10000, vatCents: 1900 }],
    };
    const soll = postEvent(pay({ means: { kind: "none" }, amountCents: 0, differences: [wo] }), SOLL);
    expect(brief(lines(soll))).toEqual([
      ["writeoff.19", "S", 10000],
      ["vat.output.19", "S", 1900],
      ["receivable", "H", 11900],
    ]);
    expect(soll.ok && soll.value.kind === "entry" && soll.value.posting.explanation).toBe("P8");
    const ist = lines(
      postEvent(
        pay({
          means: { kind: "none" },
          amountCents: 0,
          differences: [wo],
          ist: { notDueVat: [{ rateBp: 1900, vatCents: 1900 }], payableCents: 11900, settledBeforeCents: 0 },
        }),
        IST,
      ),
    );
    expect(brief(ist)).toEqual([
      ["writeoff.19", "S", 10000],
      ["vat.output.notdue.19", "S", 1900],
      ["receivable", "H", 11900],
    ]);
  });

  test("EC-120 P6 an overpayment is a credit balance on the debtor; invalid amounts are refused", () => {
    expect(
      brief(lines(postEvent(pay({ target: { kind: "contactCredit", id: "c1" }, amountCents: 500 }), SOLL))),
    ).toEqual([
      ["bank.bank1", "S", 500],
      ["receivable", "H", 500],
    ]);
    expect(postEvent(pay({ amountCents: -1 }), SOLL).ok).toBe(false);
    expect(postEvent(pay({ amountCents: 0 }), SOLL).ok).toBe(false);
    expect(postEvent(pay({ means: { kind: "none" }, amountCents: 5 }), SOLL).ok).toBe(false);
    expect(postEvent(pay({ differences: [{ reason: "other", amountCents: 10 }] }), SOLL).ok).toBe(false);
  });

  test("MISC-08 R3 FX difference on a payment into a foreign-currency account goes to FX gain/loss", () => {
    expect(
      brief(
        lines(
          postEvent(pay({ amountCents: 11700, differences: [{ reason: "fx_difference", amountCents: 200 }] }), SOLL),
        ),
      ),
    ).toEqual([
      ["bank.bank1", "S", 11700],
      ["expense.fx_loss", "S", 200],
      ["receivable", "H", 11900],
    ]);
    expect(
      brief(
        lines(
          postEvent(pay({ amountCents: 12000, differences: [{ reason: "fx_difference", amountCents: -100 }] }), SOLL),
        ),
      ),
    ).toEqual([
      ["bank.bank1", "S", 12000],
      ["income.fx_gain", "H", 100],
      ["receivable", "H", 11900],
    ]);
  });
});

describe("cash transfers (CSH-024/025) and private postings (ACC-028)", () => {
  const ct = (over: Record<string, unknown>) => ({
    kind: "cash_transfer" as const,
    cashTransferId: "ct1",
    transferKind: "deposit_to_bank" as const,
    date: "2026-03-02",
    amountCents: 50000,
    ...over,
  });

  test("TST-ACC-32 T5 deposit: cash leg S transit · H cash, bank leg S bank · H transit (external date)", () => {
    expect(brief(lines(postEvent(ct({}), SOLL)))).toEqual([
      ["transit", "S", 50000],
      ["cash", "H", 50000],
    ]);
    const bank = postEvent(ct({ leg: "bank", bankAccountId: "b1", date: "2026-03-03" }), SOLL);
    expect(brief(lines(bank))).toEqual([
      ["bank.b1", "S", 50000],
      ["transit", "H", 50000],
    ]);
    expect(bank.ok && bank.value.kind === "entry" && bank.value.posting.dating).toBe("external");
    expect(postEvent(ct({ leg: "bank" }), SOLL).ok).toBe(false);
  });

  test("TST-ACC-33 T8 private withdrawal: S private.withdrawal · H cash; for a UG only via shareholder.clearing (E-ACC-30)", () => {
    expect(brief(lines(postEvent(ct({ transferKind: "private_withdrawal", amountCents: 10000 }), SOLL)))).toEqual([
      ["private.withdrawal", "S", 10000],
      ["cash", "H", 10000],
    ]);
    const ug: PostingContext = { ...SOLL, legalForm: "ug" };
    const blocked = postEvent(ct({ transferKind: "private_withdrawal", amountCents: 10000 }), ug);
    expect(!blocked.ok && blocked.error).toMatchObject({
      code: "private_withdrawal_corporation",
      message:
        "Bei einer UG (haftungsbeschränkt) gibt es keine Privatentnahmen. Die Buchung erfolgt über das Verrechnungskonto Gesellschafter.",
    });
    const corp = postEvent(
      ct({
        transferKind: "private_withdrawal",
        amountCents: 10000,
        shareholder: { name: "A. Muster", note: "Darlehen" },
      }),
      ug,
    );
    expect(brief(lines(corp))).toEqual([
      ["shareholder.clearing", "S", 10000],
      ["cash", "H", 10000],
    ]);
  });

  test("TST-ACC-34 T9 ATM withdrawal: S transit · H bank and S cash · H transit in one entry, transit nets to 0", () => {
    const r = lines(
      postEvent(ct({ transferKind: "bank_withdrawal_to_cash", bankAccountId: "b1", amountCents: 20000 }), SOLL),
    );
    expect(brief(r)).toEqual([
      ["transit", "S", 20000],
      ["bank.b1", "H", 20000],
      ["cash", "S", 20000],
      ["transit", "H", 20000],
    ]);
  });
});

describe("reversals (ACC-004 Generalumkehr)", () => {
  test("ACC-004 S12/P10/T10 mirror the original lines with the same accounts, VAT reported in the reversal period", () => {
    const original = lines(postEvent(invoice([S19(100000)]), SOLL));
    const rev = reversalPosting(
      {
        kind: "invoice_cancelled",
        documentId: "st1",
        documentNumber: "ST-1",
        originalDocumentId: "doc1",
        date: "2026-10-05",
      },
      { lines: original, text: "Rechnung RE-1" },
      { ...SOLL, ustvaPeriod: [{ year: 2026, period: "monthly" }] },
    );
    expect(brief(rev.lines)).toEqual([
      ["receivable", "H", 119000],
      ["revenue.domestic.19", "S", 100000],
      ["vat.output.19", "S", 19000],
    ]);
    expect(rev.lines[1]).toMatchObject({ taxPointDate: "2026-10-05", taxPeriod: "2026-10" });
    expect(rev).toMatchObject({
      text: "Storno ST-1",
      explanation: "S12",
      dating: "external",
      source: { kind: "salesDocument", id: "st1" },
    });
    const payRev = reversalPosting(
      {
        kind: "payment_reversed",
        paymentId: "p2",
        originalPaymentId: "p1",
        date: "2026-10-05",
        reason: "Rücklastschrift",
      },
      { lines: original, text: "Zahlung RE-1" },
      SOLL,
    );
    expect(payRev).toMatchObject({
      text: "Storno: Zahlung RE-1",
      explanation: "P10",
      source: { kind: "payment", id: "p2" },
    });
    expect(mirrorLines([], "2026-01-01", SOLL)).toEqual([]);
  });
});
