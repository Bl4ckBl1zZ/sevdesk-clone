/**
 * Matching rules (F07 BNK-050…054, §3.5; EC-BNK-70…73). Pure: conditions, the RE2-safe regex check, first match by
 * priority, the 90-day preview and the voucher outcome of `categorize`. Rules never act on pending items (they are
 * not in `bankTransactions` at all, BNK-111) and run before scoring.
 */

import { err, type Issue, issue, ok, type Result } from "../result";
import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";
import { formatMoneyDe } from "./amount";
import { normaliseIban, normaliseText } from "./normalise";

export type RuleMode = "suggest" | "auto";
export type RuleAction = "categorize" | "private" | "transfer" | "link_contact" | "ignore" | "loan";

export interface RuleConditions {
  accountId?: string;
  direction?: "in" | "out";
  currency?: string;
  bankTransactionCode?: string;
  proprietaryCode?: string;
  purposeContains?: string;
  purposeRegex?: string;
  counterpartyContains?: string;
  ibanEquals?: string;
  merchantContains?: string;
  mccIn?: string[];
  amountMinCents?: number;
  amountMaxCents?: number;
}

export interface RuleApply {
  action: RuleAction;
  account?: string;
  taxRule?: string;
  contactId?: string;
  transferTarget?: { kind: "bank"; accountId: string } | { kind: "cash" };
  loanAccount?: string;
  interestAccount?: string;
  createVoucher?: boolean;
  statementSufficesAsVoucher?: boolean;
}

export interface MatchingRule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  mode: RuleMode;
  when: RuleConditions;
  apply: RuleApply;
}

/** The fields of a booked transaction a rule can test. */
export interface RuleTx {
  id: string;
  accountId: string;
  bookingDate: string;
  amountCents: number;
  currency: string;
  purpose: string;
  reference?: string;
  counterpartyName?: string;
  counterpartyIban?: string;
  merchantName?: string;
  mcc?: string;
  bankTransactionCode?: string;
  proprietaryCode?: string;
  /** Provisional feed row (never matched, EC-BNK-71). */
  pending?: boolean;
}

export const RULE_MESSAGES = {
  regexInvalid: (error: string) => `Ungültiger regulärer Ausdruck: ${error}.`,
  nameRequired: "Bitte einen Namen für die Regel angeben.",
  conditionRequired: "Bitte mindestens eine Bedingung angeben.",
  accountRequired: "Bitte das Konto für die Kategorisierung angeben.",
  transferTargetRequired: "Bitte das Zielkonto (eigenes Bankkonto oder Kasse) angeben.",
  contactRequired: "Bitte den Kontakt angeben.",
  loanAccountsRequired: "Bitte Darlehenskonto und Zinsaufwandskonto angeben.",
  ignoreSuggestOnly:
    "Ignorieren ist nur als Vorschlagsregel möglich: gebuchte Bankbewegungen werden nur mit erlaubtem Grund ignoriert.",
  amountRange: "Der Mindestbetrag ist größer als der Höchstbetrag.",
  apiSuggestOnly:
    "Regeln aus API/MCP werden als Vorschlagsregel gespeichert. Automatik bitte in der Oberfläche aktivieren.",
  receiptMissing: (date: string, amount: string) =>
    `Beleg fehlt für automatisch kategorisierten Umsatz ${date} ${amount}.`,
  preview: (n: number) => `Diese Regel würde ${n} ${n === 1 ? "Umsatz" : "Umsätze"} der letzten 90 Tage treffen`,
} as const;

export const REGEX_MAX_LENGTH = 200;

/**
 * EC-BNK-70: a pattern is accepted only if it is RE2-safe — no backreferences, no lookaround, no quantified group that
 * itself contains a quantifier or an alternation (catastrophic backtracking), ≤ 200 characters, and valid syntax.
 */
