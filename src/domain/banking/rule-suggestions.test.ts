import { describe, expect, test } from "vitest";
import { type ClassifiedTx, RULE_SUGGESTION_MIN, suggestRules } from "./rule-suggestions";
import type { MatchingRule } from "./rules";

const tx = (id: string, over: Partial<ClassifiedTx["tx"]> = {}): ClassifiedTx["tx"] => ({
  id,
  accountId: "acc",
  bookingDate: "2026-10-01",
  amountCents: -1_500,
  currency: "EUR",
  purpose: "Monatsbeitrag",
  counterpartyName: "Netflix International B.V.",
  ...over,
});
const cat = (id: string, over: Partial<ClassifiedTx["tx"]> = {}, account = "6815"): ClassifiedTx => ({
  tx: tx(id, over),
  classification: { action: "categorize", account, taxRule: "standard" },
});

describe("rule suggestions (BNK-053)", () => {
  test("BNK-053 T07-086 three identical manual classifications of one counterparty → a rule is proposed", () => {
    expect(RULE_SUGGESTION_MIN).toBe(3);
    const [s, ...rest] = suggestRules(
      [cat("a"), cat("b"), cat("c", { counterpartyName: "NETFLIX INTERNATIONAL B.V." })],
      [],
    );
    expect(rest).toEqual([]);
    expect(s).toEqual({
      key: "name:netflix international b v|categorize|6815|standard",
      name: "Netflix International B.V.",
      count: 3,
      transactionIds: ["a", "b", "c"],
      when: { counterpartyContains: "Netflix International B.V.", direction: "out" },
      apply: { action: "categorize", account: "6815", taxRule: "standard" },
      message: "3 Umsätze von „Netflix International B.V.“ wurden gleich zugeordnet – Regel anlegen?",
    });
  });

  test("BNK-053 two classifications, differing accounts or mixed directions are not enough", () => {
    expect(suggestRules([cat("a"), cat("b")], [])).toEqual([]);
    expect(suggestRules([cat("a"), cat("b"), cat("c", {}, "6300")], [])).toEqual([]);
    const [s] = suggestRules([cat("a"), cat("b"), cat("c", { amountCents: 1_500 })], []);
    expect(s?.when.direction).toBeUndefined();
  });

  test("BNK-053 the IBAN is the token when known; private marks propose a „privat“ rule", () => {
    const priv = (id: string): ClassifiedTx => ({
      tx: tx(id, { counterpartyName: `Max Muster ${id}`, counterpartyIban: "DE02 1203 0000 0000 2020 51" }),
      classification: { action: "private" },
    });
    const [s] = suggestRules([priv("a"), priv("b"), priv("c")], []);
    expect(s?.when).toEqual({ ibanEquals: "DE02120300000000202051", direction: "out" });
    expect(s?.apply).toEqual({ action: "private" });
  });

  test("BNK-053 card merchants use the merchant; transactions an enabled rule already covers are not counted", () => {
    const card = (id: string) => cat(id, { counterpartyName: undefined, merchantName: "ADOBE *CREATIVE CLOUD" });
    const [s] = suggestRules([card("a"), card("b"), card("c")], []);
    expect(s?.when).toEqual({ merchantContains: "ADOBE *CREATIVE CLOUD", direction: "out" });
    const rule: MatchingRule = {
      id: "r1",
      name: "Adobe",
      priority: 10,
      enabled: true,
      mode: "suggest",
      when: { merchantContains: "adobe" },
      apply: { action: "categorize", account: "6815" },
    };
    expect(suggestRules([card("a"), card("b"), card("c")], [rule])).toEqual([]);
    expect(suggestRules([card("a"), card("b"), card("c")], [{ ...rule, enabled: false }])).toHaveLength(1);
  });

  test("BNK-053 rows without a counterparty token are ignored", () => {
    const none = (id: string) => cat(id, { counterpartyName: undefined });
    expect(suggestRules([none("a"), none("b"), none("c")], [])).toEqual([]);
  });
});
