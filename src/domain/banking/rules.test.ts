import { describe, expect, test } from "vitest";
import {
  categorizeOutcome,
  checkRegex,
  firstMatchingRule,
  type MatchingRule,
  modeForChannel,
  previewRule,
  type RuleTx,
  ruleMatches,
  validateRule,
} from "./rules";

const tx = (over: Partial<RuleTx> = {}): RuleTx => ({
  id: "t1",
  accountId: "a1",
  bookingDate: "2026-10-10",
  amountCents: -1500,
  currency: "EUR",
  purpose: "Monthly plan fee Business Grow",
  counterpartyName: "Revolut",
  bankTransactionCode: "PMNT-MDOP-FEES",
  proprietaryCode: "FEE",
  ...over,
});

const rule = (over: Partial<MatchingRule> = {}): MatchingRule => ({
  id: "r1",
  name: "Kontoführung",
  priority: 10,
  enabled: true,
  mode: "suggest",
  when: { purposeContains: "plan fee" },
  apply: { action: "categorize", account: "6855" },
  ...over,
});

describe("matching rules (BNK-050)", () => {
  test.each([
    ["purpose contains (case/umlaut-insensitive)", { purposeContains: "PLAN FEE" }, {}, true],
    ["regex", { purposeRegex: "plan\\s+fee\\b" }, {}, true],
    ["regex miss", { purposeRegex: "^Miete" }, {}, false],
    ["MCC in list", { mccIn: ["5734", "7372"] }, { mcc: "7372" }, true],
    ["MCC missing", { mccIn: ["5734"] }, {}, false],
    ["bank transaction code", { bankTransactionCode: "pmnt-mdop-fees" }, {}, true],
    ["proprietary code (Revolut Type)", { proprietaryCode: "CARD_PAYMENT" }, {}, false],
    ["amount range on the absolute amount", { amountMinCents: 1000, amountMaxCents: 2000 }, {}, true],
    ["amount above range", { amountMaxCents: 1000 }, {}, false],
    ["direction out", { direction: "out" as const }, {}, true],
    ["direction in", { direction: "in" as const }, {}, false],
    [
      "IBAN equals (normalised)",
      { ibanEquals: "de02 1203 0000 0000 2020 51" },
      { counterpartyIban: "DE02120300000000202051" },
      true,
    ],
    ["counterparty contains", { counterpartyContains: "revol" }, {}, true],
    ["merchant contains", { merchantContains: "acme" }, { merchantName: "ACME Corp." }, true],
    ["account", { accountId: "a2" }, {}, false],
    ["currency", { currency: "usd" }, {}, false],
  ] as const)("BNK-050 condition: %s", (_n, when, over, expected) => {
    expect(ruleMatches({ when: when as MatchingRule["when"] }, tx(over as Partial<RuleTx>))).toBe(expected);
  });

  test("BNK-050 first matching rule by priority wins; disabled rules are skipped", () => {
    const rules = [
      rule({ id: "late", priority: 20, when: { counterpartyContains: "revolut" } }),
      rule({ id: "early", priority: 5, when: { purposeContains: "fee" } }),
      rule({ id: "off", priority: 1, enabled: false, when: { purposeContains: "fee" } }),
    ];
    expect(firstMatchingRule(rules, tx())?.id).toBe("early");
    expect(firstMatchingRule(rules, tx({ purpose: "Überweisung" }))?.id).toBe("late");
  });

  test("EC-BNK-71 BNK-050 a rule never acts on a pending item", () => {
    expect(ruleMatches(rule(), tx({ pending: true }))).toBe(false);
    expect(firstMatchingRule([rule()], tx({ pending: true }))).toBeNull();
  });

  test("EC-BNK-70 BNK-050 catastrophic, overlong or invalid regex is rejected at save", () => {
    for (const p of ["(a+)+$", "(a|aa)*", "(.*)*x", "(\\w+\\s?)+$", "x".repeat(201), "(?=a)b", "(a)\\1", "[a-"]) {
      const r = checkRegex(p);
      expect(r.ok, p).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/^Ungültiger regulärer Ausdruck: .+\.$/);
    }
    for (const p of ["plan\\s+fee", "^RE-\\d{4}-\\d+$", "(Miete|Pacht) \\d+", "a{2,3}b?"])
      expect(checkRegex(p).ok, p).toBe(true);
    expect(validateRule(rule({ when: { purposeRegex: "(a+)+" } }))[0]?.code).toBe("rule_regex_invalid");
  });

  test("BNK-050 validation: name, at least one condition, action fields, ignore never automatic", () => {
    expect(validateRule(rule({ name: " ", when: {} })).map((i) => i.params?.field)).toEqual(["name", "when"]);
    expect(validateRule(rule({ apply: { action: "categorize" } }))[0]?.message).toBe(
      "Bitte das Konto für die Kategorisierung angeben.",
    );
    expect(validateRule(rule({ apply: { action: "transfer" } }))[0]?.params?.field).toBe("apply.transferTarget");
    expect(validateRule(rule({ mode: "auto", apply: { action: "ignore" } }))[0]?.params?.field).toBe("mode");
    expect(validateRule(rule())).toEqual([]);
  });
});

