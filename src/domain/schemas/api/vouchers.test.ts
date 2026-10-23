import { describe, expect, test } from "vitest";
import {
  recurringVoucherArgs,
  recurringVoucherPatchWire,
  voucherDraftWire,
  voucherFinalizeArgs,
  voucherLaterPaymentWire,
  voucherPaymentArgs,
  wireToDraftInput,
} from "./vouchers";

/**
 * 05 §4.5 / F06 §7: one wire → Convex mapping for REST, the MCP voucher tools and the preview_action plan, so the
 * confirm token hashes byte-identical arguments. Optional wire fields appear only when set; unknown IDs are issues.
 */

const RAW = "k57f3x2m9q8w1e4r6t";
const RAW2 = "a1b2c3d4e5f6g7h8i9";

describe("voucher draft wire → Convex input (05 §4.5)", () => {
  test("VOU-001 VOU-002 every header and line field of a foreign-currency Bewirtung maps to the draft input", () => {
    const { input, issues } = wireToDraftInput(
      voucherDraftWire.parse({
        direction: "expense",
        kind: "bewirtung",
        supplier_contact_id: `con_${RAW}`,
        supplier_name: "Ristorante Roma",
        supplier_vat_id: "IT12345678901",
        supplier_tax_number: "",
        supplier_address: "Via Roma 1, Milano",
        supplier_iban: "IT60X0542811101000000123456",
        document_number: "F-2026-77",
        document_date: "2026-10-09",
        supply_date: { kind: "period", from: "2026-10-01", to: "2026-10-09" },
        due_date: "2026-10-23",
        currency: "CHF",
        fx_rate: { rate: "0.9412", source: "ecb_daily", date: "2026-10-09" },
        price_mode: "net",
        tax_rule: "no_input_vat",
        lines: [
          {
            account: "4650",
            description: "Geschäftsessen Kunde Muster",
            quantity_milli: 2_000,
            amount_cents: 8_000,
            vat_rate_bp: 0,
            vat_cents: 0,
            non_deductible_share_bp: 3_000,
            asset_decision: "none",
          },
        ],
        stated_gross_cents: 16_000,
        credit_note_of_id: `vou_${RAW2}`,
        internal_note: "Anlass: Projektabschluss",
      }),
    );
    expect(issues).toEqual([]);
    expect(input).toEqual({
      direction: "expense",
      kind: "bewirtung",
      supplierContactId: RAW,
      supplierName: "Ristorante Roma",
      supplierVatId: "IT12345678901",
      supplierTaxNumber: "",
      supplierAddress: "Via Roma 1, Milano",
      supplierIban: "IT60X0542811101000000123456",
      documentNumber: "F-2026-77",
      documentDate: "2026-10-09",
      supplyDate: { kind: "period", from: "2026-10-01", to: "2026-10-09" },
      dueDate: "2026-10-23",
      currency: "CHF",
      fxRateToEur: { rate: "0.9412", source: "ecb_daily", date: "2026-10-09" },
      priceMode: "net",
      taxRule: "no_input_vat",
      lines: [
        {
          account: "4650",
          description: "Geschäftsessen Kunde Muster",
          quantityMilli: 2_000,
          amountCents: 8_000,
          vatRateBp: 0,
          vatCents: 0,
          nonDeductibleShareBp: 3_000,
          assetDecision: "none",
        },
      ],
      statedTotals: { grossCents: 16_000 },
      creditNoteOfId: RAW2,
      internalNote: "Anlass: Projektabschluss",
    });
  });

  test("VOU-001 a tax payment carries its subtype and period; an empty body maps to an empty input", () => {
    expect(
      wireToDraftInput(
        voucherDraftWire.parse({ kind: "tax_payment", tax_payment: { subtype: "ust_prepayment", period: "2026-09" } }),
      ).input,
    ).toEqual({ kind: "tax_payment", taxPayment: { subtype: "ust_prepayment", period: "2026-09" } });
    expect(wireToDraftInput({})).toEqual({ input: {}, issues: [] });
  });

  test("API-011 a contact or credit-note ID with a foreign prefix becomes a wire issue and is not passed on", () => {
    const { input, issues } = wireToDraftInput({
      supplier_contact_id: `prd_${RAW}`,
      credit_note_of_id: `inv_${RAW}`,
    } as never);
    expect(issues).toEqual([
      { field: "supplier_contact_id", message: "Unbekannte Kontakt-ID." },
      { field: "credit_note_of_id", message: "Unbekannte Beleg-ID." },
    ]);
    expect(input).toEqual({});
  });
});

