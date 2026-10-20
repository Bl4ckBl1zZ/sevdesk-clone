/**
 * Golden EÜR year (TST-TAX-18; TAX-015, TAX-016, AO-02): a regular (Soll) Einzelunternehmen on SKR04 with a year of
 * typical events, posted through the real posting engine (`postEvent` + `resolveLines`), then turned into the
 * cash-basis view and the Anlage EÜR lines. The expected sheet lives in `expected-euer/` (change only with
 * `pnpm golden:update` and a written legal reason, CLAUDE.md rule 11).
 */
import { describe, expect, test } from "vitest";
import type { BusinessEvent, ReversalEvent, VoucherBookedEvent } from "@/domain/accounting/events";
import { type PostingContext, postEvent } from "@/domain/accounting/post";
import { resolveLines } from "@/domain/accounting/resolve";
import { seededAccount } from "@/domain/rules/accounting";
import { euerMappingFor } from "@/domain/rules/euer";
import { cashBasisItems, computeEuer, type EuerContext, type EuerJournalEntry } from "@/domain/tax/euer";
import { calendarDate } from "@/domain/time/calendar-date";

type Posted = Exclude<BusinessEvent, ReversalEvent>;

const CTX: PostingContext = {
  taxationMethod: "soll",
  legalForm: "einzelunternehmen",
  ustvaPeriod: [2025, 2026, 2027].map((year) => ({ year, period: "monthly" as const })),
};
const means = { kind: "bank_account" as const, bankAccountId: "bank1" };
const invoice = (id: string, date: string, net: number, rateBp = 1900): Posted => ({
  kind: "invoice_finalised",
  documentId: id,
  documentNumber: `RE-${id}`,
  documentType: "invoice",
  date,
  supplyDate: { kind: "date", date },
  taxCase: "domestic",
  contactId: "c1",
  vatGroups: [{ category: "S", rateBp, netCents: net, vatCents: Math.round((net * rateBp) / 10000) }],
});
const paid = (id: string, doc: string, date: string, amountCents: number, extra: object = {}): Posted => ({
  kind: "payment_received",
  paymentId: id,
  date,
  means,
  amountCents,
  target: { kind: "salesDocument", id: doc },
  contactId: "c1",
  ...extra,
});
const voucher = (
  id: string,
  date: string,
  lines: VoucherBookedEvent["lines"],
  extra: Partial<VoucherBookedEvent> = {},
): Posted => ({
  kind: "voucher_booked",
  voucherId: id,
  number: `BE-${id}`,
  direction: "expense",
  voucherKind: "standard",
  taxRule: "input_vat_deductible",
  companyIsKu: false,
  date,
  supplyDate: { kind: "date", date },
  receivedDate: date,
  contactId: "s1",
  lines,
  ...extra,
});
const vline = (account: string, netCents: number, vatCents: number, vatRateBp: number) => ({
  account,
  netCents,
  vatCents,
  vatRateBp,
});
const voucherPaid = (
  id: string,
  v: string,
  date: string,
  amountCents: number,
  m: { kind: "bank_account"; bankAccountId: string } | { kind: "private" } = means,
): Posted => ({
  kind: "voucher_paid",
  paymentId: id,
  date,
  direction: "expense",
  means: m,
  amountCents,
  voucher: { id: v },
  inputVatDeducted: true,
});
const taxVoucher = (id: string, date: string, cents: number, subtype: "ust_prepayment" | "gewerbesteuer") =>
  voucher(id, date, [vline(subtype === "gewerbesteuer" ? "7610" : "3820", cents, 0, 0)], {
    voucherKind: "tax_payment",
    taxRule: "no_input_vat",
    taxPaymentSubtype: subtype,
  });

/** The golden year: events in business order. */
const EVENTS: Posted[] = [
  invoice("d0", "2025-12-10", 100000),
  voucher("ust2512", "2025-12-31", [vline("3820", 40000, 0, 0)], {
    voucherKind: "tax_payment",
    taxRule: "no_input_vat",
    taxPaymentSubtype: "ust_prepayment",
  }),
  paid("p0", "d0", "2026-01-05", 119000),
  voucherPaid("vp-ust2512", "ust2512", "2026-01-09", 40000),
  invoice("d1", "2026-01-15", 500000),
  paid("p1", "d1", "2026-02-10", 595000),
  voucher("v1", "2026-03-01", [vline("6815", 10000, 1900, 1900)]),
  voucherPaid("vp1", "v1", "2026-03-05", 11900),
  voucher("asset1", "2026-04-01", [vline("0650", 120000, 22800, 1900)], { voucherKind: "asset" }),
  voucherPaid("vp-asset1", "asset1", "2026-04-03", 142800),
  ...["04", "05", "06", "07", "08", "09", "10", "11", "12"].map(
    (m): Posted => ({
      kind: "asset_depreciation",
      assetId: "a1",
      inventoryNumber: "INV-1",
      name: "Schreibtisch",
      period: `2026-${m}`,
      date: `2026-${m}-${m === "04" || m === "06" || m === "09" || m === "11" ? "30" : "31"}`,
      amountCents: 1000,
      assetAccount: "0650",
      afaRole: "afa.tangible",
    }),
  ),
  taxVoucher("gewst", "2026-05-15", 30000, "gewerbesteuer"),
  voucherPaid("vp-gewst", "gewst", "2026-05-15", 30000),
  invoice("d4", "2026-06-01", 100000, 700),
  paid("p4", "d4", "2026-06-10", 104860, {
    differences: [
      { reason: "skonto", amountCents: 2140, vatCorrection: [{ rateBp: 700, netCents: 2000, vatCents: 140 }] },
    ],
  }),
  {
    kind: "bank_transaction_marked",
    transactionId: "t1",
    mark: "private",
    date: "2026-07-01",
    amountCents: -100000,
    bankAccountId: "bank1",
  },
  voucher("v5", "2026-08-01", [vline("6820", 5000, 350, 700)]),
  voucherPaid("vp5", "v5", "2026-08-01", 5350, { kind: "private" }),
  invoice("d2", "2026-11-20", 200000),
  taxVoucher("ust2611", "2026-12-01", 50000, "ust_prepayment"),
  voucherPaid("vp-ust2611", "ust2611", "2026-12-10", 50000),
  taxVoucher("ust2612", "2026-12-31", 60000, "ust_prepayment"),
  voucherPaid("vp-ust2612", "ust2612", "2027-01-08", 60000),
  paid("p2", "d2", "2027-01-15", 238000),
];

