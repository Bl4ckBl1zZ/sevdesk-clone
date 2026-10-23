import { describe, expect, test } from "vitest";
import { SKR03_ACCOUNTS } from "../rules/accounting/skr03";
import { SKR04_ACCOUNTS } from "../rules/accounting/skr04";
import { cashBasisItems, type EuerJournalEntry } from "../tax/euer";
import type { CalendarDate } from "../time/calendar-date";
import { type AccountContext, accountContextFor } from "./accounts";
import type { VoucherLine } from "./types";
import { type ValidationContext, type VoucherDraft, validateVoucher } from "./validate";

const d = (s: string) => s as CalendarDate;
const accounts = accountContextFor("SKR04", d("2026-03-10")) as AccountContext;
const ctx: ValidationContext = { today: d("2026-10-19"), companyIsKu: false, corporation: false, accounts };
const fee = (over: Partial<VoucherLine> = {}): VoucherLine => ({
  account: "1370",
  description: "Gerichtskosten Az. 12 C 345/26 für Mandant Müller",
  netCents: 45_000,
  vatRateBp: 0,
  vatCents: 0,
  grossCents: 45_000,
  ...over,
});
const draft = (over: Partial<VoucherDraft> = {}): VoucherDraft => ({
  direction: "expense",
  kind: "standard",
  taxRule: "no_input_vat",
  supplierName: "Amtsgericht Berlin-Mitte",
  documentNumber: "KR-2026-1",
  documentDate: "2026-03-10",
  currency: "EUR",
  lines: [fee()],
  originalFiles: [{}],
  ...over,
});
const MSG =
  "Durchlaufende Posten (Konto 1370) werden ohne Umsatzsteuer gebucht – bitte ‚Kein Vorsteuerabzug‘ bzw. ‚Nicht steuerbare Einnahme‘ wählen.";

describe("Durchlaufende Posten (VOU-011)", () => {
  test("VOU-011 the pass-through accounts are SKR03 1590 / SKR04 1370 and carry no EÜR line", () => {
    const s3 = SKR03_ACCOUNTS.find((a) => a.number === "1590");
    const s4 = SKR04_ACCOUNTS.find((a) => a.number === "1370");
    expect(s3).toMatchObject({ passThrough: true, euerKey: "NONE" });
    expect(s4).toMatchObject({ passThrough: true, euerKey: "NONE" });
  });

  test("VOU-011 a pass-through line needs no_input_vat on expenses and not_taxable on income", () => {
    expect(validateVoucher(draft(), ctx).errors).toEqual([]);
    expect(validateVoucher(draft({ taxRule: "input_vat_deductible" }), ctx).errors.map((e) => e.message)).toContain(
      MSG,
    );
    const refund = draft({ direction: "income", taxRule: "not_taxable", supplierName: "Mandant Müller" });
    expect(validateVoucher(refund, ctx).errors).toEqual([]);
    expect(validateVoucher({ ...refund, taxRule: "output_vat" }, ctx).errors.map((e) => e.code)).toContain(
      "pass_through_tax_rule",
    );
  });

  test("VOU-011 T06-064 a paid court fee on 1370 is not an EÜR expense; the same amount on an expense account is", () => {
    const KEYS = new Map(SKR04_ACCOUNTS.map((a) => [a.number, a.euerKey]));
    const entries = (account: string): EuerJournalEntry[] => [
      {
        id: "e1",
        seq: 1,
        date: "2026-03-10",
        source: { kind: "voucher", id: "v1" },
        text: "Beleg BE-2026-00001",
        recordedAt: 1,
        lines: [
          { account, debitCents: 45_000, creditCents: 0 },
          { account: "3300", role: "payable", debitCents: 0, creditCents: 45_000 },
        ],
      },
      {
        id: "e2",
        seq: 2,
        date: "2026-03-12",
        source: { kind: "payment", id: "p1" },
        text: "Zahlung",
        recordedAt: 2,
        lines: [
          { account: "3300", role: "payable", debitCents: 45_000, creditCents: 0 },
          { account: "1800", role: "bank.b1", debitCents: 0, creditCents: 45_000 },
        ],
      },
    ];
    const c = {
      euerKeyOf: (a: string) => KEYS.get(a) ?? ("NONE" as const),
      openItemAccounts: new Set(["1200", "3300"]),
      payments: { p1: { target: { kind: "voucher" as const, id: "v1" } } },
      openingItems: {},
      assets: {},
      tenDay: {},
      kuOn: () => false,
    };
    expect(cashBasisItems(entries("1370"), c).filter((i) => i.key.startsWith("BA."))).toEqual([]);
    expect(cashBasisItems(entries("6825"), c).reduce((s, i) => s + (i.key.startsWith("BA.") ? i.cents : 0), 0)).toBe(
      45_000,
    );
  });
});
