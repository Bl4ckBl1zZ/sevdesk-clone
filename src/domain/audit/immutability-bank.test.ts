import { describe, expect, test } from "vitest";
import { assertMutable, ImmutableRecordError } from "./immutability";

const tx = {
  _id: "t1",
  accountId: "a1",
  bookingDate: "2026-10-02",
  amountCents: 119_000,
  currency: "EUR",
  purpose: "RE-2026-0042",
  status: "open",
  allocatedCents: 0,
  sources: [{ kind: "camt053", rawSha256: "x", at: 1 }],
};

const patch = (p: Record<string, unknown>) => () => assertMutable("bankTransactions", tx, { op: "patch", patch: p });

describe("booked bank transactions are immutable (BNK-122, GOBD-06)", () => {
  test("T07-030 BNK-122 amount, date, purpose and currency can never change; delete is refused", () => {
    expect(patch({ amountCents: 1 })).toThrow(ImmutableRecordError);
    expect(patch({ bookingDate: "2026-10-03" })).toThrow(ImmutableRecordError);
    expect(patch({ purpose: "x" })).toThrow(ImmutableRecordError);
    expect(() => assertMutable("bankTransactions", tx, { op: "delete" })).toThrow(ImmutableRecordError);
  });

  test("T07-030 BNK-122 status, allocation and marking state may change; sources only grow", () => {
    expect(patch({ status: "private", allocatedCents: 0 })).not.toThrow();
    expect(patch({ sources: [...tx.sources, { kind: "revolut_csv", rawSha256: "y", at: 2 }] })).not.toThrow();
    expect(patch({ sources: [{ kind: "revolut_csv", rawSha256: "y", at: 2 }] })).toThrow(ImmutableRecordError);
    expect(patch({ sources: [] })).toThrow(ImmutableRecordError);
  });

  test("BNK-031 BNK-121 counterparty fields fill once; the reversal link is set once", () => {
    expect(patch({ counterpartyName: "Mueller GmbH" })).not.toThrow();
    const filled = { ...tx, counterpartyName: "Mueller GmbH", reversalOfId: "t0" };
    expect(() => assertMutable("bankTransactions", filled, { op: "patch", patch: { counterpartyName: "X" } })).toThrow(
      ImmutableRecordError,
    );
    expect(() => assertMutable("bankTransactions", filled, { op: "patch", patch: { reversalOfId: "t9" } })).toThrow(
      ImmutableRecordError,
    );
  });

  test("T07-043 GOBD-20 the archived statement keeps its files and balances; the signed PDF can be attached once", () => {
    const st = { _id: "s1", accountId: "a1", closingBalanceCents: 1, reconciled: true };
    const p =
      (x: Record<string, unknown>, before: Record<string, unknown> = st) =>
      () =>
        assertMutable("bankStatements", before, { op: "patch", patch: x });
    expect(p({ closingBalanceCents: 2 })).toThrow(ImmutableRecordError);
    expect(p({ reconciled: false })).toThrow(ImmutableRecordError);
    expect(p({ pdf: { sha256: "a" } })).not.toThrow();
    expect(p({ pdf: { sha256: "b" } }, { ...st, pdf: { sha256: "a" } })).toThrow(ImmutableRecordError);
  });
});