describe("rule preview (BNK-051)", () => {
  test("BNK-051 counts only booked hits of the last 90 days", () => {
    const txs = [
      tx({ id: "a", bookingDate: "2026-10-01" }),
      tx({ id: "b", bookingDate: "2026-07-21" }),
      tx({ id: "c", bookingDate: "2026-07-20" }), // 91 days before
      tx({ id: "d", bookingDate: "2026-10-02", purpose: "Miete" }),
      tx({ id: "e", bookingDate: "2026-10-03", pending: true }),
    ];
    const p = previewRule(rule(), txs, "2026-10-19");
    expect(p.hits.map((h) => h.id)).toEqual(["a", "b"]);
    expect(p.message).toBe("Diese Regel würde 2 Umsätze der letzten 90 Tage treffen");
    expect(previewRule(rule(), [txs[0] as RuleTx], "2026-10-19").message).toBe(
      "Diese Regel würde 1 Umsatz der letzten 90 Tage treffen",
    );
  });
});

describe("rule vouchers and channels (BNK-052, BNK-054)", () => {
  test("EC-BNK-72 BNK-052 auto + „Kontoauszug genügt“ → finalised, otherwise draft „Beleg fehlt“", () => {
    const t = tx();
    expect(
      categorizeOutcome(
        rule({ mode: "auto", apply: { action: "categorize", account: "6855", statementSufficesAsVoucher: true } }),
        t,
      ),
    ).toEqual({
      kind: "finalised",
    });
    expect(categorizeOutcome(rule({ mode: "auto" }), t)).toEqual({
      kind: "draft_missing_receipt",
      warning: "Beleg fehlt für automatisch kategorisierten Umsatz 10.10.2026 −15,00 €.",
    });
    expect(
      categorizeOutcome(
        rule({ mode: "suggest", apply: { action: "categorize", account: "6855", statementSufficesAsVoucher: true } }),
        t,
      ).kind,
    ).toBe("draft_missing_receipt");
  });

  test("EC-BNK-73 BNK-054 API/MCP rules are stored as suggest; the UI may choose auto", () => {
    expect(modeForChannel("mcp", "auto")).toEqual({
      mode: "suggest",
      warning: {
        code: "rule_mode_suggest",
        message:
          "Regeln aus API/MCP werden als Vorschlagsregel gespeichert. Automatik bitte in der Oberfläche aktivieren.",
      },
    });
    expect(modeForChannel("api", undefined)).toEqual({ mode: "suggest" });
    expect(modeForChannel("ui", "auto")).toEqual({ mode: "auto" });
  });
});
