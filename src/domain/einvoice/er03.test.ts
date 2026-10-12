import { describe, expect, test } from "vitest";
import { type Er03Input, er03RefDate, requiresERechnung } from "./er03";

const B2B_DE = { countryCode: "DE", isConsumer: false, isPublicAuthority: false } as const;

function input(over: Partial<Er03Input> & { turnover?: number | null; final?: boolean } = {}): Er03Input {
  const { turnover = 50_000_000, final = true, ...rest } = over;
  return {
    docType: "invoice",
    taxCase: "domestic",
    issuer: { isKleinunternehmer: false, priorYearTurnover: turnover === null ? null : { cents: turnover, final } },
    recipient: B2B_DE,
    refDate: "2028-03-10",
    grossEurCents: 119_000,
    ...rest,
  };
}

const cases: [id: string, over: Parameters<typeof input>[0], decision: string, rule?: string, warnings?: string[]][] = [
  ["ER03-01", { refDate: "2025-06-15", grossEurCents: 30_000 }, "PDF_NEEDS_CONSENT", "R8"],
  ["ER03-02", { refDate: "2026-12-31", turnover: 90_000_000 }, "PDF_NEEDS_CONSENT", "R8"],
  ["ER03-03", { refDate: "2027-01-01", turnover: 90_000_000 }, "MUST_E", "R10"],
  ["ER03-04", { refDate: "2027-06-30", turnover: 80_000_000 }, "PDF_NEEDS_CONSENT", "R9"],
  ["ER03-05", { refDate: "2027-06-30", turnover: 80_000_001 }, "MUST_E", "R10"],
  ["ER03-06", { refDate: "2027-03-01", turnover: null }, "MUST_E", "R10u", ["turnover_missing"]],
  [
    "ER03-07",
    {
      refDate: "2027-03-01",
      issuer: { isKleinunternehmer: false, priorYearTurnover: null, foundedOn: "2027-02-01" },
    },
    "PDF_NEEDS_CONSENT",
    "R9",
  ],
  ["ER03-08", { refDate: "2027-12-31", turnover: 50_000_000 }, "PDF_NEEDS_CONSENT", "R9"],
  ["ER03-09", { refDate: "2028-01-01" }, "MUST_E", "R11"],
  ["ER03-10", { grossEurCents: 25_000 }, "MAY_PAPER_OR_PDF", "R6"],
  ["ER03-11", { grossEurCents: 25_001 }, "MUST_E", "R11"],
  ["ER03-12", { taxCase: "reverse_charge_13b", grossEurCents: 20_000 }, "MUST_E", "R11"],
  ["ER03-13", { issuer: { isKleinunternehmer: true, priorYearTurnover: null } }, "MAY_PAPER_OR_PDF", "R5"],
  ["ER03-14", { recipient: { countryCode: "DE", isConsumer: true, isPublicAuthority: false } }, "NOT_REQUIRED", "R3"],
  ["ER03-15", { recipient: { ...B2B_DE, countryCode: "AT" }, taxCase: "eu_b2b_service" }, "NOT_REQUIRED", "R4"],
  ["ER03-16", { recipient: { ...B2B_DE, countryCode: "CH" }, taxCase: "export" }, "NOT_REQUIRED", "R4"],
  ["ER03-17", { grossEurCents: 1_190_000 }, "MUST_E", "R11"],
  ["ER03-18", { taxCase: "exempt_4", allExempt4Nr8to29: true, grossEurCents: 1_000_000 }, "MAY_PAPER_OR_PDF", "R7"],
  ["ER03-19", { refDate: "2026-05-01", recipient: { ...B2B_DE, isPublicAuthority: true } }, "MUST_E", "R2"],
  [
    "ER03-20",
    {
      issuer: { isKleinunternehmer: true, priorYearTurnover: null },
      recipient: { ...B2B_DE, isPublicAuthority: true },
    },
    "MUST_E",
    "R2",
  ],
  [
    "ER03-21",
    { docType: "cancellation", refDate: "2028-02-01", original: { hadXml: false, refDate: "2026-06-30" } },
    "PDF_NEEDS_CONSENT",
    "R8",
  ],
  ["ER03-22", { docType: "correction", original: { hadXml: true, refDate: "2026-06-30" } }, "MUST_E", "R1"],
  [
    "ER03-23",
    { docType: "correction", refDate: "2026-07-01", original: { hadXml: true, refDate: "2026-06-30" } },
    "MUST_E",
    "R1",
  ],
  ["ER03-24", { docType: "quote" }, "NOT_REQUIRED", "R0"],
  ["ER03-25", { docType: "advance_invoice", refDate: "2027-11-15", expectedSupplyEnd: "2028-03-31" }, "MUST_E", "R11"],
  ["ER03-33", { docType: "advance_invoice", refDate: "2027-11-15" }, "PDF_NEEDS_CONSENT", "R9"],
  ["ER03-26", { docType: "final_invoice", refDate: "2028-03-10" }, "MUST_E", "R11"],
  ["ER03-27", { refDate: "2028-01-31" }, "MUST_E", "R11"],
  ["ER03-28", { refDate: "2027-12-31" }, "PDF_NEEDS_CONSENT", "R9"],
  ["ER03-29", { grossEurCents: 22_159 }, "MAY_PAPER_OR_PDF", "R6"],
  [
    "ER03-30",
    { refDate: "2025-04-01", issuer: { isKleinunternehmer: true, priorYearTurnover: null } },
    "MAY_PAPER_OR_PDF",
    "R5",
  ],
  ["ER03-31", { refDate: "2027-05-01", turnover: 81_000_000, final: false }, "MUST_E", "R10", ["turnover_provisional"]],
  ["ER03-32", { recipient: { ...B2B_DE, countryCode: "AT" } }, "NOT_REQUIRED", "R4"],
];

