import { describe, expect, test } from "vitest";
import { checkVoucherBelege, type VoucherInvariantRow } from "./invariants";

const row = (over: Partial<VoucherInvariantRow> = {}): VoucherInvariantRow => ({
  id: "v1",
  label: "BE-2026-00001",
  status: "open",
  kind: "standard",
  files: [{ sha256: "a".repeat(64) }],
  eigenbelegApproved: false,
  recurringReference: false,
  ...over,
});

describe("RI-21 booked vouchers have a Beleg", () => {
  test("RI-21 GOBD-07 a booked voucher without an active original, Eigenbeleg or reference document is an ERROR", () => {
    expect(checkVoucherBelege([row()])).toEqual([]);
    expect(checkVoucherBelege([row({ status: "draft", files: [] })])).toEqual([]);
    expect(checkVoucherBelege([row({ files: [] })])).toEqual([
      { id: "RI-21", severity: "ERROR", message: "Beleg BE-2026-00001 ist gebucht, hat aber keine Belegdatei." },
    ]);
    expect(checkVoucherBelege([row({ files: [{ sha256: "a".repeat(64), replacedBy: 1 }] })])).toHaveLength(1);
    expect(checkVoucherBelege([row({ kind: "eigenbeleg", files: [], eigenbelegApproved: true })])).toEqual([]);
    expect(checkVoucherBelege([row({ files: [], recurringReference: true })])).toEqual([]);
  });

  test("RI-21 GOBD-08 every recorded original carries a SHA-256", () => {
    expect(checkVoucherBelege([row({ files: [{ sha256: "abc" }] })])[0]?.message).toBe(
      "Beleg BE-2026-00001: Datei 1 hat keinen gültigen SHA-256.",
    );
  });
});
