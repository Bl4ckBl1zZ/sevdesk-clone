import { describe, expect, test } from "vitest";
import type { SalesDocType } from "../documents/snapshot";
import { invoiceTypeCode, isCreditNote } from "./type-code";

describe("invoiceTypeCode (App. A.2)", () => {
  const table: [SalesDocType, "credit" | "rectification" | undefined, string | null, string | null][] = [
    ["invoice", undefined, "380", "380"],
    ["advance_invoice", undefined, "326", "875"],
    ["partial_invoice", undefined, "326", "875"],
    ["final_invoice", undefined, "380", "877"],
    ["cancellation", undefined, "381", "381"],
    ["correction", "credit", "381", "381"],
    ["correction", "rectification", "384", "384"],
    ["self_billing", undefined, "389", "389"],
    ["quote", undefined, null, null],
    ["order_confirmation", undefined, null, null],
    ["delivery_note", undefined, null, null],
    ["proforma", undefined, null, null],
    ["reminder", undefined, null, null],
  ];

  test("T-TAB-05 TypeCode per type and construction flag", () => {
    for (const [type, correctionKind, plain, construction] of table) {
      expect(invoiceTypeCode({ type, correctionKind }), type).toBe(plain);
      expect(invoiceTypeCode({ type, correctionKind, constructionWork: true }), `${type} construction`).toBe(
        construction,
      );
    }
  });

  test("T-TAB-05 only 381 uses credit-note semantics (UBL CreditNote, positive amounts)", () => {
    expect(isCreditNote("381")).toBe(true);
    for (const code of ["380", "384", "326", "875", "877", "389"] as const) expect(isCreditNote(code)).toBe(false);
  });
});
