/**
 * F06 §5.2/§5.3 edge cases at the domain level — one test per ID, asserting the exact German message of the spec
 * table (docs/spec/features/F06-purchases-inbox-einvoice.md).
 */
import { describe, expect, test } from "vitest";
import { formatEuro } from "../money";
import type { CalendarDate } from "../time/calendar-date";
import { type AccountContext, accountContextFor, checkLineAccount } from "./accounts";
import { checkAssetDecisions } from "./assets";
import { type BewirtungData, checkBewirtungApproval, checkBewirtungLines } from "./bewirtung";
import { checkReplacement } from "./capture";
import { checkEigenbelegApproval, eigenbelegVolumeInfo } from "./eigenbeleg";
import { checkLineVat } from "./lines";
import { checkPaymentChoice } from "./payment-choice";
import { checkTaxRule, checkVoucherRate, effectiveTaxRule } from "./tax-rules";
import type { VoucherLine } from "./types";
import { type ValidationContext, type VoucherDraft, validateVoucher } from "./validate";

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
const messages = (r: { errors: { message: string }[] }) => r.errors.map((e) => e.message);

describe("F06 §5.2 voucher validation edge cases", () => {
  test("EC-VOU-04 GOBD-03 a line VAT more than 1 cent away from net × rate blocks with the position and rate", () => {
    // ±1 cent is the supplier's rounding and is accepted (VOU-002).
    expect(checkLineVat({ netCents: 10_000, vatRateBp: 1900, vatCents: 1901 }, 1)).toBeNull();
    expect(checkLineVat({ netCents: 10_000, vatRateBp: 700, vatCents: 702 }, 2)?.message).toBe(
      "Der USt-Betrag in Position 2 passt nicht zum Steuersatz 7 %.",
    );
    const r = validateVoucher(draft({ lines: [line(), line({ vatCents: 1950, grossCents: 11_950 })] }), ctx);
    expect(messages(r)).toContain("Der USt-Betrag in Position 2 passt nicht zum Steuersatz 19 %.");
  });

  test("EC-VOU-05 UST-15 a non-German rate with input-VAT deduction is blocked with the hint to ‚Kein Vorsteuerabzug‘", () => {
    const r = validateVoucher(draft({ lines: [line({ vatRateBp: 2100, vatCents: 2100, grossCents: 12_100 })] }), ctx);
    expect(messages(r)).toContain(
      "21 % ist kein deutscher Steuersatz. Ausländische Umsatzsteuer ist nicht als Vorsteuer abziehbar – bitte ‚Kein Vorsteuerabzug‘ wählen.",
    );
    // The same line under no_input_vat is accepted (gross to expense).
    expect(checkVoucherRate(2100, "no_input_vat", d("2026-03-10"))).toBeNull();
  });

  test("EC-VOU-06 UST-15 RI-22 a German rate not valid on the supply date (16 % in 2026) is blocked", () => {
    const r = validateVoucher(draft({ lines: [line({ vatRateBp: 1600, vatCents: 1600, grossCents: 11_600 })] }), ctx);
    expect(messages(r)).toContain("Der Steuersatz 16 % galt am 10.03.2026 nicht.");
    // The supply date governs, not the document date: a 2020 supply with 16 % is fine.
    const late = validateVoucher(
      draft({
        supplyDate: { kind: "date", date: "2020-09-01" },
        lines: [line({ vatRateBp: 1600, vatCents: 1600, grossCents: 11_600 })],
      }),
      ctx,
    );
    expect(late.errors).toEqual([]);
  });

  test("EC-VOU-08 GOBD-03 a document date in the future blocks; today is accepted", () => {
    expect(messages(validateVoucher(draft({ documentDate: "2026-10-20" }), ctx))).toEqual([
      "Das Belegdatum darf nicht in der Zukunft liegen.",
    ]);
    expect(validateVoucher(draft({ documentDate: "2026-10-19" }), ctx).errors).toEqual([]);
  });

  test("EC-VOU-11 KU-01 a Kleinunternehmer choosing input_vat_deductible is switched to no_input_vat with an info", () => {
    expect(effectiveTaxRule("input_vat_deductible", true).rule).toBe("no_input_vat");
    const r = validateVoucher(draft(), { ...ctx, companyIsKu: true });
    expect(r.errors).toEqual([]);
    expect(r.effectiveTaxRule).toBe("no_input_vat");
    expect(r.infos).toEqual([
      {
        code: "ku_no_input_vat",
        message: "Als Kleinunternehmer sind Sie nicht zum Vorsteuerabzug berechtigt. Die USt wird als Aufwand gebucht.",
      },
    ]);
  });

  test("EC-VOU-14 UST-04 an intra-Community acquisition without the own USt-IdNr is blocked", () => {
    const ige = (ownVatId?: string) =>
      checkTaxRule({
        taxRule: "intra_community_acquisition",
        vatShownCents: 0,
        supplierVatId: "ATU12345678",
        ...(ownVatId ? { ownVatId } : {}),
      });
    expect(ige().errors.map((e) => e.message)).toEqual([
      "Für innergemeinschaftliche Erwerbe ist Ihre USt-IdNr erforderlich (Einstellungen › Unternehmen).",
    ]);
    expect(ige("DE123456789").errors).toEqual([]);
    const v = validateVoucher(
      draft({
        taxRule: "intra_community_acquisition",
        supplierVatId: "ATU12345678",
        lines: [line({ vatCents: 0, grossCents: 10_000, selfAssessedVatCents: 1900 })],
      }),
      ctx,
    );
    expect(messages(v)).toContain(
      "Für innergemeinschaftliche Erwerbe ist Ihre USt-IdNr erforderlich (Einstellungen › Unternehmen).",
    );
  });

  test("EC-VOU-17 AO-01 kind „private“ is blocked for a corporation and allowed for a sole proprietor", () => {
    const priv = draft({
      kind: "private",
      taxRule: "no_input_vat",
      lines: [line({ vatRateBp: 0, vatCents: 0, grossCents: 10_000 })],
    });
    expect(messages(validateVoucher(priv, { ...ctx, corporation: true }))).toContain(
      "Kapitalgesellschaften haben kein Privatkonto. Bitte Verrechnungskonto Gesellschafter verwenden.",
    );
    expect(validateVoucher(priv, ctx).errors.map((e) => e.code)).not.toContain("private_corporation");
  });

  test("EC-VOU-23 GOBD-08 replacing an original after finalisation needs a reason; drafts do not", () => {
    const files = [{}];
    expect(checkReplacement({ files, index: 0, booked: true, locked: false })).toMatchObject({
      ok: false,
      error: { code: "file_replace_reason", message: "Bitte angeben, warum die Datei ersetzt wird." },
    });
    expect(checkReplacement({ files, index: 0, booked: true, locked: false, reason: "  " }).ok).toBe(false);
    expect(checkReplacement({ files, index: 0, booked: true, locked: false, reason: "Scan unscharf" }).ok).toBe(true);
    expect(checkReplacement({ files, index: 0, booked: false, locked: false }).ok).toBe(true);
  });

  test("EC-VOU-25 GOBD-02 probable and possible duplicates are ⚑ warnings naming the other voucher and the reason", () => {
    const r = validateVoucher(draft(), {
      ...ctx,
      duplicates: [
        { id: "v7", level: "probable", reason: "gleicher Lieferant und Betrag", label: "BE-2026-00007" },
        { id: "v8", level: "possible", reason: "ähnlicher Name, gleicher Betrag", label: "BE-2026-00008" },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      {
        code: "duplicate_probable",
        message: "Mögliche Dublette von BE-2026-00007 (gleicher Lieferant und Betrag).",
        acknowledge: true,
      },
      {
        code: "duplicate_possible",
        message: "Mögliche Dublette von BE-2026-00008 (ähnlicher Name, gleicher Betrag).",
        acknowledge: true,
      },
    ]);
  });

  test("EC-VOU-27 UST-32 a supplier credit note without link to the original warns (not ⚑); with a link no warning", () => {
    const credit = line({ netCents: -5000, vatCents: -950, grossCents: -5950 });
    const unlinked = validateVoucher(draft({ lines: [credit] }), ctx);
    expect(unlinked.errors).toEqual([]);
    expect(unlinked.warnings).toEqual([
      {
        code: "credit_note_unlinked",
        message: "Gutschrift/Korrektur des Lieferanten ohne Bezug zum Originalbeleg.",
        acknowledge: false,
      },
    ]);
    expect(validateVoucher(draft({ lines: [credit], creditNoteOfId: "v1" }), ctx).warnings).toEqual([]);
  });

  test("EC-VOU-28 AO-03 a goods line above 250 € per item blocks booking until the asset decision is made", () => {
    // SKR04 6815 Bürobedarf (goods-type), 2 × 300 € net.
    const monitor = line({
      account: "6815",
      description: "Monitore",
      quantityMilli: 2000,
      netCents: 60_000,
      vatCents: 11_400,
      grossCents: 71_400,
    });
    expect(messages(validateVoucher(draft({ lines: [monitor] }), ctx))).toContain(
      "Bitte festlegen, ob Position 1 ein Anlagegut ist (GWG, Sammelposten, Anlage oder kein Anlagegut).",
    );
    expect(validateVoucher(draft({ lines: [{ ...monitor, assetDecision: "none" }] }), ctx).errors).toEqual([]);
  });

  test("EC-VOU-29 AO-03 GWG above the limit valid on the acquisition date is blocked", () => {
    const actx = { chart: "SKR04" as const, date: d("2026-03-10"), deductible: true };
    const tooBig = { account: "6815", netCents: 80_001, grossCents: 95_201, assetDecision: "gwg" as const };
    expect(checkAssetDecisions([tooBig], actx).map((i) => i.message)).toEqual([
      `Ein GWG darf höchstens ${formatEuro(80_000)} netto je Wirtschaftsgut kosten.`,
    ]);
    expect(checkAssetDecisions([{ ...tooBig, netCents: 80_000, grossCents: 95_200 }], actx)).toEqual([]);
  });

  test("EC-VOU-30 GOBD-07 an import VAT line without customs reference is a ⚑ warning", () => {
    const eust = line({ account: "1433", vatRateBp: 0, vatCents: 0, netCents: 19_000, grossCents: 19_000 });
    const r = validateVoucher(
      draft({ taxRule: "import_vat", supplierName: "Hauptzollamt", documentNumber: undefined, lines: [eust] }),
      ctx,
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toContainEqual({
      code: "import_vat_reference",
      message: "Einfuhrumsatzsteuer nur mit Einfuhrabgabenbescheid abziehbar. Bitte Bescheid hochladen.",
      acknowledge: true,
    });
    const withRef = validateVoucher(
      draft({ taxRule: "import_vat", supplierName: "Hauptzollamt", documentNumber: "ATB-2026-1", lines: [eust] }),
      ctx,
    );
    expect(withRef.warnings.map((w) => w.code)).not.toContain("import_vat_reference");
  });

  test("EC-VOU-38 accounts reserved for system postings (cash, Geldtransit, private, bank) are blocked on lines", () => {
    // SKR04: 1600 Kasse, 1460 Geldtransit, 2100 Privatentnahmen, 1810 a bank ledger account.
    for (const a of ["1600", "1460", "2100", "1810"]) {
      const r = validateVoucher(
        draft({
          taxRule: "no_input_vat",
          lines: [line({ account: a, vatRateBp: 0, vatCents: 0, grossCents: 10_000 })],
        }),
        ctx,
      );
      expect(messages(r)).toContain(`Das Konto ${a} wird nur über Bankfunktionen gebucht (Privat/Geldtransit).`);
      expect(checkLineAccount(a, { direction: "expense", taxRule: "no_input_vat" }, accounts)?.code).toBe(
        "account_reserved",
      );
    }
  });

  test("EC-VOU-44 GOBD-06 a cash or private payment dated in the future or in a locked period is blocked", () => {
    const base = {
      direction: "expense" as const,
      amountCents: 8000,
      openCents: 8000,
      today: d("2026-10-19"),
      closedPeriods: new Set(["2026-09"]),
      corporation: false,
    };
    const msg = "Das Zahlungsdatum darf nicht in der Zukunft oder in einem festgeschriebenen Zeitraum liegen.";
    for (const method of ["cash", "private"] as const) {
      expect(checkPaymentChoice({ ...base, method, date: "2026-10-20" })).toMatchObject({
        ok: false,
        error: { code: "payment_date_invalid", message: msg },
      });
      expect(
        checkPaymentChoice({ ...base, method, date: "2026-09-30", backdateReason: "Beleg lag im Auto" }),
      ).toMatchObject({ ok: false, error: { message: msg } });
      expect(checkPaymentChoice({ ...base, method, date: "2026-10-19" }).ok).toBe(true);
    }
  });
});

describe("F06 §5.3 Bewirtung and Eigenbeleg edge cases", () => {
  const meal = (over: Partial<BewirtungData> = {}): BewirtungData => ({
    occasionType: "geschaeftlich",
    occasion: "Projektbesprechung Website-Relaunch mit Müller GmbH",
    participants: ["Anna Müller"],
    host: "Max Mustermann",
    place: "Restaurant Lindenhof, Berlin",
    date: "2026-03-10",
    tseConfirmed: true,
    ...over,
  });

  test("EC-BEW-04 MISC-05 a missing TSE confirmation is a warning (not an error) with the deduction-at-risk text", () => {
    const r = checkBewirtungApproval(meal({ tseConfirmed: false }), 8000, d("2026-03-10"));
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toEqual([
      "Bewirtungsbelege müssen maschinell erstellt sein und TSE-Angaben enthalten. Ohne diese Angaben ist der Betriebsausgabenabzug gefährdet.",
    ]);
    expect(checkBewirtungApproval(meal(), 8000, d("2026-03-10")).warnings).toEqual([]);
  });

  test("EC-BEW-08 MISC-05 the tip must be its own 0 % line", () => {
    const msg = "Trinkgeld bitte als eigene Position ohne Umsatzsteuer erfassen.";
    const food = { description: "Speisen", vatRateBp: 700, grossCents: 10_700 };
    // Tip recorded, but folded into the food line → no 0 % line of that amount.
    expect(checkBewirtungLines([food], { tipCents: 1000 }, d("2026-03-10")).errors.map((e) => e.message)).toEqual([
      msg,
    ]);
    // Tip line with VAT.
    expect(
      checkBewirtungLines(
        [food, { description: "Trinkgeld", vatRateBp: 1900, grossCents: 1000 }],
        { tipCents: 1000 },
        d("2026-03-10"),
      ).errors.map((e) => e.message),
    ).toEqual([msg]);
    expect(
      checkBewirtungLines(
        [food, { description: "Trinkgeld", vatRateBp: 0, grossCents: 1000 }],
        { tipCents: 1000 },
        d("2026-03-10"),
      ).errors,
    ).toEqual([]);
  });

  test("EC-EIG-02 GOBD-07 recipient, purpose and reason (text for „other“) are required for the approval", () => {
    const msg = "Bitte Empfänger, Zweck und Grund für das Fehlen des Originalbelegs angeben.";
    expect(checkEigenbelegApproval({ reason: "lost", recipient: " ", purpose: "Parken" })?.message).toBe(msg);
    expect(checkEigenbelegApproval({ reason: "lost", recipient: "Stadt Berlin", purpose: "" })?.message).toBe(msg);
    expect(checkEigenbelegApproval({ reason: "other", recipient: "Stadt Berlin", purpose: "Parken" })?.message).toBe(
      msg,
    );
    expect(
      checkEigenbelegApproval({ reason: "other", reasonText: "Automat defekt", recipient: "Stadt", purpose: "Parken" }),
    ).toBeNull();
  });

  test("EC-EIG-03 GOBD-07 more than 5 Eigenbelege a month or more than 250 € gives an info on the voucher", () => {
    const msg = "Ungewöhnlich viele/hohe Eigenbelege – bitte nach Möglichkeit Originalbelege beschaffen.";
    expect(eigenbelegVolumeInfo({ countInMonth: 6, grossEurCents: 400 })?.message).toBe(msg);
    expect(eigenbelegVolumeInfo({ countInMonth: 1, grossEurCents: 25_001 })?.message).toBe(msg);
    expect(eigenbelegVolumeInfo({ countInMonth: 5, grossEurCents: 25_000 })).toBeNull();
    const eig = draft({
      kind: "eigenbeleg",
      taxRule: "no_input_vat",
      originalFiles: [],
      eigenbeleg: { reason: "not_obtainable", recipient: "Parkhaus", purpose: "Kundentermin", approvedAt: 1 },
      lines: [line({ account: "6673", vatRateBp: 0, vatCents: 0, netCents: 400, grossCents: 400 })],
    });
    const r = validateVoucher(eig, { ...ctx, eigenbelegCountInMonth: 6 });
    expect(r.errors).toEqual([]);
    expect(r.infos).toContainEqual({ code: "eigenbeleg_many", message: msg });
  });
});