describe("requiresERechnung (T-TAB-03)", () => {
  for (const [id, over, decision, rule, warnings] of cases) {
    test(`${id} → ${decision}${rule ? ` (${rule})` : ""}`, () => {
      const res = requiresERechnung(input(over));
      expect(res.decision).toBe(decision);
      if (rule) expect(res.ruleId).toBe(rule);
      expect(res.warnings).toEqual(warnings ?? []);
      expect(res.reason.length).toBeGreaterThan(10);
    });
  }

  test("INV-18 the delivery note, order confirmation, proforma and reminder are never e-invoices", () => {
    for (const docType of ["delivery_note", "order_confirmation", "proforma", "reminder"] as const) {
      expect(requiresERechnung(input({ docType })).ruleId).toBe("R0");
    }
  });

  test("INV-18 R9 with a provisional turnover below the limit warns turnover_provisional", () => {
    const res = requiresERechnung(input({ refDate: "2027-05-01", turnover: 10_000_000, final: false }));
    expect(res).toMatchObject({ decision: "PDF_NEEDS_CONSENT", warnings: ["turnover_provisional"] });
  });

  test("INV-18 a line-wise AE (§ 13b) excludes the Kleinbetrag rule", () => {
    expect(requiresERechnung(input({ hasAeLine: true, grossEurCents: 10_000 })).ruleId).toBe("R11");
  });

  test("INV-18 the advance invoice keeps the document-date decision if the expected supply is not stricter", () => {
    const res = requiresERechnung(
      input({ docType: "partial_invoice", refDate: "2028-01-10", expectedSupplyEnd: "2027-12-01" }),
    );
    expect(res.ruleId).toBe("R11");
  });
});

describe("er03RefDate (App. D.1)", () => {
  test("INV-18 supply end for invoices; document date for advance/partial invoices", () => {
    expect(
      er03RefDate({ docType: "invoice", documentDate: "2028-01-05", supplyDate: { kind: "date", date: "2027-12-31" } }),
    ).toBe("2027-12-31");
    expect(
      er03RefDate({
        docType: "invoice",
        documentDate: "2028-02-05",
        supplyDate: { kind: "period", from: "2027-12-01", to: "2028-01-31" },
      }),
    ).toBe("2028-01-31");
    expect(
      er03RefDate({ docType: "invoice", documentDate: "2028-01-05", supplyDate: { kind: "month", month: "2027-12" } }),
    ).toBe("2027-12-31");
    expect(er03RefDate({ docType: "invoice", documentDate: "2028-01-05" })).toBe("2028-01-05");
    expect(
      er03RefDate({
        docType: "advance_invoice",
        documentDate: "2027-11-15",
        supplyDate: { kind: "date", date: "2028-03-01" },
      }),
    ).toBe("2027-11-15");
  });
});
