import { describe, expect, test } from "vitest";
import { checkRegex, firstMatchingRule, type MatchingRule, type RuleTx, ruleMatches, validateRule } from "./rules";

const tx = (over: Partial<RuleTx> = {}): RuleTx => ({
  id: "t1",
  accountId: "a1",
  bookingDate: "2026-10-10",
  amountCents: 2500,
  currency: "EUR",
  purpose: "Gutschrift",
  ...over,
});
const rule = (over: Partial<MatchingRule> = {}): MatchingRule => ({
  id: "r1",
  name: "Regel",
  priority: 10,
  enabled: true,
  mode: "suggest",
  when: { purposeContains: "gutschrift" },
  apply: { action: "categorize", account: "8400" },
  ...over,
});

describe("matching rules — conditions on missing transaction fields (BNK-050)", () => {
  test("BNK-050 code, counterparty, IBAN, merchant and amount conditions fail when the transaction lacks the field", () => {
    const bare = tx();
    for (const when of [
      { bankTransactionCode: "PMNT" },
      { proprietaryCode: "TRANSFER" },
      { counterpartyContains: "Kunde" },
      { ibanEquals: "DE02120300000000202051" },
      { merchantContains: "Shop" },
      { amountMinCents: 3000 },
      { direction: "out" as const },
    ]) {
      expect(ruleMatches({ when }, bare), JSON.stringify(when)).toBe(false);
    }
    // The merchant condition falls back to the counterparty name (card rows without merchant field).
    expect(ruleMatches({ when: { merchantContains: "shop" } }, tx({ counterpartyName: "Online Shop GmbH" }))).toBe(
      true,
    );
    expect(ruleMatches({ when: { direction: "in", amountMinCents: 2500 } }, bare)).toBe(true);
    expect(
      ruleMatches(
        { when: { ibanEquals: "DE02120300000000202051" } },
        tx({ counterpartyIban: "DE89370400440532013000" }),
      ),
    ).toBe(false);
    // The reference is searched together with the purpose.
    expect(ruleMatches({ when: { purposeContains: "RE-2026" } }, tx({ reference: "RE-2026-0042" }))).toBe(true);
  });

  test("BNK-050 equal priorities are ordered by name", () => {
    const b = rule({ id: "b", name: "Beta" });
    const a = rule({ id: "a", name: "Alpha" });
    expect(firstMatchingRule([b, a], tx())?.id).toBe("a");
    expect(firstMatchingRule([b, a], tx({ purpose: "Miete" }))).toBeNull();
  });
});

describe("matching rules — validation (BNK-050, EC-BNK-70)", () => {
  test("BNK-050 an inverted amount range, a contact-less link and a loan without both accounts are refused", () => {
    const fields = (r: MatchingRule) => validateRule(r).map((i) => i.params?.field);
    expect(fields(rule({ when: { amountMinCents: 5000, amountMaxCents: 1000 } }))).toEqual(["when.amountMinCents"]);
    expect(fields(rule({ when: { amountMinCents: 1000, amountMaxCents: 1000 } }))).toEqual([]);
    expect(fields(rule({ apply: { action: "link_contact" } }))).toEqual(["apply.contactId"]);
    expect(fields(rule({ apply: { action: "link_contact", contactId: "c1" } }))).toEqual([]);
    expect(fields(rule({ apply: { action: "loan", loanAccount: "0630" } }))).toEqual(["apply.loanAccount"]);
    expect(fields(rule({ apply: { action: "loan", interestAccount: "2110" } }))).toEqual(["apply.loanAccount"]);
    expect(fields(rule({ apply: { action: "loan", loanAccount: "0630", interestAccount: "2110" } }))).toEqual([]);
  });

  test("BNK-050 empty strings and empty MCC lists are no conditions", () => {
    expect(validateRule(rule({ when: { purposeContains: "", mccIn: [] } })).map((i) => i.params?.field)).toEqual([
      "when",
    ]);
    expect(validateRule(rule({ when: { amountMinCents: 0 } }))).toEqual([]);
  });

  test("EC-BNK-70 character classes, escapes and nested groups are judged correctly", () => {
    // A quantifier inside a character class is a literal, an escaped parenthesis no group.
    expect(checkRegex("([+*]x)+").ok).toBe(true);
    expect(checkRegex("\\(a+\\)+").ok).toBe(true);
    // A risky inner group makes its quantified outer group risky.
    expect(checkRegex("((a+)b)+").ok).toBe(false);
    expect(checkRegex("((ab)+c)*").ok).toBe(false);
    // An optional risky group is fine (no repetition).
    expect(checkRegex("(a|b)?c").ok).toBe(true);
    // A syntax error reported by the engine carries its message without the prefix.
    const r = checkRegex("a{2,1}");
    expect(r.ok ? null : r.error.message).toMatch(/^Ungültiger regulärer Ausdruck: (?!Invalid regular expression)/);
  });
});
