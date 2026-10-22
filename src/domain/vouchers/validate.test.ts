import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import { type AccountContext, accountContextFor, allowedAccounts, checkLineAccount } from "./accounts";
import type { VoucherLine } from "./types";
import { unacknowledgedWarnings, type ValidationContext, type VoucherDraft, validateVoucher } from "./validate";

const d = (s: string) => s as CalendarDate;
const accounts = accountContextFor("SKR04", d("2026-03-10"), { bankLedgerAccounts: ["1810"] }) as AccountContext;
const ctx: ValidationContext = { today: d("2026-10-19"), companyIsKu: false, corporation: false, accounts };
const line = (over: Partial<VoucherLine> = {}): VoucherLine => ({
  account: "6815",
  description: "Druckerpapier",
  netCents: 10_000,
  vatRateBp: 1900,
  vatCents: 1900,
  grossCents: 11_900,
  ...over,
});
const draft = (over: Partial<VoucherDraft> = {}): VoucherDraft => ({
  direction: "expense",
  kind: "standard",
  taxRule: "input_vat_deductible",
  supplierName: "Büro Schmidt GmbH",
  supplierHasAddress: true,
  supplierVatId: "DE123456789",
  documentNumber: "RE-2026-0042",
  documentDate: "2026-03-10",
  currency: "EUR",
  lines: [line()],
  originalFiles: [{}],
  ...over,
});
const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);
const warningCodes = (r: { warnings: { code: string }[] }) => r.warnings.map((w) => w.code);

