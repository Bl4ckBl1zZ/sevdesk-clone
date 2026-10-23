/**
 * F07 BNK-053 rule suggestions: after {@link RULE_SUGGESTION_MIN} identical manual classifications of transactions
 * with the same counterparty token (IBAN, else card merchant, else counterparty name), propose a matching rule. Pure;
 * the owner reviews and saves the rule (always suggested, never created automatically). Transactions that an enabled
 * rule already covers do not count.
 */
import { normaliseIban, normaliseText } from "./normalise";
import {
  firstMatchingRule,
  type MatchingRule,
  type RuleApply,
  type RuleConditions,
  type RuleTx,
  ruleMatches,
} from "./rules";

export const RULE_SUGGESTION_MIN = 3;

/** A manual classification the rules can reproduce: a voucher from the transaction (categorize) or a private mark. */
export type Classification = { action: "categorize"; account: string; taxRule?: string } | { action: "private" };

export interface ClassifiedTx {
  tx: RuleTx;
  classification: Classification;
}

export interface RuleSuggestion {
  key: string;
  name: string;
  count: number;
  transactionIds: string[];
  when: RuleConditions;
  apply: RuleApply;
  message: string;
}

type Token = { key: string; when: (tx: RuleTx) => RuleConditions; label: (tx: RuleTx) => string };

function tokenOf(tx: RuleTx): Token | null {
  if (tx.counterpartyIban) {
    const iban = normaliseIban(tx.counterpartyIban);
    return {
      key: `iban:${iban}`,
      when: () => ({ ibanEquals: iban }),
      label: (t) => t.counterpartyName ?? iban,
    };
  }
  if (tx.merchantName && normaliseText(tx.merchantName)) {
    return {
      key: `merchant:${normaliseText(tx.merchantName)}`,
      when: (t) => ({ merchantContains: t.merchantName ?? "" }),
      label: (t) => t.merchantName ?? "",
    };
  }
  if (tx.counterpartyName && normaliseText(tx.counterpartyName)) {
    return {
      key: `name:${normaliseText(tx.counterpartyName)}`,
      when: (t) => ({ counterpartyContains: t.counterpartyName ?? "" }),
      label: (t) => t.counterpartyName ?? "",
    };
  }
  return null;
}

const classKey = (c: Classification) =>
  c.action === "categorize" ? `categorize|${c.account}|${c.taxRule ?? ""}` : "private";

export function suggestRules(items: readonly ClassifiedTx[], rules: readonly MatchingRule[]): RuleSuggestion[] {
  const groups = new Map<string, { token: Token; classification: Classification; txs: RuleTx[] }>();
  for (const item of items) {
    if (firstMatchingRule(rules, item.tx)) continue;
    const token = tokenOf(item.tx);
    if (!token) continue;
    const key = `${token.key}|${classKey(item.classification)}`;
    const g = groups.get(key) ?? { token, classification: item.classification, txs: [] };
    g.txs.push(item.tx);
    groups.set(key, g);
  }
  const out: RuleSuggestion[] = [];
  for (const [key, g] of groups) {
    if (g.txs.length < RULE_SUGGESTION_MIN) continue;
    const directions = new Set(g.txs.map((t) => (t.amountCents >= 0 ? "in" : "out")));
    const direction = directions.size === 1 ? { direction: [...directions][0] as "in" | "out" } : {};
    // The proposed condition must reproduce every counted classification (name spellings may differ).
    const when = g.txs
      .map((t) => ({ ...g.token.when(t), ...direction }))
      .find((w) => g.txs.every((t) => ruleMatches({ when: w }, t)));
    const first = g.txs[0];
    if (!when || !first) continue;
    const name = g.token.label(first);
    out.push({
      key,
      name,
      count: g.txs.length,
      transactionIds: g.txs.map((t) => t.id),
      when,
      apply:
        g.classification.action === "categorize"
          ? {
              action: "categorize",
              account: g.classification.account,
              ...(g.classification.taxRule ? { taxRule: g.classification.taxRule } : {}),
            }
          : { action: "private" },
      message: `${g.txs.length} Umsätze von „${name}“ wurden gleich zugeordnet – Regel anlegen?`,
    });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
