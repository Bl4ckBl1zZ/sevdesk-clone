/**
 * Golden cases for the posting matrix (F08 §4.2 `posting-2026.1`, TST-ACC-02): every P1 event type × tax case
 * with the expected lines written out by hand as [role, SKR03 account, SKR04 account, side, cents]. The test
 * also writes the full resolved entries to `expected/<id>.journal.json` (change only with `pnpm golden:update`
 * and a written legal reason, CLAUDE.md rule 11).
 */
import type { BusinessEvent, ReversalEvent, VoucherBookedEvent } from "@/domain/accounting/events";
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
const vb = {
  kind: "voucher_booked" as const,
  voucherId: "v1",
  number: "BE-2026-00001",
  direction: "expense" as const,
  voucherKind: "standard" as const,
  taxRule: "input_vat_deductible",
  companyIsKu: false,
  date: "2026-03-10",
  supplyDate: { kind: "date" as const, date: "2026-03-05" },
  receivedDate: "2026-03-10",
  contactId: "contact1",
  counterpartyName: "Büro Schmidt GmbH",
};
/** Golden voucher lines name a role so one event resolves in both charts (the UI stores the chosen account). */
const vl = (role: string, netCents: number, vatCents: number, vatRateBp: number, extra: object = {}) => ({
  account: "",
  role,
  netCents,
  vatCents,
  vatRateBp,
  ...extra,
});
const vp = {
  kind: "voucher_paid" as const,
  paymentId: "vpay1",
  date: "2026-03-20",
  direction: "expense" as const,
  means: { kind: "bank_account" as const, bankAccountId: "bank1" },
  amountCents: 11900,
  voucher: { id: "v1", number: "BE-2026-00001" },
  contactId: "contact1",
  counterpartyName: "Büro Schmidt GmbH",
  inputVatDeducted: true,
};
const KU = { companyIsKu: true, taxRule: "no_input_vat" };
const B1_LINES = [
  { account: "", netCents: 10000, vatCents: 700, vatRateBp: 700 },
  { account: "", netCents: 5000, vatCents: 950, vatRateBp: 1900 },
  { account: "", netCents: 1000, vatCents: 0, vatRateBp: 0 },
];
const tax = (
  subtype: NonNullable<VoucherBookedEvent["taxPaymentSubtype"]>,
  direction: "expense" | "income" = "expense",
): VoucherBookedEvent => ({
  ...vb,
  voucherKind: "tax_payment",
  taxRule: "no_input_vat",
  direction,
  taxPaymentSubtype: subtype,
  contactId: "fa1",
  counterpartyName: "Finanzamt",
  lines: [{ account: "", netCents: 50000, vatCents: 0, vatRateBp: 0 }],
});
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
  // ── 4.2.3 purchase vouchers (P2, F06 VOU-020…027, VOU-061, VOU-065) ─────────────────────────────────────
  {
    id: "V1-input-vat-19",
    covers: "V1, VOU-020, UST-15",
    event: { ...vb, lines: [vl("expense.services", 10000, 1900, 1900)] },
    expect: {
      explanation: "V1",
      lines: [
        ["expense.services", "3100", "5900", "S", 10000],
        ["vat.input.19", "1576", "1406", "S", 1900],
        ["payable", "1600", "3300", "H", 11900],
      ],
    },
  },
  {
    id: "V1-rate-16-unsupported-2026",
    covers: "V1, VOU-004, F08-Q1 (no role for historical rates → blocked, never guessed)",
    event: { ...vb, lines: [vl("expense.services", 10000, 1600, 1600)] },
    expect: { error: "rate_not_supported" },
  },
  {
    id: "V1-private-share-30",
    covers: "V1 + private share, VOU-027 (expense and VAT reduced by the share → Privatentnahme)",
    event: { ...vb, lines: [vl("expense.services", 10000, 1900, 1900, { nonDeductibleShareBp: 3000 })] },
    expect: {
      explanation: "V1",
      lines: [
        ["expense.services", "3100", "5900", "S", 7000],
        ["vat.input.19", "1576", "1406", "S", 1330],
        ["private.withdrawal", "1800", "2100", "S", 3570],
        ["payable", "1600", "3300", "H", 11900],
      ],
    },
  },
  {
    id: "V4-ku-company-gross-to-expense",
    covers: "V4, VOU-021, VOU-026, KU-01",
    event: { ...vb, ...KU, lines: [vl("expense.services", 10000, 1900, 1900)] },
    expect: {
      explanation: "V4",
      lines: [
        ["expense.services", "3100", "5900", "S", 11900],
        ["payable", "1600", "3300", "H", 11900],
      ],
    },
  },
  {
    id: "V5-bewirtung-golden-B1",
    covers: "V5, MISC-05, VOU-061, T06-100 (golden B1: 112,00 / 48,00 / VSt 16,50)",
    event: { ...vb, voucherKind: "bewirtung", bewirtungOccasion: "geschaeftlich", lines: B1_LINES },
    expect: {
      explanation: "V5",
      lines: [
        ["expense.entertainment", "4650", "6640", "S", 7000],
        ["expense.entertainment.nd", "4654", "6644", "S", 3000],
        ["vat.input.7", "1571", "1401", "S", 700],
        ["expense.entertainment", "4650", "6640", "S", 3500],
        ["expense.entertainment.nd", "4654", "6644", "S", 1500],
        ["vat.input.19", "1576", "1406", "S", 950],
        ["expense.entertainment", "4650", "6640", "S", 700],
        ["expense.entertainment.nd", "4654", "6644", "S", 300],
        ["payable", "1600", "3300", "H", 17650],
      ],
    },
  },
  {
    id: "V5-bewirtung-golden-B2-ku",
    covers: "V5 KU, MISC-05, VOU-061, KU-01, T06-101 (golden B2: gross split 123,55 / 52,95)",
    event: { ...vb, ...KU, voucherKind: "bewirtung", bewirtungOccasion: "geschaeftlich", lines: B1_LINES },
    expect: {
      explanation: "V5",
      lines: [
        ["expense.entertainment", "4650", "6640", "S", 12355],
        ["expense.entertainment.nd", "4654", "6644", "S", 5295],
        ["payable", "1600", "3300", "H", 17650],
      ],
    },
  },
  {
    id: "V5-staff-event",
    covers: "V5 Arbeitnehmer, VOU-060 (100 % on expense.staff_events, no split)",
    event: {
      ...vb,
      voucherKind: "bewirtung",
      bewirtungOccasion: "arbeitnehmer",
      lines: [{ account: "", netCents: 5000, vatCents: 950, vatRateBp: 1900 }],
    },
    expect: {
      explanation: "V5",
      lines: [
        ["expense.staff_events", "4140", "6130", "S", 5000],
        ["vat.input.19", "1576", "1406", "S", 950],
        ["payable", "1600", "3300", "H", 5950],
      ],
    },
  },
  {
    id: "V6-reverse-charge-eu-golden-V1",
    covers: "V6, VOU-022, T06-070 (golden V1: 190/190, payable net), EC-164",
    event: {
      ...vb,
      taxRule: "reverse_charge_eu",
      counterpartyName: "Google Ireland Ltd.",
      lines: [vl("expense.13b_eu.19", 100000, 0, 1900, { selfAssessedVatCents: 19000 })],
    },
    expect: {
      explanation: "V6",
      lines: [
        ["expense.13b_eu.19", "3123", "5923", "S", 100000],
        ["vat.output.13b.19", "1787", "3837", "H", 19000],
        ["vat.input.13b.19", "1577", "1407", "S", 19000],
        ["payable", "1600", "3300", "H", 100000],
      ],
    },
  },
  {
    id: "V6-reverse-charge-eu-ku-golden-V2",
    covers: "V6 KU, VOU-026, KU-01, T06-071 (golden V2: output 190, no input VAT) ⚠ expense.vat_nondeductible",
    event: {
      ...vb,
      taxRule: "reverse_charge_eu",
      companyIsKu: true,
      counterpartyName: "Google Ireland Ltd.",
      lines: [vl("expense.13b_eu.19", 100000, 0, 1900, { selfAssessedVatCents: 19000 })],
    },
    expect: {
      explanation: "V6-ku",
      lines: [
        ["expense.13b_eu.19", "3123", "5923", "S", 100000],
        ["vat.output.13b.19", "1787", "3837", "H", 19000],
        ["expense.vat_nondeductible", "4300", "6860", "S", 19000],
        ["payable", "1600", "3300", "H", 100000],
      ],
    },
  },
  {
    id: "V7-reverse-charge-non-eu-golden-V3",
    covers: "V7, VOU-022, VOU-028 (golden V3 EUR values 30,41 / 5,78)",
    event: {
      ...vb,
      taxRule: "reverse_charge_non_eu",
      lines: [vl("expense.13b_foreign.19", 3041, 0, 1900, { selfAssessedVatCents: 578 })],
    },
    expect: {
      explanation: "V7",
      lines: [
        ["expense.13b_foreign.19", "3125", "5925", "S", 3041],
        ["vat.output.13b.19", "1787", "3837", "H", 578],
        ["vat.input.13b.19", "1577", "1407", "S", 578],
        ["payable", "1600", "3300", "H", 3041],
      ],
    },
  },
  {
    id: "V8-reverse-charge-13b-domestic",
    covers: "V8, VOU-022",
    event: {
      ...vb,
      taxRule: "reverse_charge_13b_de",
      lines: [vl("expense.13b_domestic.19", 20000, 0, 1900, { selfAssessedVatCents: 3800 })],
    },
    expect: {
      explanation: "V8",
      lines: [
        ["expense.13b_domestic.19", "3120", "5920", "S", 20000],
        ["vat.output.13b.19", "1787", "3837", "H", 3800],
        ["vat.input.13b.19", "1577", "1407", "S", 3800],
        ["payable", "1600", "3300", "H", 20000],
      ],
    },
  },
  {
    id: "V9-intra-community-acquisition",
    covers: "V9, VOU-022, VOU-023",
    event: {
      ...vb,
      taxRule: "intra_community_acquisition",
      lines: [vl("expense.ige.19", 50000, 0, 1900, { selfAssessedVatCents: 9500 })],
    },
    expect: {
      explanation: "V9",
      lines: [
        ["expense.ige.19", "3425", "5425", "S", 50000],
        ["vat.output.ige.19", "1774", "3804", "H", 9500],
        ["vat.input.ige.19", "1574", "1404", "S", 9500],
        ["payable", "1600", "3300", "H", 50000],
      ],
    },
  },
  {
    id: "V10-import-vat-customs-notice",
    covers: "V10, VOU-024 (EUSt line on the vat.import account, duty to expense)",
    event: {
      ...vb,
      taxRule: "import_vat",
      counterpartyName: "Hauptzollamt",
      lines: [vl("vat.import", 19000, 0, 0), vl("expense.goods.19", 2500, 0, 0)],
    },
    expect: {
      explanation: "V10",
      lines: [
        ["vat.import", "1588", "1433", "S", 19000],
        ["expense.goods.19", "3400", "5400", "S", 2500],
        ["payable", "1600", "3300", "H", 21500],
      ],
    },
  },
  {
    id: "V13-asset-gwg",
    covers: "V13, VOU-065, AO-03 (GWG chosen → asset.gwg)",
    event: {
      ...vb,
      voucherKind: "asset",
      lines: [{ account: "", netCents: 60000, vatCents: 11400, vatRateBp: 1900, assetDecision: "gwg" as const }],
    },
    expect: {
      explanation: "V13",
      lines: [
        ["asset.gwg", "0480", "0670", "S", 60000],
        ["vat.input.19", "1576", "1406", "S", 11400],
        ["payable", "1600", "3300", "H", 71400],
      ],
    },
  },
  {
    id: "VE-income-voucher-output-vat",
    covers: "VE, VOU-010 (income voucher, Soll)",
    event: {
      ...vb,
      direction: "income",
      taxRule: "output_vat",
      counterpartyName: "Versicherung AG",
      lines: [vl("revenue.domestic.19", 10000, 1900, 1900)],
    },
    expect: {
      explanation: "VE",
      lines: [
        ["revenue.domestic.19", "8400", "4400", "H", 10000],
        ["vat.output.19", "1776", "3806", "H", 1900],
        ["receivable", "1400", "1200", "S", 11900],
      ],
    },
  },
  {
    id: "V-storno-cancel",
    covers: "V-storno, VOU-009 (Generalumkehr dated in the open period)",
    event: {
      kind: "voucher_reversed",
      voucherId: "v1",
      number: "BE-2026-00001",
      date: "2026-04-15",
      reason: "Doppelt erfasst",
      mode: "cancel",
    },
    original: { ...vb, lines: [vl("expense.services", 10000, 1900, 1900)] },
    expect: {
      explanation: "V-storno",
      lines: [
        ["expense.services", "3100", "5900", "H", 10000],
        ["vat.input.19", "1576", "1406", "H", 1900],
        ["payable", "1600", "3300", "S", 11900],
      ],
    },
  },
  // ── voucher payments (V2/V3, T6, T7; VOU-131, VOU-132, VOU-137, VOU-138) ───────────────────────────────
  {
    id: "V2-voucher-paid-bank",
    covers: "V2, VOU-131",
    event: vp,
    expect: {
      explanation: "V2",
      lines: [
        ["payable", "1600", "3300", "S", 11900],
        [BANK, "1200", "1800", "H", 11900],
      ],
    },
  },
  {
    id: "V3-skonto-received",
    covers: "V2+V3, VOU-132, UST-32, T06-147 (2 % Skonto: input VAT corrected pro rata)",
    event: {
      ...vp,
      amountCents: 11662,
      differences: [
        { reason: "skonto", amountCents: 238, vatCorrection: [{ rateBp: 1900, netCents: 200, vatCents: 38 }] },
      ],
    },
    expect: {
      explanation: "V2+V3",
      lines: [
        ["payable", "1600", "3300", "S", 11900],
        ["skonto.received.19", "3736", "5736", "H", 200],
        ["vat.input.19", "1576", "1406", "H", 38],
        [BANK, "1200", "1800", "H", 11662],
      ],
    },
  },
  {
    id: "V3-skonto-received-ku",
    covers: "V2+V3 KU, VOU-132 (no input VAT deducted → gross Skonto, LEGAL-OPEN F08-Q1)",
    event: {
      ...vp,
      inputVatDeducted: false,
      amountCents: 11662,
      differences: [
        { reason: "skonto", amountCents: 238, vatCorrection: [{ rateBp: 1900, netCents: 200, vatCents: 38 }] },
      ],
    },
    expect: {
      explanation: "V2+V3",
      lines: [
        ["payable", "1600", "3300", "S", 11900],
        ["skonto.received.19", "3736", "5736", "H", 238],
        [BANK, "1200", "1800", "H", 11662],
      ],
    },
  },
  {
    id: "V2-bank-fee-difference",
    covers: "V2 + fees, VOU-132 (we paid 1,50 € more than the voucher)",
    event: { ...vp, amountCents: 12050, differences: [{ reason: "bank_fees", amountCents: -150 }] },
    expect: {
      explanation: "V2",
      lines: [
        ["payable", "1600", "3300", "S", 11900],
        ["expense.bank_fees", "4970", "6855", "S", 150],
        [BANK, "1200", "1800", "H", 12050],
      ],
    },
  },
  {
    id: "T6-voucher-paid-cash",
    covers: "T6, VOU-137, CSH-022",
    event: { ...vp, means: { kind: "cash" } },
    expect: {
      explanation: "T6",
      lines: [
        ["payable", "1600", "3300", "S", 11900],
        ["cash", "1000", "1600", "H", 11900],
      ],
    },
  },
  {
    id: "T7-voucher-paid-private",
    covers: "T7, VOU-138, CSH-023 (Privateinlage)",
    event: { ...vp, means: { kind: "private" } },
    expect: {
      explanation: "T7",
      lines: [
        ["payable", "1600", "3300", "S", 11900],
        ["private.deposit", "1890", "2180", "H", 11900],
      ],
    },
  },
  {
    id: "T7-corporation-shareholder-unmapped",
    covers: "T7 corporation, VOU-138, CSH-023, ACC-028, EC-VOU-42, E-ACC-30 (shareholder.clearing ships unmapped)",
    ctx: { legalForm: "gmbh" },
    event: { ...vp, means: { kind: "private" }, corporation: true },
    expect: { error: "role_unmapped" },
  },
  {
    id: "VE-pay-income-voucher-ist",
    covers: "VE-pay, VOU-010 (Ist: the VAT becomes due with the payment)",
    ctx: IST,
    event: {
      ...vp,
      direction: "income",
      ist: { notDueVat: [{ rateBp: 1900, vatCents: 1900 }], payableCents: 11900, settledBeforeCents: 0 },
    },
    expect: {
      explanation: "VE-pay",
      lines: [
        [BANK, "1200", "1800", "S", 11900],
        ["receivable", "1400", "1200", "H", 11900],
        ["vat.output.notdue.19", "1766", "3816", "S", 1900],
        ["vat.output.19", "1776", "3806", "H", 1900],
      ],
    },
  },
  // ── 4.2.6 tax payments (TAX-018) ────────────────────────────────────────────────────────────────────
  {
    id: "X1-ustva-payment",
    covers: "X1, TAX-018",
    event: tax("ust_prepayment"),
    expect: {
      explanation: "X1",
      lines: [
        ["vat.prepayment", "1780", "3820", "S", 50000],
        ["payable", "1600", "3300", "H", 50000],
      ],
    },
  },
  {
    id: "X2-ustva-refund",
    covers: "X2, TAX-018",
    event: tax("ust_prepayment", "income"),
    expect: {
      explanation: "X2",
      lines: [
        ["receivable", "1400", "1200", "S", 50000],
        ["vat.prepayment", "1780", "3820", "H", 50000],
      ],
    },
  },
  {
    id: "X3-sondervorauszahlung",
    covers: "X3, TAX-018",
    event: tax("sondervorauszahlung"),
    expect: {
      explanation: "X3",
      lines: [
        ["vat.special_prepayment", "1781", "3830", "S", 50000],
        ["payable", "1600", "3300", "H", 50000],
      ],
    },
  },
  {
    id: "X4-ust-annual-prior-year",
    covers: "X4, TAX-018",
    event: tax("ust_annual"),
    expect: {
      explanation: "X4",
      lines: [
        ["vat.prior_year", "1790", "3841", "S", 50000],
        ["payable", "1600", "3300", "H", 50000],
      ],
    },
  },
  {
    id: "X5-gewerbesteuer",
    covers: "X5, TAX-018",
    event: tax("gewerbesteuer"),
    expect: {
      explanation: "X5",
      lines: [
        ["expense.trade_tax", "4320", "7610", "S", 50000],
        ["payable", "1600", "3300", "H", 50000],
      ],
    },
  },
  {
    id: "X6-est-private",
    covers: "X6, TAX-018 (no EÜR effect)",
    event: tax("est_private"),
    expect: {
      explanation: "X6",
      lines: [
        ["private.taxes", "1810", "2150", "S", 50000],
        ["payable", "1600", "3300", "H", 50000],
      ],
    },
  },
  {
    id: "X7-kst-corporation",
    covers: "X7, TAX-018",
    ctx: { legalForm: "gmbh" },
    event: tax("kst"),
    expect: {
      explanation: "X7",
      lines: [
        ["expense.corp_tax", "2200", "7600", "S", 50000],
        ["payable", "1600", "3300", "H", 50000],
      ],
    },
  },
];