describe("voucher finalise and payment arguments (VOU-136, VOU-131)", () => {
  test("VOU-136 VOU-137 finalise arguments include version, acknowledged warnings and the payment fields only when set", () => {
    expect(voucherFinalizeArgs(RAW, {})).toEqual({ id: RAW });
    expect(voucherFinalizeArgs(RAW, { acknowledge_warnings: [], payment: { method: "bank" } })).toEqual({
      id: RAW,
      payment: { method: "bank" },
    });
    expect(
      voucherFinalizeArgs(RAW, {
        version: 3,
        acknowledge_warnings: ["cash_daily_recording"],
        payment: {
          method: "cash",
          date: "2026-10-01",
          amount_cents: 5_000,
          backdate_reason: "Kassenbuch nachgetragen",
          note: "Quittung",
        },
      }),
    ).toEqual({
      id: RAW,
      version: 3,
      acknowledgeWarnings: ["cash_daily_recording"],
      payment: {
        method: "cash",
        date: "2026-10-01",
        amountCents: 5_000,
        backdateReason: "Kassenbuch nachgetragen",
        note: "Quittung",
      },
    });
  });

  test("VOU-131 VOU-132 a later payment maps the bank transaction, differences with account and acknowledged warnings", () => {
    expect(voucherPaymentArgs(RAW, voucherLaterPaymentWire.parse({ method: "private" }))).toEqual({
      id: RAW,
      method: "private",
    });
    expect(
      voucherPaymentArgs(
        RAW,
        voucherLaterPaymentWire.parse({
          method: "bank",
          transaction_id: `btx_${RAW2}`,
          date: "2026-10-12",
          amount_cents: 11_662,
          backdate_reason: "Auszug verspätet",
          note: "mit Skonto",
          differences: [
            { reason: "skonto", amount_cents: 238 },
            { reason: "other", amount_cents: 10, account: "4970" },
          ],
          acknowledge_warnings: ["amount_mismatch"],
        }),
      ),
    ).toEqual({
      id: RAW,
      method: "bank",
      transactionId: RAW2,
      date: "2026-10-12",
      amountCents: 11_662,
      backdateReason: "Auszug verspätet",
      note: "mit Skonto",
      differences: [
        { reason: "skonto", amountCents: 238 },
        { reason: "other", amountCents: 10, account: "4970" },
      ],
      acknowledgeWarnings: ["amount_mismatch"],
    });
  });
});

describe("recurring voucher arguments (VOU-064)", () => {
  test("VOU-064 a template maps supplier, numbers, defaults and lines; an end date, mandate and IBAN are optional", () => {
    const wire = recurringVoucherPatchWire.parse({
      name: "Miete Büro",
      template: {
        supplier_contact_id: `con_${RAW}`,
        supplier_name: "Vermieter GmbH",
        supplier_vat_id: "DE123456788",
        document_number: "Mietvertrag 4711",
        tax_rule: "input_vat_deductible",
        lines: [{ account: "4210", amount_cents: 119_000, vat_rate_bp: 1_900 }],
        internal_note: "Lastschrift zum 3.",
      },
      interval: "P1M",
      first_date: "2026-11-03",
      end_date: "2027-10-03",
      create_as: "open",
      expected_mandate_ref: "MANDAT-1",
      expected_iban: "DE89370400440532013000",
      recurring_payment: true,
      active: true,
    });
    const { version: _v, ...input } = wire;
    expect(recurringVoucherArgs(input)).toEqual({
      issues: [],
      args: {
        name: "Miete Büro",
        template: {
          direction: "expense",
          kind: "standard",
          supplierContactId: RAW,
          supplierName: "Vermieter GmbH",
          supplierVatId: "DE123456788",
          documentNumber: "Mietvertrag 4711",
          currency: "EUR",
          priceMode: "gross",
          taxRule: "input_vat_deductible",
          lines: [{ account: "4210", amountCents: 119_000, vatRateBp: 1_900 }],
          internalNote: "Lastschrift zum 3.",
        },
        interval: "P1M",
        firstDate: "2026-11-03",
        endDate: "2027-10-03",
        createAs: "open",
        expectedMandateRef: "MANDAT-1",
        expectedIban: "DE89370400440532013000",
        recurringPayment: true,
        active: true,
      },
    });
    expect(recurringVoucherArgs({ active: false })).toEqual({ args: { active: false }, issues: [] });
  });

  test("API-011 a template contact ID with a foreign prefix is reported under template.supplier_contact_id", () => {
    const { args, issues } = recurringVoucherArgs({
      template: {
        direction: "expense",
        kind: "standard",
        supplier_contact_id: `prd_${RAW}`,
        currency: "EUR",
        price_mode: "gross",
        tax_rule: "input_vat_deductible",
        lines: [{ account: "4210", amount_cents: 100, vat_rate_bp: 1_900 }],
      },
    });
    expect(issues).toEqual([{ field: "template.supplier_contact_id", message: "Unbekannte Kontakt-ID." }]);
    expect((args.template as Record<string, unknown>).supplierContactId).toBeUndefined();
  });
});
