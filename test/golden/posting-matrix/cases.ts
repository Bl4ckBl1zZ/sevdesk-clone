/**
 * Golden cases for the posting matrix (F08 §4.2 `posting-2026.1`, TST-ACC-02): every P1 event type × tax case
 * with the expected lines written out by hand as [role, SKR03 account, SKR04 account, side, cents]. The test
 * also writes the full resolved entries to `expected/<id>.journal.json` (change only with `pnpm golden:update`
 * and a written legal reason, CLAUDE.md rule 11).
 */
import type { BusinessEvent, ReversalEvent } from "@/domain/accounting/events";
import type { PostingContext } from "@/domain/accounting/post";

export type Side = "S" | "H";
export type ExpectedLine = readonly [role: string, skr03: string, skr04: string, side: Side, cents: number];

export interface GoldenCase {
  id: string;
  /** Matrix row(s) and requirement IDs covered. */
  covers: string;
  ctx?: Partial<PostingContext>;
  event: BusinessEvent;
  /** Reversal cases: the event whose entry is mirrored. */
  original?: Exclude<BusinessEvent, ReversalEvent>;
  expect:
    | { lines: readonly ExpectedLine[]; explanation: string }
    | { none: "advance_invoice" | "no_change" | "zero_amount" }
    | { error: string };
}

const BANK = "bank.bank1"; // ledger 1200 (SKR03) / 1800 (SKR04)
const inv = {
  kind: "invoice_finalised" as const,
  documentId: "doc1",
  documentNumber: "RE-2026-0001",
  documentType: "invoice" as const,
  date: "2026-03-10",
  supplyDate: { kind: "date" as const, date: "2026-03-05" },
  taxCase: "domestic" as const,
  contactId: "contact1",
  counterpartyName: "Muster GmbH",
};
const pay = {
  kind: "payment_received" as const,
  paymentId: "pay1",
  date: "2026-04-02",
  means: { kind: "bank_account" as const, bankAccountId: "bank1" },
  target: { kind: "salesDocument" as const, id: "doc1", number: "RE-2026-0001" },
  contactId: "contact1",
  counterpartyName: "Muster GmbH",
};
const IST = { taxationMethod: "ist" as const };
const g19 = (net: number, vat: number) => ({ category: "S" as const, rateBp: 1900, netCents: net, vatCents: vat });
const g7 = (net: number, vat: number) => ({ category: "S" as const, rateBp: 700, netCents: net, vatCents: vat });
const zero = (category: "K" | "G" | "O" | "E" | "AE" | "Z" | "KU", net: number) => ({
  category,
  rateBp: 0,
  netCents: net,
  vatCents: 0,
});