describe("validateVoucher — header and finalisation check (VOU-001, VOU-006)", () => {
  test("VOU-001 a complete expense voucher passes; totals and the supply end default to the document date", () => {
    const r = validateVoucher(draft(), ctx);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.totals).toMatchObject({ netCents: 10_000, vatCents: 1900, grossCents: 11_900 });
    expect(r.totalsEur.grossCents).toBe(11_900);
    expect(r.supplyEndDate).toBe("2026-03-10");
    expect(r.effectiveTaxRule).toBe("input_vat_deductible");
  });

  test("VOU-001 EC-VOU-02/08: missing date, supplier or lines and a future date block finalisation", () => {
    const msg = "Belegdatum, Lieferant und mindestens eine Position sind erforderlich.";
    expect(validateVoucher(draft({ documentDate: undefined }), ctx).errors[0]?.message).toBe(msg);
    expect(codes(validateVoucher(draft({ supplierName: " " }), ctx))).toContain("voucher_header_missing");
    expect(codes(validateVoucher(draft({ lines: [] }), ctx))).toContain("voucher_header_missing");
    expect(codes(validateVoucher(draft({ documentDate: "2026-10-20" }), ctx))).toContain("voucher_date_future");
    // A contact instead of a free-text name is enough.
    expect(validateVoucher(draft({ supplierName: undefined, supplierContactId: "c1" }), ctx).errors).toEqual([]);
  });

  test("VOU-006 EC-VOU-07 T06-055: > 250 € with input-VAT deduction and missing § 14 items → ⚑ warning, not blocking", () => {
    const big = line({ account: "6805", netCents: 30_000, vatCents: 5700, grossCents: 35_700 });
    const r = validateVoucher(draft({ supplierVatId: undefined, documentNumber: undefined, lines: [big] }), ctx);
    expect(r.errors).toEqual([]);
    expect(r.inputVatAtRisk).toEqual(["Steuernummer oder USt-IdNr des Lieferanten", "Rechnungsnummer"]);
    expect(r.warnings).toEqual([
      {
        code: "input_vat_at_risk",
        message:
          "Vorsteuerabzug gefährdet: Steuernummer oder USt-IdNr des Lieferanten, Rechnungsnummer fehlen auf der Rechnung (§ 14 Abs. 4 UStG).",
        acknowledge: true,
      },
    ]);
    expect(unacknowledgedWarnings(r, [])).toHaveLength(1);
    expect(unacknowledgedWarnings(r, ["input_vat_at_risk"])).toEqual([]);
  });

  test("VOU-006 VOU-005 T06-054: Kleinbetrag 23,80 € without supplier tax number → no warning", () => {
    const r = validateVoucher(
      draft({
        supplierVatId: undefined,
        documentNumber: undefined,
        lines: [line({ netCents: 2000, vatCents: 380, grossCents: 2380 })],
      }),
      ctx,
    );
    expect(r.inputVatAtRisk).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test("VOU-007 EC-VOU-01 RI-21: no original file and no Eigenbeleg → blocked; the bank line is the Beleg for bank fees", () => {
    expect(validateVoucher(draft({ originalFiles: [] }), ctx).errors[0]?.message).toBe(
      "Jede Buchung braucht einen Beleg. Bitte Datei hochladen oder einen Eigenbeleg erstellen.",
    );
    expect(
      codes(validateVoucher(draft({ originalFiles: [], statementIsBeleg: true, taxRule: "no_input_vat" }), ctx)),
    ).not.toContain("voucher_file_missing");
  });

  test("VOU-007 EC-VOU-35 a voucher with total 0 is blocked; strong duplicates block, probable ones are ⚑ warnings", () => {
    expect(
      codes(validateVoucher(draft({ lines: [line({ netCents: 0, vatCents: 0, grossCents: 0 })] }), ctx)),
    ).toContain("voucher_zero");
    const strong = validateVoucher(draft(), {
      ...ctx,
      duplicates: [{ id: "v9", level: "strong", reason: "identische Datei", label: "BE-2026-00009" }],
    });
    expect(strong.errors[0]).toMatchObject({
      code: "duplicate_strong",
      message:
        "Dieser Beleg ist vermutlich eine Dublette von BE-2026-00009. Bitte als Dublette markieren oder bestätigen, dass es keine ist.",
    });
    const probable = validateVoucher(draft(), {
      ...ctx,
      duplicates: [{ id: "v9", level: "probable", reason: "gleicher Lieferant und Betrag", label: "BE-2026-00009" }],
    });
    expect(probable.warnings).toEqual([
      {
        code: "duplicate_probable",
        message: "Mögliche Dublette von BE-2026-00009 (gleicher Lieferant und Betrag).",
        acknowledge: true,
      },
    ]);
  });

  test("VOU-003 EC-VOU-03 the stated Belegsumme must match the lines", () => {
    expect(codes(validateVoucher(draft({ statedTotals: { grossCents: 12_000 } }), ctx))).toContain("sum_mismatch");
  });
});

describe("validateVoucher — tax rules (VOU-010, VOU-020, VOU-021, VOU-026)", () => {
  test("VOU-020 input_vat_deductible keeps the rule for a regular taxpayer; VOU-026 KU replaces it by no_input_vat with an info", () => {
    expect(validateVoucher(draft(), ctx).effectiveTaxRule).toBe("input_vat_deductible");
    const ku = validateVoucher(draft(), { ...ctx, companyIsKu: true });
    expect(ku.effectiveTaxRule).toBe("no_input_vat");
    expect(ku.infos.map((i) => i.code)).toEqual(["ku_no_input_vat"]);
    expect(ku.inputVatAtRisk).toEqual([]); // no § 14 check without deduction
  });

  test("VOU-021 no_input_vat accepts foreign VAT (gross to expense) without rate errors", () => {
    const r = validateVoucher(
      draft({ taxRule: "no_input_vat", lines: [line({ vatRateBp: 2000, vatCents: 2000, grossCents: 12_000 })] }),
      ctx,
    );
    expect(r.errors).toEqual([]);
  });

  test("VOU-010 EC-VOU-15: income vouchers need an income rule; own-sales revenue accounts warn; KU must not show output VAT", () => {
    const income = (over: Partial<VoucherDraft> = {}) =>
      draft({
        direction: "income",
        taxRule: "not_taxable",
        supplierName: "Versicherung AG",
        lines: [line({ account: "7100", vatRateBp: 0, vatCents: 0, grossCents: 10_000 })],
        ...over,
      });
    expect(validateVoucher(income(), ctx).errors).toEqual([]);
    expect(validateVoucher(income(), ctx).warnings).toEqual([]);
    expect(codes(validateVoucher(income({ taxRule: "input_vat_deductible" }), ctx))).toContain(
      "voucher_rule_direction",
    );
    expect(codes(validateVoucher(draft({ taxRule: "output_vat" }), ctx))).toContain("voucher_rule_direction");
    const own = validateVoucher(
      income({ taxRule: "output_vat", lines: [line({ account: "4400", vatRateBp: 1900, vatCents: 1900 })] }),
      ctx,
    );
    expect(own.warnings[0]?.message).toBe(
      "Erlöse aus eigenen Leistungen bitte über eine Rechnung erfassen (fortlaufende Rechnungsnummer).",
    );
    expect(
      codes(
        validateVoucher(income({ taxRule: "output_vat", lines: [line({ account: "4400" })] }), {
          ...ctx,
          companyIsKu: true,
        }),
      ),
    ).toContain("ku_output_vat");
  });

  test("VOU-026 EC-EIG-01: an Eigenbeleg never deducts input VAT and needs approval", () => {
    const r = validateVoucher(draft({ kind: "eigenbeleg", originalFiles: [] }), ctx);
    expect(codes(r)).toEqual(expect.arrayContaining(["eigenbeleg_input_vat", "eigenbeleg_not_approved"]));
    const ok = validateVoucher(
      draft({
        kind: "eigenbeleg",
        taxRule: "no_input_vat",
        originalFiles: [],
        eigenbeleg: { reason: "not_obtainable", recipient: "Parkhaus", purpose: "Kundentermin", approvedAt: 1 },
        lines: [line({ account: "6673", vatRateBp: 0, vatCents: 0, netCents: 400, grossCents: 400 })],
      }),
      ctx,
    );
    expect(ok.errors).toEqual([]);
    expect(ok.effectiveTaxRule).toBe("no_input_vat");
  });

  test("VOU-061 EC-BEW-06 a Bewirtung voucher is blocked until the Bewirtungsbeleg is approved", () => {
    expect(codes(validateVoucher(draft({ kind: "bewirtung", lines: [line({ account: "6640" })] }), ctx))).toContain(
      "bewirtung_not_approved",
    );
  });

  test("CSH-023 EC-VOU-17 corporations have no Privatkonto — kind „private“ is blocked", () => {
    expect(
      codes(validateVoucher(draft({ kind: "private", taxRule: "no_input_vat" }), { ...ctx, corporation: true })),
    ).toContain("private_corporation");
  });
});

describe("line accounts (VOU-024, EC-VOU-37/38)", () => {
  test("VOU-024 T06-080: Einfuhrumsatzsteuer lines on the vat.import account (SKR04 1433) are allowed on expense vouchers", () => {
    const eust = line({ account: "1433", vatRateBp: 0, vatCents: 0, netCents: 19_000, grossCents: 19_000 });
    const r = validateVoucher(draft({ taxRule: "import_vat", supplierName: "Hauptzollamt", lines: [eust] }), ctx);
    expect(r.errors).toEqual([]);
    expect(
      warningCodes(validateVoucher(draft({ taxRule: "import_vat", documentNumber: undefined, lines: [eust] }), ctx)),
    ).toContain("import_vat_reference");
    expect(
      codes(validateVoucher(draft({ taxRule: "import_vat", lines: [eust] }), { ...ctx, companyIsKu: true })),
    ).toContain("import_vat_ku");
    // On an income voucher the EUSt account is not a line account.
    expect(checkLineAccount("1433", { direction: "income", taxRule: "not_taxable" }, accounts)?.code).toBe(
      "account_not_allowed",
    );
  });

  test("VOU-024 EC-VOU-37/38: VAT, receivable/payable accounts are not line accounts; cash, transit, private and bank accounts are reserved", () => {
    expect(checkLineAccount("1406", { direction: "expense", taxRule: "input_vat_deductible" }, accounts)?.message).toBe(
      "Das Konto 1406 ist für Ausgaben mit Steuerregel Vorsteuerabzug nicht zulässig.",
    );
    expect(checkLineAccount("3300", { direction: "expense", taxRule: "input_vat_deductible" }, accounts)?.code).toBe(
      "account_not_allowed",
    );
    for (const a of ["1600", "1460", "2100", "1810"]) {
      expect(checkLineAccount(a, { direction: "expense", taxRule: "no_input_vat" }, accounts)?.message).toBe(
        `Das Konto ${a} wird nur über Bankfunktionen gebucht (Privat/Geldtransit).`,
      );
    }
    expect(checkLineAccount("1370", { direction: "expense", taxRule: "no_input_vat" }, accounts)).toBeNull(); // VOU-011
    expect(checkLineAccount("0650", { direction: "expense", taxRule: "input_vat_deductible" }, accounts)).toBeNull();
    expect(checkLineAccount("4400", { direction: "expense", taxRule: "input_vat_deductible" }, accounts)?.code).toBe(
      "account_not_allowed",
    );
    const offered = allowedAccounts({ direction: "expense", taxRule: "input_vat_deductible" }, accounts).map(
      (a) => a.number,
    );
    expect(offered).toContain("6815");
    expect(offered).not.toContain("1600");
  });

  test("VOU-013 E-ACC-28 bank fees with input VAT need an attached invoice and a ⚑ acknowledgement", () => {
    const fee = line({ account: "6855", netCents: 500, vatCents: 95, grossCents: 595 });
    expect(codes(validateVoucher(draft({ lines: [fee], originalFiles: [], statementIsBeleg: true }), ctx))).toContain(
      "bank_fee_vat",
    );
    expect(warningCodes(validateVoucher(draft({ lines: [fee] }), ctx))).toContain("bank_fee_vat");
  });
});

describe("late vouchers (EC-162, EC-VOU-09)", () => {
  test("EC-162 EC-VOU-09 GOBD-06: a voucher dated in a locked period warns and names the open booking period", () => {
    const r = validateVoucher(draft(), { ...ctx, closedPeriods: new Set(["2026-03", "2026-04"]) });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      {
        code: "period_locked_late",
        message:
          "Der Zeitraum 03/2026 ist festgeschrieben. Der Beleg wird im Zeitraum 05/2026 gebucht. Die Vorsteuer gehört zur bereits übermittelten UStVA 03/2026 – im aktuellen Zeitraum geltend machen oder berichtigte Voranmeldung erstellen?",
        acknowledge: true,
      },
    ]);
  });
});
