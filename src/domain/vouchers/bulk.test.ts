import { describe, expect, test } from "vitest";
import { applyBulkPatch, BULK_VOUCHER_MAX, bulkFinalizeSkipReason, checkBulkSelection } from "./bulk";

describe("bulk actions on drafts (VOU-101)", () => {
  test("VOU-101 account and cost centre are set on every line; other line data stays; tags are added once", () => {
    const lines = [
      { account: "6815", amountCents: 1000, vatRateBp: 1900, costCenterId: "k1" },
      { account: "6805", amountCents: 500, vatRateBp: 700 },
    ];
    expect(applyBulkPatch({ lines, tags: ["t1"] }, { account: "6830", costCenterId: "k2", addTagIds: ["t1", "t2"] })).toEqual({
      lines: [
        { account: "6830", amountCents: 1000, vatRateBp: 1900, costCenterId: "k2" },
        { account: "6830", amountCents: 500, vatRateBp: 700, costCenterId: "k2" },
      ],
      tags: ["t1", "t2"],
    });
    // costCenterId null removes the cost centre; nothing else given → lines unchanged.
    expect(applyBulkPatch({ lines, tags: [] }, { costCenterId: null }).lines).toEqual([
      { account: "6815", amountCents: 1000, vatRateBp: 1900 },
      { account: "6805", amountCents: 500, vatRateBp: 700 },
    ]);
  });

  test("VOU-101 T06-131 bulk finalise skips drafts with blocking errors or unacknowledged ⚑ warnings, with the reason", () => {
    expect(bulkFinalizeSkipReason({ errors: [], warnings: [{ code: "x", message: "Info", acknowledge: false }] })).toBeNull();
    expect(
      bulkFinalizeSkipReason({
        errors: [{ code: "voucher_file_missing", message: "Jede Buchung braucht einen Beleg." }],
        warnings: [],
      }),
    ).toBe("Jede Buchung braucht einen Beleg.");
    expect(
      bulkFinalizeSkipReason({
        errors: [],
        warnings: [{ code: "input_vat_at_risk", message: "Vorsteuerabzug gefährdet: …", acknowledge: true }],
      }),
    ).toBe("Bitte einzeln prüfen und bestätigen: Vorsteuerabzug gefährdet: …");
  });

  test("VOU-101 the selection must be 1 … BULK_VOUCHER_MAX distinct drafts", () => {
    expect(checkBulkSelection(["a", "a", "b"])).toEqual({ ok: true, value: ["a", "b"] });
    expect(checkBulkSelection([])).toMatchObject({ ok: false, error: { message: "Bitte mindestens einen Beleg auswählen." } });
    expect(checkBulkSelection(Array.from({ length: BULK_VOUCHER_MAX + 1 }, (_, i) => `v${i}`)).ok).toBe(false);
  });
});