/** Payment id → target, as the `payments` table would hold it. */
const PAYMENTS: EuerContext["payments"] = Object.fromEntries(
  EVENTS.flatMap((e): [string, EuerContext["payments"][string]][] => {
    if (e.kind === "payment_received") return [[e.paymentId, { target: { kind: e.target.kind, id: e.target.id } }]];
    if (e.kind === "voucher_paid") return [[e.paymentId, { target: { kind: "voucher" as const, id: e.voucher.id } }]];
    return [];
  }),
);

function journal(): EuerJournalEntry[] {
  return EVENTS.map((event, i) => {
    const r = postEvent(event, CTX);
    if (!r.ok || r.value.kind !== "entry") throw new Error(`event ${i} (${event.kind}) not posted`);
    const p = r.value.posting;
    const res = resolveLines(p.lines, {
      chart: "SKR04",
      date: p.date,
      overrides: [],
      bankAccounts: [{ id: "bank1", ledgerAccount: "1800" }],
    });
    if (!res.ok) throw new Error(`event ${i}: ${res.error.message}`);
    return {
      id: `e${i + 1}`,
      seq: i + 1,
      date: p.date,
      source: p.source,
      text: p.text,
      recordedAt: i + 1,
      lines: res.value.lines.map((l) => ({
        account: l.account,
        ...(l.role ? { role: l.role } : {}),
        debitCents: l.debitCents,
        creditCents: l.creditCents,
      })),
    };
  });
}

const context: EuerContext = {
  euerKeyOf: (a) => seededAccount("SKR04", calendarDate("2026-01-01"), a)?.euerKey ?? "NONE",
  openItemAccounts: new Set(["1200", "3300"]),
  payments: PAYMENTS,
  openingItems: {},
  assets: { a1: { assetClass: "movable", method: "linear" } },
  tenDay: {
    ust2512: { dueDate: "2026-01-10", economicYear: 2025, reason: "UStVA 12/2025" },
    ust2611: { dueDate: "2026-12-10", economicYear: 2026, reason: "UStVA 11/2026" },
    ust2612: { dueDate: "2027-01-10", economicYear: 2026, reason: "UStVA 12/2026" },
  },
  kuOn: () => false,
};

describe("TST-TAX-18 golden EÜR year (TAX-015, TAX-016, AO-02)", () => {
  const items = cashBasisItems(journal(), context);
  const sheet = computeEuer(2026, items, euerMappingFor(2026), { ku: false });

  test("TAX-015 AO-02 MISC-05 RI-28 TST-TAX-18 Anlage EÜR 2026 lines of the golden year match the expected file", async () => {
    const golden = {
      year: sheet.year,
      mappingVersion: sheet.mappingVersion,
      verified: sheet.verified,
      lines: sheet.lines
        .filter((l) => l.valueCents !== 0)
        .map((l) => ({ zeile: l.zeile, kz: l.kz, label: l.label, cents: l.valueCents })),
      sums: sheet.sums,
      values: sheet.values,
      unmapped: sheet.unmapped,
    };
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot("./expected-euer/euer-2026.json");
  });

  test("TAX-016 EC-177 the December 2026 UStVA paid on 08.01.2027 is in 2026; the December 2025 one paid 09.01.2026 is not", () => {
    const ust = sheet.lines.find((l) => l.kz === "186");
    expect(ust?.valueCents).toBe(110000);
    expect(ust?.drillDown.map((d) => [d.date, d.tenDayRule ?? null])).toEqual([
      ["2026-12-10", null],
      ["2027-01-08", "UStVA 12/2026"],
    ]);
    expect(computeEuer(2025, items, euerMappingFor(2025), { ku: false }).values["186"]).toBe(40000);
  });

  test("AO-02 RI-28 income follows the payment: the invoice of 20.11.2026 paid in 2027 is not in 2026, the one of 10.12.2025 paid in 2026 is", () => {
    const be = sheet.lines.find((l) => l.kz === "112");
    // the Skonto line of payment p4 reduces the income on the payment date
    expect(be?.drillDown.map((d) => d.via?.id ?? d.source.id)).toEqual(["d0", "d1", "d4", "p4"]);
  });
});