export const GOLDEN_CASES: readonly GoldenCase[] = [
  // ── 4.2.1 sales ──────────────────────────────────────────────────────────────────────────────────────
  {
    id: "S1-domestic-19-soll",
    covers: "S1, UST-09",
    event: { ...inv, vatGroups: [g19(100000, 19000)] },
    expect: {
      explanation: "S1",
      lines: [
        ["receivable", "1400", "1200", "S", 119000],
        ["revenue.domestic.19", "8400", "4400", "H", 100000],
        ["vat.output.19", "1776", "3806", "H", 19000],
      ],
    },
  },
  {
    id: "S1-domestic-19-ist",
    covers: "S1 Ist, UVA-06",
    ctx: IST,
    event: { ...inv, vatGroups: [g19(100000, 19000)] },
    expect: {
      explanation: "S1-ist",
      lines: [
        ["receivable", "1400", "1200", "S", 119000],
        ["revenue.domestic.19", "8400", "4400", "H", 100000],
        ["vat.output.notdue.19", "1766", "3816", "H", 19000],
      ],
    },
  },
  {
    id: "S2-mixed-19-7-soll",
    covers: "S2, UST-10",
    event: { ...inv, vatGroups: [g19(100000, 19000), g7(50000, 3500)] },
    expect: {
      explanation: "S2",
      lines: [
        ["receivable", "1400", "1200", "S", 172500],
        ["revenue.domestic.19", "8400", "4400", "H", 100000],
        ["vat.output.19", "1776", "3806", "H", 19000],
        ["revenue.domestic.7", "8300", "4300", "H", 50000],
        ["vat.output.7", "1771", "3801", "H", 3500],
      ],
    },
  },
  {
    id: "S2-mixed-19-7-ist",
    covers: "S2 Ist",
    ctx: IST,
    event: { ...inv, vatGroups: [g19(100000, 19000), g7(50000, 3500)] },
    expect: {
      explanation: "S2-ist",
      lines: [
        ["receivable", "1400", "1200", "S", 172500],
        ["revenue.domestic.19", "8400", "4400", "H", 100000],
        ["vat.output.notdue.19", "1766", "3816", "H", 19000],
        ["revenue.domestic.7", "8300", "4300", "H", 50000],
        ["vat.output.notdue.7", "1761", "3811", "H", 3500],
      ],
    },
  },
  {
    id: "S3-kleinunternehmer",
    covers: "S3, KU-02",
    event: { ...inv, taxCase: "kleinunternehmer", vatGroups: [zero("KU", 50000)] },
    expect: {
      explanation: "S3",
      lines: [
        ["receivable", "1400", "1200", "S", 50000],
        ["revenue.ku", "8195", "4185", "H", 50000],
      ],
    },
  },
  {
    id: "S4-eu-b2b-service",
    covers: "S4, UST-20",
    event: { ...inv, taxCase: "eu_b2b_service", vatGroups: [zero("AE", 200000)] },
    expect: {
      explanation: "S4",
      lines: [
        ["receivable", "1400", "1200", "S", 200000],
        ["revenue.eu_service_rc", "8336", "4336", "H", 200000],
      ],
    },
  },
  {
    id: "S5-intra-community-supply",
    covers: "S5, UST-21",
    event: { ...inv, taxCase: "intra_community_supply", vatGroups: [zero("K", 300000)] },
    expect: {
      explanation: "S5",
      lines: [
        ["receivable", "1400", "1200", "S", 300000],
        ["revenue.icsupply", "8125", "4125", "H", 300000],
      ],
    },
  },
  {
    id: "S6-reverse-charge-13b",
    covers: "S6, UST-22",
    event: { ...inv, taxCase: "reverse_charge_13b", vatGroups: [zero("AE", 80000)] },
    expect: {
      explanation: "S6",
      lines: [
        ["receivable", "1400", "1200", "S", 80000],
        ["revenue.13b_domestic", "8337", "4337", "H", 80000],
      ],
    },
  },
  {
    id: "S7-export",
    covers: "S7 (G), UST-23",
    event: { ...inv, taxCase: "export", vatGroups: [zero("G", 40000)] },
    expect: {
      explanation: "S7",
      lines: [
        ["receivable", "1400", "1200", "S", 40000],
        ["revenue.export", "8120", "4120", "H", 40000],
      ],
    },
  },
  {
    id: "S7-not-taxable",
    covers: "S7 (O), UST-23",
    event: { ...inv, taxCase: "not_taxable_domestic", vatGroups: [zero("O", 40000)] },
    expect: {
      explanation: "S7",
      lines: [
        ["receivable", "1400", "1200", "S", 40000],
        ["revenue.not_taxable", "8338", "4338", "H", 40000],
      ],
    },
  },
  {
    id: "S7-exempt-4",
    covers: "S7 (E)",
    event: { ...inv, taxCase: "exempt_4", vatGroups: [zero("E", 40000)] },
    expect: {
      explanation: "S7",
      lines: [
        ["receivable", "1400", "1200", "S", 40000],
        ["revenue.exempt_4", "8100", "4100", "H", 40000],
      ],
    },
  },
  {
    id: "S8-pv-zero-rate-unmapped",
    covers: "S8, UST-15, TST-ACC-39 (UNSURE role blocks until mapped)",
    event: { ...inv, vatGroups: [zero("Z", 900000)] },
    expect: { error: "role_unmapped" },
  },
  {
    id: "S9-advance-invoice",
    covers: "S9, UST-40",
    event: { ...inv, documentType: "advance_invoice", vatGroups: [g19(300000, 57000)] },
    expect: { none: "advance_invoice" },
  },
  {
    id: "S10-advance-payment",
    covers: "S10, UST-40, EC-173 (Mindest-Ist also under Soll)",
    event: {
      kind: "advance_payment_received",
      paymentId: "pay-adv",
      date: "2026-04-15",
      means: { kind: "bank_account", bankAccountId: "bank1" },
      amountCents: 357000,
      advance: {
        documentId: "adv1",
        number: "AR-1",
        vatGroups: [{ rateBp: 1900, netCents: 300000, vatCents: 57000 }],
        payableCents: 357000,
        settledBeforeCents: 0,
      },
      contactId: "contact1",
    },
    expect: {
      explanation: "S10",
      lines: [
        [BANK, "1200", "1800", "S", 357000],
        ["advance.received.19", "1718", "3272", "H", 300000],
        ["vat.output.19", "1776", "3806", "H", 57000],
      ],
    },
  },
  {
    id: "S11-final-invoice-soll",
    covers: "S11, UST-41 (10,000 € total, 3,000 € advance)",
    event: {
      ...inv,
      documentType: "final_invoice",
      vatGroups: [g19(1000000, 190000)],
      advanceDeductions: [{ advanceDocumentId: "adv1", rateBp: 1900, netCents: 300000, vatCents: 57000 }],
    },
    expect: {
      explanation: "S11",
      lines: [
        ["receivable", "1400", "1200", "S", 1190000],
        ["revenue.domestic.19", "8400", "4400", "H", 1000000],
        ["vat.output.19", "1776", "3806", "H", 190000],
        ["advance.received.19", "1718", "3272", "S", 300000],
        ["vat.output.19", "1776", "3806", "S", 57000],
        ["receivable", "1400", "1200", "H", 357000],
      ],
    },
  },
  {
    id: "S11-final-invoice-ist",
    covers: "S11 Ist (remainder VAT not due)",
    ctx: IST,
    event: {
      ...inv,
      documentType: "final_invoice",
      vatGroups: [g19(1000000, 190000)],
      advanceDeductions: [{ advanceDocumentId: "adv1", rateBp: 1900, netCents: 300000, vatCents: 57000 }],
    },
    expect: {
      explanation: "S11-ist",
      lines: [
        ["receivable", "1400", "1200", "S", 1190000],
        ["revenue.domestic.19", "8400", "4400", "H", 1000000],
        ["vat.output.notdue.19", "1766", "3816", "H", 133000],
        ["advance.received.19", "1718", "3272", "S", 300000],
        ["receivable", "1400", "1200", "H", 357000],
      ],
    },
  },
  {
    id: "S12-storno",
    covers: "S12, UST-30, ACC-004",
    event: {
      kind: "invoice_cancelled",
      documentId: "storno1",
      documentNumber: "ST-2026-0001",
      originalDocumentId: "doc1",
      date: "2026-10-05",
    },
    original: { ...inv, vatGroups: [g19(100000, 19000)] },
    expect: {
      explanation: "S12",
      lines: [
        ["receivable", "1400", "1200", "H", 119000],
        ["revenue.domestic.19", "8400", "4400", "S", 100000],
        ["vat.output.19", "1776", "3806", "S", 19000],
      ],
    },
  },
  {
    id: "S13-correction-soll",
    covers: "S13, UST-33",
    event: {
      kind: "invoice_corrected",
      documentId: "corr1",
      documentNumber: "RK-2026-0001",
      correctedDocumentId: "doc1",
      date: "2026-05-02",
      taxCase: "domestic",
      contactId: "contact1",
      vatGroups: [g19(-20000, -3800)],
    },
    expect: {
      explanation: "S13",
      lines: [
        ["receivable", "1400", "1200", "H", 23800],
        ["revenue.domestic.19", "8400", "4400", "S", 20000],
        ["vat.output.19", "1776", "3806", "S", 3800],
      ],
    },
  },
  {
    id: "S13-correction-ist",
    covers: "S13 Ist",
    ctx: IST,
    event: {
      kind: "invoice_corrected",
      documentId: "corr1",
      documentNumber: "RK-2026-0001",
      correctedDocumentId: "doc1",
      date: "2026-05-02",
      taxCase: "domestic",
      contactId: "contact1",
      vatGroups: [g19(-20000, -3800)],
    },
    expect: {
      explanation: "S13-ist",
      lines: [
        ["receivable", "1400", "1200", "H", 23800],
        ["revenue.domestic.19", "8400", "4400", "S", 20000],
        ["vat.output.notdue.19", "1766", "3816", "S", 3800],
      ],
    },
  },
  {
    id: "S13-rectification-no-change",
    covers: "UST-31 Rechnungsberichtigung (unchanged amounts) → no entry",
    event: {
      kind: "invoice_corrected",
      documentId: "corr2",
      documentNumber: "RB-1",
      correctedDocumentId: "doc1",
      date: "2026-05-02",
      taxCase: "domestic",
      contactId: "contact1",
      vatGroups: [g19(0, 0)],
    },
    expect: { none: "no_change" },
  },
  // ── 4.2.2 payments ───────────────────────────────────────────────────────────────────────────────────
  {
    id: "P1-bank-soll",
    covers: "P1",
    event: { ...pay, amountCents: 119000 },
    expect: {
      explanation: "P1",
      lines: [
        [BANK, "1200", "1800", "S", 119000],
        ["receivable", "1400", "1200", "H", 119000],
      ],
    },
  },
  {
    id: "P2-ist-first-half",
    covers: "P1/P2 Ist, E-TAX-02, TST-ACC-13 (1,190 € paid 595 € in April)",
    ctx: IST,
    event: {
      ...pay,
      amountCents: 59500,
      ist: { notDueVat: [{ rateBp: 1900, vatCents: 19000 }], payableCents: 119000, settledBeforeCents: 0 },
    },
    expect: {
      explanation: "P1-ist",
      lines: [
        [BANK, "1200", "1800", "S", 59500],
        ["receivable", "1400", "1200", "H", 59500],
        ["vat.output.notdue.19", "1766", "3816", "S", 9500],
        ["vat.output.19", "1776", "3806", "H", 9500],
      ],
    },
  },
  {
    id: "P2-ist-mixed-rates-last-payment",
    covers: "P2 Ist, E-TAX-03, EC-172 (last instalment absorbs the rounding)",
    ctx: IST,
    event: {
      ...pay,
      amountCents: 57501,
      ist: {
        notDueVat: [
          { rateBp: 1900, vatCents: 19000 },
          { rateBp: 700, vatCents: 3500 },
        ],
        payableCents: 172500,
        settledBeforeCents: 114999,
      },
    },
    expect: {
      explanation: "P1-ist",
      lines: [
        [BANK, "1200", "1800", "S", 57501],
        ["receivable", "1400", "1200", "H", 57501],
        ["vat.output.notdue.19", "1766", "3816", "S", 6333],
        ["vat.output.19", "1776", "3806", "H", 6333],
        ["vat.output.notdue.7", "1761", "3811", "S", 1167],
        ["vat.output.7", "1771", "3801", "H", 1167],
      ],
    },
  },
  {
    id: "P3-cash-soll",
    covers: "P3, ACC-026, CSH-021, TST-ACC-29",
    event: { ...pay, means: { kind: "cash" }, amountCents: 11900 },
    expect: {
      explanation: "P3",
      lines: [
        ["cash", "1000", "1600", "S", 11900],
        ["receivable", "1400", "1200", "H", 11900],
      ],
    },
  },
  {
    id: "P3-cash-ist",
    covers: "P3 Ist, TST-ACC-29",
    ctx: IST,
    event: {
      ...pay,
      means: { kind: "cash" },
      amountCents: 11900,
      ist: { notDueVat: [{ rateBp: 1900, vatCents: 1900 }], payableCents: 11900, settledBeforeCents: 0 },
    },
    expect: {
      explanation: "P3-ist",
      lines: [
        ["cash", "1000", "1600", "S", 11900],
        ["receivable", "1400", "1200", "H", 11900],
        ["vat.output.notdue.19", "1766", "3816", "S", 1900],
        ["vat.output.19", "1776", "3806", "H", 1900],
      ],
    },
  },
  {
    id: "P4-skonto-soll",
    covers: "P4, UST-32",
    event: {
      ...pay,
      amountCents: 115430,
      differences: [
        { reason: "skonto", amountCents: 3570, vatCorrection: [{ rateBp: 1900, netCents: 3000, vatCents: 570 }] },
      ],
    },
    expect: {
      explanation: "P1",
      lines: [
        [BANK, "1200", "1800", "S", 115430],
        ["skonto.granted.19", "8736", "4736", "S", 3000],
        ["vat.output.19", "1776", "3806", "S", 570],
        ["receivable", "1400", "1200", "H", 119000],
      ],
    },
  },
  {
    id: "P4-skonto-ist",
    covers: "P4 Ist (Skonto VAT never becomes due)",
    ctx: IST,
    event: {
      ...pay,
      amountCents: 115430,
      differences: [
        { reason: "skonto", amountCents: 3570, vatCorrection: [{ rateBp: 1900, netCents: 3000, vatCents: 570 }] },
      ],
      ist: { notDueVat: [{ rateBp: 1900, vatCents: 19000 }], payableCents: 119000, settledBeforeCents: 0 },
    },
    expect: {
      explanation: "P1-ist",
      lines: [
        [BANK, "1200", "1800", "S", 115430],
        ["skonto.granted.19", "8736", "4736", "S", 3000],
        ["vat.output.notdue.19", "1766", "3816", "S", 19000],
        ["receivable", "1400", "1200", "H", 119000],
        ["vat.output.19", "1776", "3806", "H", 18430],
      ],
    },
  },
  {
    id: "P5-bank-fee-deducted",
    covers: "P5",
    event: { ...pay, amountCents: 118500, differences: [{ reason: "bank_fees", amountCents: 500 }] },
    expect: {
      explanation: "P1",
      lines: [
        [BANK, "1200", "1800", "S", 118500],
        ["expense.bank_fees", "4970", "6855", "S", 500],
        ["receivable", "1400", "1200", "H", 119000],
      ],
    },
  },
  {
    id: "P6-overpayment-credit",
    covers: "P6, EC-120",
    event: { ...pay, amountCents: 1000, target: { kind: "contactCredit", id: "contact1" } },
    expect: {
      explanation: "P6",
      lines: [
        [BANK, "1200", "1800", "S", 1000],
        ["receivable", "1400", "1200", "H", 1000],
      ],
    },
  },
  {
    id: "P7-dunning-fees-and-interest",
    covers: "P7, E-TAX-22",
    event: {
      ...pay,
      amountCents: 124500,
      differences: [
        { reason: "dunning_fees", amountCents: -4000 },
        { reason: "default_interest", amountCents: -1500 },
      ],
    },
    expect: {
      explanation: "P1",
      lines: [
        [BANK, "1200", "1800", "S", 124500],
        ["income.other_nontaxable", "2700", "4830", "H", 4000],
        ["income.interest_default", "2650", "7100", "H", 1500],
        ["receivable", "1400", "1200", "H", 119000],
      ],
    },
  },
  {
    id: "P8-write-off-soll",
    covers: "P8, E-TAX-11, EC-124",
    event: {
      ...pay,
      means: { kind: "none" },
      amountCents: 0,
      differences: [
        {
          reason: "write_off",
          amountCents: 119000,
          vatCorrection: [{ rateBp: 1900, netCents: 100000, vatCents: 19000 }],
        },
      ],
    },
    expect: {
      explanation: "P8",
      lines: [
        ["writeoff.19", "2406", "6936", "S", 100000],
        ["vat.output.19", "1776", "3806", "S", 19000],
        ["receivable", "1400", "1200", "H", 119000],
      ],
    },
  },
  {
    id: "P8-write-off-ist",
    covers: "P8 Ist, E-TAX-12",
    ctx: IST,
    event: {
      ...pay,
      means: { kind: "none" },
      amountCents: 0,
      differences: [
        {
          reason: "write_off",
          amountCents: 119000,
          vatCorrection: [{ rateBp: 1900, netCents: 100000, vatCents: 19000 }],
        },
      ],
      ist: { notDueVat: [{ rateBp: 1900, vatCents: 19000 }], payableCents: 119000, settledBeforeCents: 0 },
    },
    expect: {
      explanation: "P8",
      lines: [
        ["writeoff.19", "2406", "6936", "S", 100000],
        ["vat.output.notdue.19", "1766", "3816", "S", 19000],
        ["receivable", "1400", "1200", "H", 119000],
      ],
    },
  },
  {
    id: "P9-recovery-after-write-off",
    covers: "P9, E-TAX-11",
    event: {
      kind: "writeoff_recovered",
      paymentId: "pay-rec",
      date: "2026-11-02",
      means: { kind: "bank_account", bankAccountId: "bank1" },
      recovered: [{ rateBp: 1900, netCents: 50000, vatCents: 9500 }],
      documentNumber: "RE-2026-0001",
      contactId: "contact1",
    },
    expect: {
      explanation: "P9",
      lines: [
        [BANK, "1200", "1800", "S", 59500],
        ["writeoff.recovery", "2732", "4925", "H", 50000],
        ["vat.output.19", "1776", "3806", "H", 9500],
      ],
    },
  },
  {
    id: "P10-payment-reversal-ist",
    covers: "P10, R13, EC-141 (reverses the Ist transfer too)",
    ctx: IST,
    event: {
      kind: "payment_reversed",
      paymentId: "pay1-rev",
      originalPaymentId: "pay1",
      date: "2026-04-20",
      reason: "Rücklastschrift",
    },
    original: {
      ...pay,
      amountCents: 59500,
      ist: { notDueVat: [{ rateBp: 1900, vatCents: 19000 }], payableCents: 119000, settledBeforeCents: 0 },
    },
    expect: {
      explanation: "P10",
      lines: [
        [BANK, "1200", "1800", "H", 59500],
        ["receivable", "1400", "1200", "S", 59500],
        ["vat.output.notdue.19", "1766", "3816", "H", 9500],
        ["vat.output.19", "1776", "3806", "S", 9500],
      ],
    },
  },
  {
    id: "P11-refund-credit-balance",
    covers: "P11",
    event: {
      kind: "customer_refund",
      paymentId: "refund1",
      date: "2026-05-01",
      means: { kind: "bank_account", bankAccountId: "bank1" },
      amountCents: 1000,
      contactId: "contact1",
    },
    expect: {
      explanation: "P11",
      lines: [
        ["receivable", "1400", "1200", "S", 1000],
        [BANK, "1200", "1800", "H", 1000],
      ],
    },
  },
  // ── 4.2.4 cash transfers ─────────────────────────────────────────────────────────────────────────────
  {
    id: "T5-deposit-cash-leg",
    covers: "T5, CSH-024, TST-ACC-32",
    event: {
      kind: "cash_transfer",
      cashTransferId: "ct1",
      transferKind: "deposit_to_bank",
      leg: "cash",
      date: "2026-03-02",
      amountCents: 50000,
    },
    expect: {
      explanation: "T5",
      lines: [
        ["transit", "1360", "1460", "S", 50000],
        ["cash", "1000", "1600", "H", 50000],
      ],
    },
  },
  {
    id: "T5-deposit-bank-leg",
    covers: "T5 bank leg, TST-ACC-32",
    event: {
      kind: "cash_transfer",
      cashTransferId: "ct1",
      transferKind: "deposit_to_bank",
      leg: "bank",
      bankAccountId: "bank1",
      date: "2026-03-03",
      amountCents: 50000,
    },
    expect: {
      explanation: "T5-bank",
      lines: [
        [BANK, "1200", "1800", "S", 50000],
        ["transit", "1360", "1460", "H", 50000],
      ],
    },
  },
  {
    id: "T8-private-withdrawal",
    covers: "T8, CSH-024, TST-ACC-33",
    event: {
      kind: "cash_transfer",
      cashTransferId: "ct2",
      transferKind: "private_withdrawal",
      date: "2026-03-04",
      amountCents: 10000,
    },
    expect: {
      explanation: "T8",
      lines: [
        ["private.withdrawal", "1800", "2100", "S", 10000],
        ["cash", "1000", "1600", "H", 10000],
      ],
    },
  },
  {
    id: "T8-corporation-shareholder-unmapped",
    covers: "T8 corporation, ACC-028, E-ACC-30, TST-ACC-31 (shareholder.clearing ships unmapped)",
    ctx: { legalForm: "gmbh" },
    event: {
      kind: "cash_transfer",
      cashTransferId: "ct3",
      transferKind: "private_withdrawal",
      date: "2026-03-04",
      amountCents: 10000,
      shareholder: { name: "A. Gesellschafter", note: "Entnahme gegen Verrechnungskonto" },
    },
    expect: { error: "role_unmapped" },
  },
  {
    id: "T9-atm-withdrawal-to-till",
    covers: "T9, CSH-025, TST-ACC-34",
    event: {
      kind: "cash_transfer",
      cashTransferId: "ct4",
      transferKind: "bank_withdrawal_to_cash",
      bankAccountId: "bank1",
      date: "2026-03-05",
      amountCents: 20000,
    },
    expect: {
      explanation: "T9",
      lines: [
        ["transit", "1360", "1460", "S", 20000],
        [BANK, "1200", "1800", "H", 20000],
        ["cash", "1000", "1600", "S", 20000],
        ["transit", "1360", "1460", "H", 20000],
      ],
    },
  },
  {
    id: "T10-cash-transfer-reversal",
    covers: "T10, CSH-027",
    event: {
      kind: "cash_transfer_reversed",
      cashTransferId: "ct2-rev",
      originalCashTransferId: "ct2",
      date: "2026-03-06",
      reason: "Falscher Betrag",
    },
    original: {
      kind: "cash_transfer",
      cashTransferId: "ct2",
      transferKind: "private_withdrawal",
      date: "2026-03-04",
      amountCents: 10000,
    },
    expect: {
      explanation: "T10",
      lines: [
        ["private.withdrawal", "1800", "2100", "H", 10000],
        ["cash", "1000", "1600", "S", 10000],
      ],
    },
  },
  // ── opening balances (ACC-013, P1 subset) ────────────────────────────────────────────────────────────
  {
    id: "OB-cash",
    covers: "ACC-013, CSH-020",
    event: {
      kind: "opening_balance",
      fiscalYear: 2027,
      date: "2027-01-01",
      part: { kind: "cash", amountCents: 35000 },
    },
    expect: {
      explanation: "ACC-013-cash",
      lines: [
        ["cash", "1000", "1600", "S", 35000],
        ["opening.gl", "9000", "9000", "H", 35000],
      ],
    },
  },
  {
    id: "OB-bank-overdrawn",
    covers: "ACC-013 bank (negative balance)",
    event: {
      kind: "opening_balance",
      fiscalYear: 2027,
      date: "2027-01-01",
      part: { kind: "bank", bankAccountId: "bank1", amountCents: -12000 },
    },
    expect: {
      explanation: "ACC-013-bank",
      lines: [
        [BANK, "1200", "1800", "H", 12000],
        ["opening.gl", "9000", "9000", "S", 12000],
      ],
    },
  },
  {
    id: "OB-receivables-soll-and-ist",
    covers: "ACC-013, TST-ACC-09 (Ist item keeps its not-due VAT)",
    event: {
      kind: "opening_balance",
      fiscalYear: 2027,
      date: "2027-01-01",
      part: {
        kind: "receivables",
        items: [
          { openingItemId: "oi1", number: "SD-1001", contactId: "contact1", openCents: 119000, taxedAs: "soll" },
          {
            openingItemId: "oi2",
            number: "SD-1002",
            contactId: "contact2",
            openCents: 59500,
            taxedAs: "ist",
            notDueVat: [{ rateBp: 1900, vatCents: 9500 }],
          },
        ],
      },
    },
    expect: {
      explanation: "ACC-013-receivables",
      lines: [
        ["receivable", "1400", "1200", "S", 119000],
        ["opening.debtors", "9008", "9008", "H", 119000],
        ["receivable", "1400", "1200", "S", 59500],
        ["opening.debtors", "9008", "9008", "H", 59500],
        ["opening.gl", "9000", "9000", "S", 9500],
        ["vat.output.notdue.19", "1766", "3816", "H", 9500],
      ],
    },
  },
];