export function checkRegex(pattern: string): Result<RegExp, Issue<"rule_regex_invalid">> {
  const fail = (e: string) => err(issue("rule_regex_invalid", RULE_MESSAGES.regexInvalid(e), { error: e }));
  if (pattern.length > REGEX_MAX_LENGTH) return fail(`länger als ${REGEX_MAX_LENGTH} Zeichen`);
  if (/\\[1-9]|\\k</.test(pattern)) return fail("Rückverweise sind nicht erlaubt");
  if (/\(\?<?[=!]/.test(pattern)) return fail("Lookahead/Lookbehind ist nicht erlaubt");
  if (nestedQuantifier(pattern)) return fail("verschachtelte Wiederholungen sind nicht erlaubt");
  try {
    return ok(new RegExp(pattern, "iu"));
  } catch (e) {
    return fail(e instanceof Error ? e.message.replace(/^Invalid regular expression: /, "") : String(e));
  }
}

/** A group followed by a quantifier whose body contains a quantifier or `|`. */
function nestedQuantifier(p: string): boolean {
  const stack: { start: number; risky: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "(") stack.push({ start: i, risky: false });
    else if (c === ")") {
      const g = stack.pop();
      const next = p[i + 1];
      const quantified = next === "*" || next === "+" || next === "?" || next === "{";
      if (g?.risky && quantified && next !== "?") return true;
      if (g?.risky && stack.length) (stack[stack.length - 1] as { risky: boolean }).risky = true;
      if (quantified && stack.length) (stack[stack.length - 1] as { risky: boolean }).risky = true;
    } else if ((c === "*" || c === "+" || c === "{" || c === "|") && stack.length) {
      (stack[stack.length - 1] as { risky: boolean }).risky = true;
    }
  }
  return false;
}

const hasCondition = (w: RuleConditions) =>
  Object.entries(w).some(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0));

/** BNK-050 validation at save (EC-BNK-70). */
export function validateRule(r: Pick<MatchingRule, "name" | "mode" | "when" | "apply">): Issue[] {
  const out: Issue[] = [];
  if (!r.name.trim()) out.push(issue("rule_invalid", RULE_MESSAGES.nameRequired, { field: "name" }));
  if (!hasCondition(r.when)) out.push(issue("rule_invalid", RULE_MESSAGES.conditionRequired, { field: "when" }));
  if (r.when.purposeRegex) {
    const re = checkRegex(r.when.purposeRegex);
    if (!re.ok) out.push(re.error);
  }
  if (
    r.when.amountMinCents !== undefined &&
    r.when.amountMaxCents !== undefined &&
    r.when.amountMinCents > r.when.amountMaxCents
  )
    out.push(issue("rule_invalid", RULE_MESSAGES.amountRange, { field: "when.amountMinCents" }));
  const t = r.apply;
  if (t.action === "categorize" && !t.account)
    out.push(issue("rule_invalid", RULE_MESSAGES.accountRequired, { field: "apply.account" }));
  if (t.action === "transfer" && !t.transferTarget)
    out.push(issue("rule_invalid", RULE_MESSAGES.transferTargetRequired, { field: "apply.transferTarget" }));
  if (t.action === "link_contact" && !t.contactId)
    out.push(issue("rule_invalid", RULE_MESSAGES.contactRequired, { field: "apply.contactId" }));
  if (t.action === "loan" && (!t.loanAccount || !t.interestAccount))
    out.push(issue("rule_invalid", RULE_MESSAGES.loanAccountsRequired, { field: "apply.loanAccount" }));
  if (t.action === "ignore" && r.mode === "auto")
    out.push(issue("rule_invalid", RULE_MESSAGES.ignoreSuggestOnly, { field: "mode" }));
  return out;
}

const contains = (hay: string | undefined, needle: string) => normaliseText(hay).includes(normaliseText(needle));

