import { BUYERS, goodLine, makeContact, makeContext, makeDraft, serviceLine, TODAY } from "@test/factories/documents";
import { describe, expect, test } from "vitest";
import type { DocumentContext, DraftDocument } from "../draft";
import { validateDocument } from "./index";

const codes = (draft: DraftDocument, ctx: DocumentContext = makeContext(), opts = {}) =>
  validateDocument(draft, ctx, opts).findings.map((f) => f.code);
const errors = (draft: DraftDocument, ctx: DocumentContext = makeContext()) =>
  validateDocument(draft, ctx).findings.filter((f) => f.severity === "E");

const AT_CHECK = {
  id: "chk",
  vatId: "ATU12345675",
  provider: "eu_vies" as const,
  status: "valid" as const,
  checkedOn: TODAY,
};
const A = "A" as const;
const QUALIFIED_AT_CHECK = {
  ...AT_CHECK,
  provider: "bzst_evatr" as const,
  qualified: { name: A, street: A, postalCode: A, city: A },
};

const KU_COMPANY = {
  kleinunternehmer: [{ validFrom: "2025-01-01", isKU: true }],
  priorYearTurnover: [{ year: 2025, amountCents: 2_000_000 }],
};

type Case = [code: string, rule: string, draft: Partial<DraftDocument>, ctx?: Partial<DocumentContext>];

