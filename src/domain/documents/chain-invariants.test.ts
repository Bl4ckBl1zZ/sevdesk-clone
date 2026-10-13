import { describe, expect, test } from "vitest";
import { type ChainInvariantRow, checkChains } from "./chain-invariants";

const S19 = (net: number) => ({
  category: "S" as const,
  rateBp: 1900,
  netCents: net,
  vatCents: Math.round(net * 0.19),
});
const S7 = (net: number) => ({ category: "S" as const, rateBp: 700, netCents: net, vatCents: Math.round(net * 0.07) });

const doc = (patch: Partial<ChainInvariantRow> & Pick<ChainInvariantRow, "id" | "type">): ChainInvariantRow => ({
  status: "finalized",
  number: patch.id.toUpperCase(),
  groups: [S19(10_000)],
  ...patch,
});

const ids = (rows: ChainInvariantRow[]) => checkChains(rows).map((f) => f.id);

describe("RI-06 Storno", () => {
  test("RI-06 a Storno mirrors its original, which is cancelled", () => {
    const rows = [
      doc({ id: "re1", type: "invoice", status: "cancelled" }),
      doc({ id: "st1", type: "cancellation", originalId: "re1", groups: [S19(-10_000)] }),
    ];
    expect(checkChains(rows)).toEqual([]);
  });

  test("RI-06 flags a missing original, a non-inverse total, an original not cancelled, two Stornos and a cancelled Storno", () => {
    expect(ids([doc({ id: "st1", type: "cancellation", groups: [S19(-10_000)] })])).toEqual(["RI-06"]);
    expect(
      ids([
        doc({ id: "re1", type: "invoice", status: "cancelled" }),
        doc({ id: "st1", type: "cancellation", originalId: "re1", groups: [S19(-9_000)] }),
      ]),
    ).toEqual(["RI-06"]);
    expect(
      ids([
        doc({ id: "re1", type: "invoice", status: "sent" }),
        doc({ id: "st1", type: "cancellation", originalId: "re1", groups: [S19(-10_000)] }),
      ]),
    ).toEqual(["RI-06"]);
    expect(
      ids([
        doc({ id: "re1", type: "invoice", status: "cancelled" }),
        doc({ id: "st1", type: "cancellation", originalId: "re1", groups: [S19(-10_000)] }),
        doc({ id: "st2", type: "cancellation", originalId: "re1", groups: [S19(-10_000)] }),
      ]),
    ).toContain("RI-06");
    expect(
      ids([
        doc({ id: "re1", type: "invoice", status: "cancelled" }),
        doc({ id: "st1", type: "cancellation", status: "cancelled", originalId: "re1", groups: [S19(-10_000)] }),
      ]),
    ).toEqual(["RI-06"]);
  });

  test("RI-06 a draft Storno is not checked", () => {
    expect(ids([doc({ id: "st1", type: "cancellation", status: "draft", groups: [] })])).toEqual([]);
  });
});

describe("RI-07 corrections", () => {
  test("RI-07 credits keep Σ(original + corrections) ≥ 0 per VAT group", () => {
    const rows = [
      doc({ id: "re1", type: "invoice", groups: [S19(10_000), S7(5_000)] }),
      doc({ id: "rk1", type: "correction", correctionKind: "credit", originalId: "re1", groups: [S19(-10_000)] }),
      doc({ id: "rk2", type: "correction", correctionKind: "credit", originalId: "re1", groups: [S7(-2_000)] }),
    ];
    expect(checkChains(rows)).toEqual([]);
  });

  test("RI-07 flags a correction without original and Σ below zero in one group", () => {
    expect(ids([doc({ id: "rk1", type: "correction", correctionKind: "credit", groups: [S19(-1)] })])).toEqual([
      "RI-07",
    ]);
    const rows = [
      doc({ id: "re1", type: "invoice", groups: [S19(10_000), S7(5_000)] }),
      doc({ id: "rk1", type: "correction", correctionKind: "credit", originalId: "re1", groups: [S7(-6_000)] }),
    ];
    expect(ids(rows)).toEqual(["RI-07"]);
  });

  test("RI-07 cancelled credits and rectifications do not count", () => {
    const rows = [
      doc({ id: "re1", type: "invoice" }),
      doc({ id: "rk1", type: "correction", correctionKind: "credit", originalId: "re1", groups: [S19(-10_000)] }),
      doc({
        id: "rk2",
        type: "correction",
        correctionKind: "credit",
        status: "cancelled",
        originalId: "re1",
        groups: [S19(-10_000)],
      }),
      doc({ id: "st2", type: "cancellation", originalId: "rk2", groups: [S19(10_000)] }),
      doc({ id: "rb1", type: "correction", correctionKind: "rectification", originalId: "re1" }),
    ];
    expect(checkChains(rows)).toEqual([]);
  });
});

describe("RI-08 final invoices", () => {
  const advance = (patch: Partial<ChainInvariantRow> = {}) =>
    doc({
      id: "ar1",
      type: "advance_invoice",
      chainRootId: "o1",
      groups: [S19(10_000)],
      deductedInId: "sr1",
      ...patch,
    });
  const final = (patch: Partial<ChainInvariantRow> = {}) =>
    doc({
      id: "sr1",
      type: "final_invoice",
      chainRootId: "o1",
      groups: [S19(30_000)],
      deductions: [{ advanceNumber: "AR1", byGroup: [S19(10_000)] }],
      ...patch,
    });

  test("RI-08 every active advance is deducted exactly with its received amount", () => {
    expect(checkChains([advance(), final()])).toEqual([]);
  });

  test("RI-08 a partially paid advance is deducted with invoiced + corrections", () => {
    const rows = [
      advance(),
      doc({ id: "rk1", type: "correction", correctionKind: "credit", originalId: "ar1", groups: [S19(-4_000)] }),
      final({ deductions: [{ advanceNumber: "AR1", byGroup: [S19(6_000)] }] }),
    ];
    expect(checkChains(rows)).toEqual([]);
  });

  test("RI-08 flags a missing deduction, a wrong amount, a stale deductedInId and a double deduction", () => {
    expect(ids([advance(), final({ deductions: [] })])).toContain("RI-08");
    expect(ids([advance(), final({ deductions: [{ advanceNumber: "AR1", byGroup: [S19(9_000)] }] })])).toEqual([
      "RI-08",
    ]);
    expect(ids([advance({ deductedInId: "gone" }), final()])).toContain("RI-08");
    expect(ids([advance(), final(), final({ id: "sr2" })])).toContain("RI-08");
  });

  test("RI-08 a cancelled final releases its advances; cancelled advances are not deducted", () => {
    expect(checkChains([advance({ deductedInId: undefined }), final({ status: "cancelled" })])).toEqual([]);
    expect(checkChains([advance({ status: "cancelled", deductedInId: undefined }), final({ deductions: [] })])).toEqual(
      [],
    );
  });
});