/** BNK-050: all conditions must hold; pending rows never match (EC-BNK-71). */
export function ruleMatches(r: Pick<MatchingRule, "when">, tx: RuleTx): boolean {
  if (tx.pending) return false;
  const w = r.when;
  const abs = Math.abs(tx.amountCents);
  if (w.accountId && w.accountId !== tx.accountId) return false;
  if (w.direction && w.direction !== (tx.amountCents >= 0 ? "in" : "out")) return false;
  if (w.currency && w.currency.toUpperCase() !== tx.currency.toUpperCase()) return false;
  if (w.bankTransactionCode && w.bankTransactionCode.toUpperCase() !== (tx.bankTransactionCode ?? "").toUpperCase())
    return false;
  if (w.proprietaryCode && w.proprietaryCode.toUpperCase() !== (tx.proprietaryCode ?? "").toUpperCase()) return false;
  const text = `${tx.reference ?? ""} ${tx.purpose}`;
  if (w.purposeContains && !contains(text, w.purposeContains)) return false;
  if (w.purposeRegex) {
    const re = checkRegex(w.purposeRegex);
    if (!re.ok || !re.value.test(text)) return false;
  }
  if (w.counterpartyContains && !contains(tx.counterpartyName, w.counterpartyContains)) return false;
  if (w.ibanEquals && (!tx.counterpartyIban || normaliseIban(w.ibanEquals) !== normaliseIban(tx.counterpartyIban)))
    return false;
  if (w.merchantContains && !contains(tx.merchantName ?? tx.counterpartyName, w.merchantContains)) return false;
  if (w.mccIn?.length && (!tx.mcc || !w.mccIn.includes(tx.mcc))) return false;
  if (w.amountMinCents !== undefined && abs < w.amountMinCents) return false;
  if (w.amountMaxCents !== undefined && abs > w.amountMaxCents) return false;
  return true;
}

/** BNK-050: the first enabled rule by priority (lower number first, then name) that matches. */
export function firstMatchingRule<R extends MatchingRule>(rules: readonly R[], tx: RuleTx): R | null {
  const sorted = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  return sorted.find((r) => ruleMatches(r, tx)) ?? null;
}

/** BNK-051: hits of a rule among the booked transactions of the last 90 days (no side effects). */
export function previewRule(
  r: Pick<MatchingRule, "when">,
  txs: readonly RuleTx[],
  today: string,
): { count: number; message: string; hits: RuleTx[] } {
  const from = addDays(today as CalendarDate, -90);
  const hits = txs.filter((t) => t.bookingDate >= from && t.bookingDate <= today && ruleMatches(r, t));
  return { count: hits.length, message: RULE_MESSAGES.preview(hits.length), hits };
}

/** BNK-054 / EC-BNK-73: rules from REST/MCP are stored as `suggest`; only the UI may switch to `auto`. */
export function modeForChannel(
  channel: string,
  requested: RuleMode | undefined,
): { mode: RuleMode; warning?: Issue<"rule_mode_suggest"> } {
  const mode = requested ?? "suggest";
  if (channel === "ui") return { mode };
  return mode === "auto"
    ? { mode: "suggest", warning: issue("rule_mode_suggest", RULE_MESSAGES.apiSuggestOnly) }
    : { mode: "suggest" };
}

/**
 * BNK-052 / EC-BNK-72: `categorize` books a finalised voucher only for an `auto` rule that marks „Kontoauszug genügt
 * als Beleg“ (e.g. bank fees); every other case creates a draft flagged „Beleg fehlt“ (F06 missing receipts).
 */
export function categorizeOutcome(
  r: Pick<MatchingRule, "mode" | "apply">,
  tx: Pick<RuleTx, "bookingDate" | "amountCents" | "currency">,
): { kind: "finalised" } | { kind: "draft_missing_receipt"; warning: string } {
  if (r.mode === "auto" && r.apply.statementSufficesAsVoucher) return { kind: "finalised" };
  return {
    kind: "draft_missing_receipt",
    warning: RULE_MESSAGES.receiptMissing(
      formatGermanDate(tx.bookingDate as CalendarDate),
      formatMoneyDe(tx.amountCents, tx.currency),
    ),
  };
}