describe("validateDocument (F04 §5.1)", () => {
  test("DOC-20 T-TAB-06 the baseline fixture has no blocking findings", () => {
    expect(errors(makeDraft())).toEqual([]);
  });

  const CASES: Case[] = [
    ["contact_missing", "UST-03", {}, { contact: null }],
    ["buyer_name_missing", "UST-03", {}, { contact: makeContact({ buyer: { ...BUYERS.b2b, name: " " } }) }],
    [
      "buyer_address_incomplete",
      "UST-03",
      {},
      {
        contact: makeContact({
          buyer: { ...BUYERS.b2b, address: { street: "", postalCode: "50667", city: "Köln", countryCode: "DE" } },
        }),
      },
    ],
    ["setup_incomplete", "MAIL-03", {}, { setupComplete: false }],
    ["integrity_alert_open", "GOBD-06", {}, { integrityAlertOpen: true }],
    ["number_range_missing", "UST-06", {}, { numberRangeAvailable: false }],
    ["kleinbetrag_not_allowed", "UST-14", { kleinbetrag: true }],
    ["supply_date_missing", "UST-08", { supplyDate: undefined }],
    ["supply_period_invalid", "UST-08", { supplyDate: { kind: "period", from: "2026-10-09", to: "2026-10-01" } }],
    [
      "supply_date_in_future",
      "UST-08",
      { supplyDate: { kind: "date", date: "2026-10-20" }, documentDate: "2026-10-12" },
    ],
    [
      "supply_period_crosses_rate_change",
      "UST-15",
      {
        supplyDate: { kind: "period", from: "2025-12-15", to: "2026-01-15" },
        documentDate: "2026-10-12",
        backdateReason: "x",
        lines: [serviceLine({ vatRateKey: "restaurant_food" })],
      },
    ],
    ["document_date_future", "UST-05", { documentDate: "2026-10-13" }],
    [
      "backdate_reason_required",
      "UST-05",
      { documentDate: "2026-09-30", supplyDate: { kind: "date", date: "2026-09-29" } },
    ],
    ["no_items", "UST-07", { lines: [] }],
    ["line_name_missing", "UST-07", { lines: [serviceLine({ name: "" })] }],
    ["line_quantity_invalid", "UST-07", { lines: [serviceLine({ quantityMilli: 0 })] }],
    ["line_unit_missing", "UST-07", { lines: [serviceLine({ unitCode: undefined })] }],
    ["line_unit_invalid", "UST-07", { lines: [serviceLine({ unitCode: "XYZ" })] }],
    ["line_price_missing", "UST-09", { lines: [serviceLine({ unitPriceMicros: undefined })] }],
    [
      "line_discount_exceeds",
      "UST-09",
      { lines: [serviceLine({ discount: { kind: "amount", amountCents: 999_999 } })] },
    ],
    ["total_negative", "UST-30", { lines: [serviceLine({ quantityMilli: -1000 })] }],
    ["skonto_invalid", "UST-09", { paymentTerms: { dueDays: 14, skontoPercentBp: 200, skontoDays: 14 } }],
    ["bank_account_missing", "ER-10", {}, { bankAccount: undefined }],
    ["iban_invalid", "ER-10", {}, { bankAccount: { iban: "DE00370400440532013000", accountHolder: "X" } }],
    ["tax_case_override_reason", "UST-10", { taxCaseOverride: { taxCase: "export", reason: "kurz" } }],
    ["category_not_allowed", "UST-10", { lines: [serviceLine({ vatCategoryOverride: "K" })] }],
    ["exemption_reason_missing", "UST-10", { lines: [serviceLine({ vatRateKey: "exempt" })] }],
    [
      "buyer_vat_id_missing",
      "UST-20",
      {},
      {
        contact: makeContact({
          countryCode: "AT",
          buyer: BUYERS.at,
          vatId: undefined,
          defaultTaxCase: "eu_b2b_service",
        }),
      },
    ],
    ["buyer_vat_id_domestic", "UST-20", {}, { contact: makeContact({ defaultTaxCase: "eu_b2b_service" }) }],
    [
      "buyer_vat_id_not_verified",
      "MISC-04",
      {},
      {
        contact: makeContact({
          countryCode: "AT",
          buyer: BUYERS.at,
          vatId: "ATU12345675",
          vatIdStatus: { status: "valid", qualified: false },
        }),
      },
    ],
    [
      "igl_delivery_country_invalid",
      "UST-21",
      {
        lines: [goodLine()],
        deliveryAddress: {
          name: "Lager",
          street: "Hafenstraße 1",
          postalCode: "20457",
          city: "Hamburg",
          countryCode: "DE",
        },
      },
      {
        contact: makeContact({
          countryCode: "AT",
          buyer: BUYERS.at,
          vatId: "ATU12345675",
          defaultTaxCase: "intra_community_supply",
          vatChecks: [QUALIFIED_AT_CHECK],
        }),
      },
    ],
    [
      "export_delivery_country_invalid",
      "UST-23",
      { taxCaseOverride: { taxCase: "export", reason: "Ausfuhr laut Auftrag" } },
    ],
    [
      "rc13b_consumer",
      "UST-22",
      { lines: [serviceLine({ reverseCharge13b: "construction", vatCategoryOverride: "AE" })] },
      { contact: makeContact({ isConsumer: true, buyer: BUYERS.consumer }) },
    ],
    [
      "rc_buyer_id_missing_xml",
      "UST-22",
      { lines: [serviceLine({ reverseCharge13b: "construction" })] },
      {
        contact: makeContact({
          buyer: { ...BUYERS.construction, registerNumber: undefined } as never,
          vatId: undefined,
        }),
      },
    ],
    ["category_o_mixed", "UST-23", { lines: [serviceLine(), serviceLine({ vatCategoryOverride: "O" })] }],
    ["ku_vat_not_allowed", "KU-03", { lines: [serviceLine({ vatCategoryOverride: "S" })] }, {}],
    ["currency_unsupported", "MISC-08", { currency: "XAU" }],
    ["fx_rate_missing", "MISC-08", { currency: "USD" }],
    [
      "einvoice_required",
      "ER-03",
      { einvoiceFormat: "none", supplyDate: { kind: "date", date: "2026-10-09" } },
      {
        company: { ...makeContext().company },
        contact: makeContact({
          isPublicAuthority: true,
          buyer: BUYERS.public,
          buyerReference: "04011000-1234512345-06",
        }),
      },
    ],
    ["leitweg_id_missing", "ER-20", {}, { contact: makeContact({ isPublicAuthority: true, buyer: BUYERS.public }) }],
    [
      "leitweg_id_checksum",
      "ER-20",
      { buyerReference: "04011000-1234512345-07" },
      { contact: makeContact({ isPublicAuthority: true, buyer: BUYERS.public }) },
    ],
    [
      "seller_electronic_address_missing",
      "ER-10",
      { einvoiceFormat: "xrechnung_cii" },
      {
        company: {
          ...makeContext().company,
          seller: { ...makeContext().company.seller, electronicAddress: undefined },
        },
      },
    ],
    [
      "buyer_electronic_address_missing",
      "ER-10",
      { einvoiceFormat: "xrechnung_cii" },
      { contact: makeContact({ buyer: { ...BUYERS.b2b, invoiceEmail: undefined } }) },
    ],
  ];

  test.each(CASES)(
    "DOC-20 T-TAB-06 %s (%s) is reported, and absent on the valid baseline",
    (code, _rule, draftPatch, ctxPatch) => {
      let ctx = makeContext(ctxPatch ?? {});
      if (code === "ku_vat_not_allowed") ctx = makeContext({}, KU_COMPANY);
      expect(codes(makeDraft(draftPatch), ctx)).toContain(code);
      expect(codes(makeDraft())).not.toContain(code);
    },
  );

  test.each([
    ["generic_description", { lines: [serviceLine({ name: "Diverses" })] }],
    [
      "negative_line",
      {
        lines: [
          serviceLine(),
          serviceLine({ name: "Gutschrift Altgerät", quantityMilli: -1000, unitPriceMicros: 100_000 }),
        ],
      },
    ],
    [
      "backdate_over_6_months",
      {
        documentDate: "2026-03-01",
        backdateReason: "Nachträglich erstellt",
        supplyDate: { kind: "date", date: "2026-02-27" },
      },
    ],
    ["supply_older_than_6_months", { supplyDate: { kind: "date", date: "2026-03-01" } }],
    ["payment_terms_long_b2b", { paymentTerms: { dueDays: 90 } }],
    ["consumer_net_prices", {}],
    [
      "fx_rate_source_daily",
      { currency: "USD", fxRateToEur: { rate: "1.0831", source: "ecb_daily", date: "2026-10-09" } },
    ],
  ] as const)("DOC-20 T-TAB-06 warning %s never blocks", (code, patch) => {
    const ctx =
      code === "consumer_net_prices"
        ? makeContext({ contact: makeContact({ isConsumer: true, buyer: BUYERS.consumer, vatId: undefined }) })
        : makeContext();
    const fs = validateDocument(makeDraft(patch as Partial<DraftDocument>), ctx).findings;
    const f = fs.find((x) => x.code === code);
    expect(f?.severity, code).toBe("W");
    expect(codes(makeDraft())).not.toContain(code);
  });

  test("DOC-44 UST-14 T-DOC-029 a Kleinbetrag invoice of 249,99 € without buyer address is valid", () => {
    const draft = makeDraft({
      kleinbetrag: true,
      priceMode: "gross",
      lines: [
        serviceLine({
          name: "Fachbuch Steuerrecht",
          quantityMilli: 1000,
          unitPriceMicros: 2_499_900,
          vatRateKey: "reduced",
        }),
      ],
    });
    const ctx = makeContext({
      contact: makeContact({
        buyer: { name: "Barverkauf", isConsumer: true, isPublicAuthority: false },
        isConsumer: true,
        vatId: undefined,
      }),
    });
    const r = validateDocument(draft, ctx);
    expect(r.resolved.totals?.grossCents).toBe(24_999);
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
    const over = makeDraft({
      kleinbetrag: true,
      priceMode: "gross",
      lines: [serviceLine({ quantityMilli: 1000, unitPriceMicros: 2_500_100 })],
    });
    expect(codes(over, ctx)).toContain("kleinbetrag_not_allowed");
  });

  test("INV-24 KU-03 a Kleinunternehmer invoice uses category KU only; S lines are rejected", () => {
    const ctx = makeContext({}, KU_COMPANY);
    const r = validateDocument(makeDraft(), ctx);
    expect(r.resolved.taxCase).toBe("kleinunternehmer");
    expect(r.resolved.lines.map((l) => [l.vatCategory, l.vatRateBp])).toEqual([["KU", 0]]);
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(r.einvoice.er03.decision).toBe("MAY_PAPER_OR_PDF");
    expect(r.einvoice.format).toBe("none");
  });

  test("KU-01 the invoice that crosses 100.000 € is blocked with ku_threshold_crossed; 80 % warns", () => {
    const company = {
      kleinunternehmer: [{ validFrom: "2025-01-01", isKU: true }],
      priorYearTurnover: [{ year: 2025, amountCents: 2_000_000 }],
    };
    const big = makeContext({ kuYearTurnoverCents: 9_995_000 }, company);
    expect(codes(makeDraft(), big)).toContain("ku_threshold_crossed");
    const warn = makeContext({ kuYearTurnoverCents: 8_000_000 }, company);
    expect(codes(makeDraft(), warn)).toContain("ku_threshold_80");
    const outdated = makeContext({}, { ...company, priorYearTurnover: [{ year: 2025, amountCents: 2_600_000 }] });
    expect(codes(makeDraft(), outdated)).toContain("ku_status_outdated");
  });

  test("UST-22 INV-29 §13b: a construction line for a German business is AE with the certificate warning", () => {
    const ctx = makeContext({ contact: makeContact({ buyer: BUYERS.construction, vatId: undefined }) });
    const r = validateDocument(
      makeDraft({ lines: [serviceLine({ name: "Elektroinstallation Neubau", reverseCharge13b: "construction" })] }),
      ctx,
    );
    expect(r.resolved.taxCase).toBe("reverse_charge_13b");
    expect(r.resolved.lines[0]?.vatCategory).toBe("AE");
    expect(r.findings.find((f) => f.code === "rc13b_certificate_missing")?.severity).toBe("W");
    expect(r.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(
      codes(makeDraft({ lines: [serviceLine({ reverseCharge13b: "construction" })] }), ctx, { rc13bConfirmed: true }),
    ).not.toContain("rc13b_certificate_missing");
  });

  test("MISC-04 EC-044 an unverifiable EU VAT ID can be released with an audited override", () => {
    const ctx = makeContext({
      contact: makeContact({
        countryCode: "AT",
        buyer: BUYERS.at,
        vatId: "ATU12345675",
        vatIdStatus: { status: "valid", qualified: false },
      }),
    });
    const r = validateDocument(makeDraft(), ctx);
    const f = r.findings.find((x) => x.code === "buyer_vat_id_not_verified");
    expect(f?.overridable).toBe(true);
    expect(codes(makeDraft(), ctx, { vatCheckOverride: true })).not.toContain("buyer_vat_id_not_verified");
    const checked = makeContext({
      contact: makeContact({
        countryCode: "AT",
        buyer: BUYERS.at,
        vatId: "ATU12345675",
        vatIdStatus: { status: "valid", qualified: false },
        vatChecks: [AT_CHECK],
      }),
    });
    const ok = validateDocument(makeDraft(), checked);
    expect(ok.resolved.taxCase).toBe("eu_b2b_service");
    expect(ok.findings.filter((x) => x.severity === "E")).toEqual([]);
  });

  test("ER-20 INV-22 a public authority needs a valid Leitweg-ID and defaults to XRechnung UBL (MUST_E)", () => {
    const ctx = makeContext({
      contact: makeContact({ isPublicAuthority: true, buyer: BUYERS.public, buyerReference: "04011000-1234512345-06" }),
    });
    const r = validateDocument(makeDraft(), ctx);
    expect(r.einvoice.er03.decision).toBe("MUST_E");
    expect(r.einvoice.format).toBe("xrechnung_ubl");
    expect(r.findings.filter((x) => x.severity === "E")).toEqual([]);
  });

  test("DOC-13 T-DOC-009 catering food moves 19 → 7 % across 2026-01-01 and reports rate_changed_notice", () => {
    const line = serviceLine({
      name: "Catering Mittagessen",
      vatRateKey: "restaurant_food",
      vatCategory: "S",
      vatRateBp: 1900,
    });
    const r = validateDocument(
      makeDraft({ supplyDate: { kind: "date", date: "2026-01-01" }, documentDate: "2026-10-12", lines: [line] }),
      makeContext(),
    );
    expect(r.resolved.lines[0]).toMatchObject({
      vatCategory: "S",
      vatRateBp: 700,
      vatRuleRowId: "restaurant_food@2026-01-01",
    });
    expect(r.findings.find((f) => f.code === "rate_changed_notice")?.message).toBe(
      "Steuersatz geändert: 19 % → 7 % (Leistungsdatum 01.01.2026).",
    );
    const before = validateDocument(
      makeDraft({ supplyDate: { kind: "date", date: "2025-12-31" }, lines: [line] }),
      makeContext(),
    );
    expect(before.resolved.lines[0]?.vatRateBp).toBe(1900);
  });

  test("UST-05 EC-022 a document dated in a locked period is blocked", () => {
    const ctx = makeContext({ lockedThrough: "2026-09-30" });
    expect(
      codes(
        makeDraft({
          documentDate: "2026-09-30",
          backdateReason: "Nachtrag September",
          supplyDate: { kind: "date", date: "2026-09-30" },
        }),
        ctx,
      ),
    ).toContain("backdate_period_locked");
  });

  test("UST-34 DOC-43 possible_duplicate warns for the same contact, gross and supply date within 30 days", () => {
    const ctx = makeContext({
      recentInvoices: [
        { number: "RE-2026-0040", documentDate: "2026-10-10", grossCents: 113_050, supplyEnd: "2026-10-09" },
      ],
    });
    expect(codes(makeDraft(), ctx)).toContain("possible_duplicate");
  });
});
