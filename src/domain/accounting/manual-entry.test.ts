import { describe, expect, test } from "vitest";
import { buildManualLines, MANUAL_TEMPLATES, type ManualContext } from "./manual-entry";

const TYPES: Record<string, "expense" | "revenue" | "asset" | "liability" | "bank" | "neutral"> = {
  "1800": "bank",
  "6815": "expense",
  "4400": "revenue",
  "3806": "liability",
  "3150": "liability",
};
const ctx: ManualContext = {
  accountType: (a) => TYPES[a] ?? null,
  vatAccounts: new Set(["3806"]),
};

const base = { date: "2026-05-04", text: "Umbuchung", attachmentCount: 1 };

describe("ACC-011 manual journal entries", () => {
  test("ACC-011 E-ACC-01 unbalanced entries are refused with the difference", () => {
    const r = buildManualLines(
      {
        ...base,
        lines: [
          { account: "6815", debitCents: 10_000, creditCents: 0 },
          { account: "1800", debitCents: 0, creditCents: 9_950 },
        ],
      },
      ctx,
    );
    expect(!r.ok && r.error.code).toBe("E-ACC-01");
    expect(!r.ok && r.error.message).toBe("Soll und Haben sind nicht ausgeglichen (Differenz: 0,50 €).");
  });

  test("ACC-011 E-ACC-02 a manual entry needs an attachment (GoBD)", () => {
    const r = buildManualLines(
      {
        ...base,
        attachmentCount: 0,
        lines: [
          { account: "6815", debitCents: 100, creditCents: 0 },
          { account: "1800", debitCents: 0, creditCents: 100 },
        ],
      },
      ctx,
    );
    expect(!r.ok && r.error.code).toBe("E-ACC-02");
  });

  test("ACC-011 a line is either debit or credit and accounts must exist", () => {
    const both = buildManualLines(
      {
        ...base,
        lines: [
          { account: "6815", debitCents: 100, creditCents: 100 },
          { account: "1800", debitCents: 0, creditCents: 0 },
        ],
      },
      ctx,
    );
    expect(both.ok).toBe(false);
    const unknown = buildManualLines(
      {
        ...base,
        lines: [
          { account: "9999", debitCents: 100, creditCents: 0 },
          { account: "1800", debitCents: 0, creditCents: 100 },
        ],
      },
      ctx,
    );
    expect(!unknown.ok && unknown.error.message).toBe("Zeile 1: Konto 9999 ist nicht vorhanden.");
  });

  test("ACC-011 a gross line with a tax key splits net and VAT half-up and keeps the balance", () => {
    const r = buildManualLines(
      {
        ...base,
        lines: [
          { account: "6815", debitCents: 11_900, creditCents: 0, taxKey: "VSt19" },
          { account: "1800", debitCents: 0, creditCents: 11_900 },
        ],
      },
      ctx,
    );
    expect(r.ok && r.value.lines).toEqual([
      { account: "6815", debitCents: 10_000, creditCents: 0, taxKey: "VSt19" },
      { role: "vat.input.19", debitCents: 1_900, creditCents: 0, taxPointDate: "2026-05-04" },
      { account: "1800", debitCents: 0, creditCents: 11_900 },
    ]);
    const odd = buildManualLines(
      {
        ...base,
        lines: [
          { account: "4400", debitCents: 0, creditCents: 1_000, taxKey: "USt19" },
          { account: "1800", debitCents: 1_000, creditCents: 0 },
        ],
      },
      ctx,
    );
    // 1000 / 1.19 = 840.336 → 840 net, 160 VAT
    expect(odd.ok && odd.value.lines.slice(0, 2).map((l) => l.creditCents)).toEqual([840, 160]);
  });

  test("ACC-011 E-ACC-11 a tax key that does not fit the account type is refused", () => {
    const r = buildManualLines(
      {
        ...base,
        lines: [
          { account: "1800", debitCents: 100, creditCents: 0, taxKey: "USt19" },
          { account: "6815", debitCents: 0, creditCents: 100 },
        ],
      },
      ctx,
    );
    expect(!r.ok && r.error.code).toBe("E-ACC-11");
    expect(!r.ok && r.error.message).toBe("Steuerschlüssel USt19 ist für Konto 1800 nicht zulässig.");
  });

  test("ACC-011 E-ACC-10 a direct posting on a VAT account is a warning until acknowledged", () => {
    const input = {
      ...base,
      lines: [
        { account: "3806", debitCents: 100, creditCents: 0 },
        { account: "1800", debitCents: 0, creditCents: 100 },
      ],
    };
    const r = buildManualLines(input, ctx);
    expect(r.ok && r.value.warnings.map((w) => w.code)).toEqual(["E-ACC-10"]);
    const ack = buildManualLines(input, { ...ctx, acknowledged: ["E-ACC-10"] });
    expect(ack.ok && ack.value.warnings).toEqual([]);
  });

  test("ACC-011 templates name a role, the bank account or an account per chart on every line", () => {
    expect(MANUAL_TEMPLATES.map((t) => t.key)).toEqual(
      expect.arrayContaining(["loan_payout", "loan_repayment", "loan_interest", "transfer", "car_private_use"]),
    );
    for (const t of MANUAL_TEMPLATES) {
      expect(t.lines.some((l) => l.side === "debit") && t.lines.some((l) => l.side === "credit")).toBe(true);
      for (const l of t.lines) {
        const sources = [l.role, l.bank, l.accounts].filter((x) => x !== undefined).length;
        expect(sources).toBeLessThanOrEqual(1);
      }
    }
  });
});
