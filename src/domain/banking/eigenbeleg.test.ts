import { describe, expect, test } from "vitest";
import { eigenbelegContent, markEigenbelegKind } from "./eigenbeleg";

const base = {
  date: "2026-10-15",
  amountCents: -100_000,
  currency: "EUR",
  company: { name: "Muster Consulting e.K." },
  reference: "6a1f0c2e-0009-4c3b-9d10-000000000009",
  createdOn: "2026-10-16",
  createdBy: "owner@example.test",
} as const;

describe("Eigenbeleg content (BNK-060, CSH-024/025, GOBD-07)", () => {
  test("T07-090 BNK-060 private withdrawal: title „Privatentnahme laut Kontoauszug“, amount, reference", () => {
    const c = eigenbelegContent({
      ...base,
      kind: markEigenbelegKind("private", -100_000, false),
      account: "Revolut EUR",
    });
    expect(c.title).toBe("Privatentnahme laut Kontoauszug");
    expect(c.rows).toContainEqual(["Betrag", "1.000,00 €"]);
    expect(c.rows).toContainEqual(["Referenz", base.reference]);
    expect(c.fileName).toBe("Eigenbeleg-2026-10-15-000000000009.pdf");
  });

  test("T07-090 EC-BNK-21 corporations: shareholder withdrawal/deposit with name and note", () => {
    expect(markEigenbelegKind("private", -1, true)).toBe("shareholder_withdrawal");
    expect(markEigenbelegKind("private", 1, true)).toBe("shareholder_deposit");
    const c = eigenbelegContent({
      ...base,
      kind: "shareholder_withdrawal",
      shareholder: { name: "Max Muster", note: "Entnahme Oktober" },
    });
    expect(c.rows).toContainEqual(["Gesellschafter", "Max Muster"]);
  });

  test("T07-095 T07-108 CSH-025/024 ATM and cash transfer vouchers name the fee and the late-recording reason", () => {
    expect(markEigenbelegKind("cash_withdrawal", -20_100, false)).toBe("atm_to_cash");
    const c = eigenbelegContent({ ...base, kind: "atm_to_cash", amountCents: -20_100, feeCents: 100 });
    expect(c.title).toBe("Bargeldabhebung in die Kasse");
    expect(c.rows).toContainEqual(["davon Bankgebühr", "1,00 €"]);
    const d = eigenbelegContent({
      ...base,
      kind: "cash_deposit_to_bank",
      amountCents: 15_000,
      backdateReason: "Nachtrag",
    });
    expect(d.rows).toContainEqual(["Grund der späten Erfassung", "Nachtrag"]);
  });
});
