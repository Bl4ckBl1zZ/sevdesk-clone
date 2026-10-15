/**
 * Matching scorer (F07 BNK-040…BNK-048, §4.4 weights, golden M1–M8; EC-152). Pure: the Convex model loads the open
 * items, unreconciled manual payments, credit balances, aliases and rejections and persists the returned candidates
 * as `matchSuggestions`.
 *
 * Primary rule: the document number in the reference/purpose (normalised: case, spaces, `-`/`/` variants, leading
 * zeros, an optional „RE “ prefix). Scores are computed in basis points (integer) and returned as 0…1.
 */
import type { MatchAllocation, MatchCandidate, MatchReason, UnmatchedTransaction } from "./match-types";

export const WEIGHTS_BP = {
  rf_reference: 10_000,
  number_in_purpose: 5000,
  exact_amount: 4000,
  skonto_amount: 3500,
  existing_manual_payment: 4500,
  known_iban: 2000,
  name_similarity_max: 1500,
  name_similarity_min: 500,
  amount_tolerance: 1500,
  partial: 1000,
  date_window: 500,
  far_outside: -3000,
} as const;

export const AMBIGUITY_BP = 500;
export const AMBIGUOUS_CAP_BP = 9000;
export const NAME_THRESHOLD = 0.85;
export const SUBSET_MAX_ITEMS = 12;

export interface MatchThresholds {
  autoApplyBp: number;
  safeBp: number;
  suggestBp: number;
}

export const DEFAULT_THRESHOLDS: MatchThresholds = { autoApplyBp: 9800, safeBp: 9500, suggestBp: 4000 };

export interface OpenDocument {
  kind: "salesDocument" | "opening_item";
  id: string;
  number: string;
  contactId?: string;
  contactName: string;
  /** IBANs of the contact and learned IBAN aliases (BNK-048). */
  ibans: readonly string[];
  /** Learned name tokens of the contact (BNK-048). */
  aliases: readonly string[];
  documentDate: string;
  dueDate?: string;
  openCents: number;
  currency: string;
  skonto?: { deadline: string; agreedCents: number } | null;
}

export interface ManualPayment {
  paymentId: string;
  date: string;
  amountCents: number;
  /** clearing account the manual payment was booked on (PAY-047: same bank/clearing account). */
  accountId: string;
  label: string;
}

export interface CreditBalanceCandidate {
  contactId: string;
  contactName: string;
  ibans: readonly string[];
  aliases: readonly string[];
  balanceCents: number;
}

export interface MatchInput {
  documents: readonly OpenDocument[];
  manualPayments?: readonly ManualPayment[];
  credits?: readonly CreditBalanceCandidate[];
  /** `${targetKind}:${targetId}` pairs the owner rejected for this transaction (BNK-046). */
  rejected?: ReadonlySet<string>;
}

// ── normalisation ───────────────────────────────────────────────────────────────────────────────────────

const UMLAUT: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss", Ä: "AE", Ö: "OE", Ü: "UE" };

/** Alpha/digit groups, upper case, digit groups without leading zeros: „re-2026/0042“ → [RE, 2026, 42]. */
export function numberTokens(s: string): string[] {
  return (
    s
      .replace(/[äöüßÄÖÜ]/g, (c) => UMLAUT[c] ?? c)
      .toUpperCase()
      .match(/[A-Z]+|\d+/g) ?? []
  ).map((t) => (/^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, "") : t));
}

const containsSeq = (hay: readonly string[], needle: readonly string[]): boolean => {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

/**
 * How the document number appears in the text: `full` (with prefix, e.g. „RE-2026-0042“, „RE 2026 42“),
 * `body` (without the leading letters, ≥ 2 groups, e.g. „2026-0042“) or `tail` (only the last digit group,
 * „Rechnung 42“ — counts only if unique among the candidates).
 */
export function numberMatch(number: string, text: string): "full" | "body" | "tail" | null {
  const n = numberTokens(number);
  const t = numberTokens(text);
  if (n.length === 0) return null;
  if (containsSeq(t, n)) return "full";
  let k = 0;
  while (k < n.length && /^[A-Z]+$/.test(n[k] as string)) k++;
  const body = n.slice(k);
  if (body.length >= 2 && containsSeq(t, body)) return "body";
  const tail = n.at(-1);
  if (tail && /^\d{2,}$/.test(tail) && t.includes(tail)) return "tail";
  return null;
}

/** ISO 11649 creditor reference: RF + 2 check digits + 1–21 alphanumerics, mod 97 = 1. */
export function isValidRf(ref: string): boolean {
  const s = ref.replace(/\s+/g, "").toUpperCase();
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** Creates the RF reference for a payload (used for tests and future printed references). */
export function rfFor(payload: string): string {
  const p = payload.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const num = `${p}RF00`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of num) rem = (rem * 10 + Number(d)) % 97;
  return `RF${String(98 - rem).padStart(2, "0")}${p}`;
}

const LEGAL_FORMS = /\b(gmbh|mbh|ug|ag|kg|ohg|gbr|ek|e k|eg|co|se|ltd|inc|haftungsbeschraenkt)\b/g;

export function normaliseName(s: string): string {
  return s
    .replace(/[äöüßÄÖÜ]/g, (c) => UMLAUT[c] ?? c)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(LEGAL_FORMS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaro-Winkler similarity (0…1). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Best similarity of the transaction's counterparty (or description) with the contact name and aliases. */
export function nameSimilarity(tx: UnmatchedTransaction, names: readonly string[]): number {
  const sources = [tx.counterpartyName, tx.merchantName].filter((x): x is string => !!x).map(normaliseName);
  const purpose = normaliseName(tx.purpose);
  let best = 0;
  for (const raw of names) {
    const n = normaliseName(raw);
    if (!n) continue;
    for (const s of sources) best = Math.max(best, jaroWinkler(s, n));
    // EC-152: no payer name delivered → the name inside the description counts (whole-word containment).
    if (purpose && n.length >= 4 && ` ${purpose} `.includes(` ${n} `)) best = Math.max(best, 0.9);
  }
  return best;
}

const nameBp = (sim: number) =>
  sim < NAME_THRESHOLD
    ? 0
    : Math.round(
        WEIGHTS_BP.name_similarity_min +
          ((Math.min(1, sim) - NAME_THRESHOLD) / (1 - NAME_THRESHOLD)) *
            (WEIGHTS_BP.name_similarity_max - WEIGHTS_BP.name_similarity_min),
      );

const normIban = (s: string) => s.replace(/\s+/g, "").toUpperCase();
const compact = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

function epochDay(d: string): number {
  return Math.floor(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000);
}

/** `date_window`: booking date within [document date − 3, due date + 45]; > 180 days outside → penalty. */
function dateSignal(booking: string, doc: { documentDate: string; dueDate?: string }): number {
  const b = epochDay(booking);
  const from = epochDay(doc.documentDate) - 3;
  const to = epochDay(doc.dueDate ?? doc.documentDate) + 45;
  if (b >= from && b <= to) return WEIGHTS_BP.date_window;
  const outside = b < from ? from - b : b - to;
  return outside > 180 ? WEIGHTS_BP.far_outside : 0;
}

// ── scoring ─────────────────────────────────────────────────────────────────────────────────────────────

interface Scored {
  bp: number;
  candidate: Omit<MatchCandidate, "score">;
  /** contact identified by the transaction (for the subset-sum fallback). */
  contactId?: string;
}

const pushReason = (rs: MatchReason[], r: MatchReason) => (rs.includes(r) ? rs : rs.push(r));

function scoreDocument(
  tx: UnmatchedTransaction,
  d: OpenDocument,
  numberKind: "full" | "body" | "tail" | null,
  rf: boolean,
): Scored | null {
  const amount = tx.openCents;
  const reasons: MatchReason[] = [];
  let bp = 0;
  if (rf) {
    bp += WEIGHTS_BP.rf_reference;
    reasons.push("rf_reference");
  }
  const byNumber = numberKind !== null;
  if (byNumber && !rf) {
    bp += WEIGHTS_BP.number_in_purpose;
    reasons.push("number_in_purpose");
  }
  const allocations: MatchAllocation[] = [];
  let kind: MatchCandidate["kind"] = "single";
  const skonto = d.skonto;
  const skontoAmount = skonto ? d.openCents - skonto.agreedCents : null;
  const tolerance = Math.max(Math.floor(d.openCents / 100), 200);
  if (amount === d.openCents) {
    bp += WEIGHTS_BP.exact_amount;
    reasons.push("exact_amount");
    allocations.push({ target: { kind: d.kind, id: d.id }, amountCents: amount });
  } else if (
    skonto &&
    skontoAmount !== null &&
    Math.abs(amount - skontoAmount) <= 1 &&
    tx.bookingDate <= skonto.deadline &&
    amount < d.openCents
  ) {
    bp += WEIGHTS_BP.skonto_amount;
    reasons.push("skonto_amount");
    allocations.push({
      target: { kind: d.kind, id: d.id },
      amountCents: amount,
      differences: [{ reason: "skonto", amountCents: d.openCents - amount }],
    });
  } else if (amount < d.openCents && byNumber) {
    bp += WEIGHTS_BP.partial;
    reasons.push("partial");
    kind = "partial";
    allocations.push({ target: { kind: d.kind, id: d.id }, amountCents: amount });
  } else if (Math.abs(amount - d.openCents) <= tolerance && amount < d.openCents) {
    bp += WEIGHTS_BP.amount_tolerance;
    reasons.push("amount_tolerance");
    allocations.push({
      target: { kind: d.kind, id: d.id },
      amountCents: amount,
      differences: [{ reason: "bank_fees", amountCents: d.openCents - amount }],
    });
  } else if (amount > d.openCents && byNumber && d.contactId) {
    // EC-BNK-64: overpayment with a number match → the excess becomes a credit balance (PAY-030 c).
    allocations.push({ target: { kind: d.kind, id: d.id }, amountCents: d.openCents });
    allocations.push({ target: { kind: "contactCredit", id: d.contactId }, amountCents: amount - d.openCents });
  } else if (!byNumber && !rf) {
    return null;
  } else {
    allocations.push({ target: { kind: d.kind, id: d.id }, amountCents: Math.min(amount, d.openCents) });
  }
  if (tx.counterpartyIban && d.ibans.map(normIban).includes(normIban(tx.counterpartyIban))) {
    bp += WEIGHTS_BP.known_iban;
    reasons.push("known_iban");
  }
  const sim = nameSimilarity(tx, [d.contactName, ...d.aliases]);
  const nb = nameBp(sim);
  if (nb > 0) {
    bp += nb;
    reasons.push("name_similarity");
  }
  bp += dateSignal(tx.bookingDate, d);
  if (dateSignal(tx.bookingDate, d) > 0) reasons.push("date_window");
  const identified = byNumber || rf || reasons.includes("known_iban") || nb > 0;
  return {
    bp,
    candidate: { kind, allocations, reasons },
    ...(identified && d.contactId ? { contactId: d.contactId } : {}),
  };
}

/** BNK-044 bounded exact subset-sum: fewest items first, then the oldest due dates. */
export function subsetSum(
  items: readonly OpenDocument[],
  target: number,
  maxItems = SUBSET_MAX_ITEMS,
): OpenDocument[] | null {
  const pool = [...items]
    .filter((d) => d.openCents > 0)
    .sort((a, b) => (a.dueDate ?? a.documentDate).localeCompare(b.dueDate ?? b.documentDate))
    .slice(0, maxItems);
  for (let size = 2; size <= pool.length; size++) {
    const pick: number[] = [];
    const found = (start: number, rest: number): boolean => {
      if (pick.length === size) return rest === 0;
      for (let i = start; i < pool.length; i++) {
        const v = (pool[i] as OpenDocument).openCents;
        if (v > rest) continue;
        pick.push(i);
        if (found(i + 1, rest - v)) return true;
        pick.pop();
      }
      return false;
    };
    if (found(0, target)) return pick.map((i) => pool[i] as OpenDocument);
  }
  return null;
}

const toBp = (score: number) => Math.round(score * 10_000);
const finalise = (s: Scored): MatchCandidate => ({
  ...s.candidate,
  score: Math.max(0, Math.min(10_000, s.bp)) / 10_000,
});

/** Scores one transaction (`MatchCandidateProvider`); candidates below the suggest threshold are dropped. */
export function scoreTransaction(
  tx: UnmatchedTransaction,
  input: MatchInput,
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): MatchCandidate[] {
  const rejected = input.rejected ?? new Set<string>();
  const ok = (kind: string, id: string) => !rejected.has(`${kind}:${id}`);
  const text = [tx.reference ?? "", tx.purpose].join(" ");
  const out: Scored[] = [];

  if (tx.direction === "out") {
    // Refund of a credit balance (PAY-033, BNK-041 outgoing).
    for (const c of input.credits ?? []) {
      if (c.balanceCents <= 0 || !ok("contactCredit", c.contactId)) continue;
      const reasons: MatchReason[] = [];
      let bp = 0;
      if (c.balanceCents === tx.openCents) {
        bp += WEIGHTS_BP.exact_amount;
        reasons.push("exact_amount");
      } else continue;
      if (tx.counterpartyIban && c.ibans.map(normIban).includes(normIban(tx.counterpartyIban))) {
        bp += WEIGHTS_BP.known_iban;
        reasons.push("known_iban");
      }
      const nb = nameBp(nameSimilarity(tx, [c.contactName, ...c.aliases]));
      if (nb > 0) {
        bp += nb;
        reasons.push("name_similarity");
      }
      out.push({
        bp,
        candidate: {
          kind: "single",
          reasons,
          allocations: [{ target: { kind: "contactCredit", id: c.contactId }, amountCents: tx.openCents }],
        },
      });
    }
    return rank(out, thresholds);
  }

  const docs = input.documents.filter((d) => d.openCents > 0 && d.currency === tx.currency && ok(d.kind, d.id));
  const rfRef = [tx.reference, ...tx.purpose.split(/\s+/)].find((t) => t && isValidRf(t));
  const kinds = new Map(docs.map((d) => [d.id, numberMatch(d.number, text)]));
  // A bare tail match counts only when it is unique among the candidates (M2).
  const tails = docs.filter((d) => kinds.get(d.id) === "tail");
  if (tails.length > 1) for (const d of tails) kinds.set(d.id, null);

  // Existing unreconciled manual payment (PAY-047), ranked first.
  for (const m of input.manualPayments ?? []) {
    if (!ok("payment", m.paymentId) || m.amountCents !== tx.openCents) continue;
    if (Math.abs(epochDay(m.date) - epochDay(tx.bookingDate)) > 3) continue;
    out.push({
      bp: WEIGHTS_BP.existing_manual_payment + WEIGHTS_BP.exact_amount + WEIGHTS_BP.date_window,
      candidate: {
        kind: "single",
        reasons: ["existing_manual_payment", "exact_amount", "date_window"],
        allocations: [{ target: { kind: "payment", id: m.paymentId }, amountCents: m.amountCents }],
      },
    });
  }

  for (const d of docs) {
    const rf = rfRef ? rfRef.replace(/\s+/g, "").toUpperCase().slice(4) === compact(d.number) : false;
    const s = scoreDocument(tx, d, kinds.get(d.id) ?? null, rf);
    if (s) out.push(s);
  }

  // BNK-044 combined: ≥ 2 numbers in the reference whose open amounts sum to the amount.
  const numbered = docs.filter((d) => kinds.get(d.id) === "full" || kinds.get(d.id) === "body");
  if (numbered.length >= 2) {
    const sum = numbered.reduce((s, d) => s + d.openCents, 0);
    if (sum === tx.openCents) {
      const inWindow = numbered.every((d) => dateSignal(tx.bookingDate, d) > 0);
      const reasons: MatchReason[] = ["number_in_purpose", "exact_amount"];
      if (inWindow) reasons.push("date_window");
      out.push({
        bp: WEIGHTS_BP.number_in_purpose + WEIGHTS_BP.exact_amount + (inWindow ? WEIGHTS_BP.date_window : 0),
        candidate: {
          kind: "combined",
          reasons,
          allocations: numbered.map((d) => ({ target: { kind: d.kind, id: d.id }, amountCents: d.openCents })),
        },
      });
    }
  } else {
    // Subset-sum over the open items of an identified contact (≤ 12 items).
    const contacts = new Set(out.map((s) => s.contactId).filter((c): c is string => !!c));
    for (const d of docs) {
      if (!d.contactId || contacts.has(d.contactId)) continue;
      const iban = tx.counterpartyIban && d.ibans.map(normIban).includes(normIban(tx.counterpartyIban));
      if (iban || nameSimilarity(tx, [d.contactName, ...d.aliases]) >= NAME_THRESHOLD) contacts.add(d.contactId);
    }
    for (const contactId of contacts) {
      const own = docs.filter((d) => d.contactId === contactId);
      if (own.some((d) => d.openCents === tx.openCents)) continue;
      const subset = subsetSum(own, tx.openCents);
      if (!subset) continue;
      const first = own[0] as OpenDocument;
      const signals: MatchReason[] = [];
      if (tx.counterpartyIban && first.ibans.map(normIban).includes(normIban(tx.counterpartyIban)))
        signals.push("known_iban");
      if (nameSimilarity(tx, [first.contactName, ...first.aliases]) >= NAME_THRESHOLD) signals.push("name_similarity");
      const reasons: MatchReason[] = ["exact_amount"];
      let bp = WEIGHTS_BP.exact_amount + WEIGHTS_BP.date_window;
      for (const r of ["known_iban", "name_similarity"] as const) {
        if (signals.includes(r)) {
          pushReason(reasons, r);
          bp += r === "known_iban" ? WEIGHTS_BP.known_iban : WEIGHTS_BP.name_similarity_min;
        }
      }
      reasons.push("date_window");
      out.push({
        bp,
        candidate: {
          kind: "combined",
          reasons,
          allocations: subset.map((d) => ({ target: { kind: d.kind, id: d.id }, amountCents: d.openCents })),
        },
      });
    }
  }
  return rank(out, thresholds);
}

function rank(out: Scored[], thresholds: MatchThresholds): MatchCandidate[] {
  out.sort((a, b) => b.bp - a.bp);
  const [best, second] = out;
  // BNK-042 ambiguity guard: second-best within 0.05 → best capped at 0.90 with reason `ambiguous`.
  if (best && second && best.bp - second.bp <= AMBIGUITY_BP) {
    for (const s of out) {
      if (best.bp - s.bp > AMBIGUITY_BP) break;
      s.bp = Math.min(s.bp, AMBIGUOUS_CAP_BP);
      pushReason(s.candidate.reasons, "ambiguous");
    }
  }
  return out
    .map(finalise)
    .filter((c) => toBp(c.score) >= thresholds.suggestBp)
    .slice(0, 5);
}

/**
 * BNK-043 auto-apply: score ≥ auto threshold, unique (not ambiguous), number or RF reference, exact open amount,
 * a single allocation without differences (no Skonto/partial/combined/FX). Booked rows only (the caller passes
 * only booked transactions; pending rows never reach the scorer, RI-10).
 */
export function autoApplicable(c: MatchCandidate, thresholds: MatchThresholds = DEFAULT_THRESHOLDS): boolean {
  return (
    toBp(c.score) >= thresholds.autoApplyBp &&
    c.kind === "single" &&
    !c.reasons.includes("ambiguous") &&
    (c.reasons.includes("number_in_purpose") || c.reasons.includes("rf_reference")) &&
    c.reasons.includes("exact_amount") &&
    c.allocations.length === 1 &&
    c.allocations[0]?.target.kind !== "payment" &&
    (c.allocations[0]?.differences ?? []).length === 0
  );
}

/** BNK-043 „Alle sicheren bestätigen“: safe = score ≥ 0.95, not ambiguous. */
export const isSafe = (c: MatchCandidate, thresholds: MatchThresholds = DEFAULT_THRESHOLDS): boolean =>
  toBp(c.score) >= thresholds.safeBp && !c.reasons.includes("ambiguous");

/** German chips for the review UI (F07 §6.3). */
export const REASON_LABEL_DE: Readonly<Record<MatchReason, string>> = {
  number_in_purpose: "Rechnungsnr. im Verwendungszweck",
  rf_reference: "RF-Referenz",
  exact_amount: "Betrag exakt",
  bill_amount: "Fremdwährungsbetrag passt",
  skonto_amount: "Skonto",
  known_iban: "IBAN bekannt",
  name_similarity: "Name ähnlich",
  date_window: "Datum passt",
  rule: "Regel",
  existing_manual_payment: "Bereits erfasste Zahlung",
  recurring_expected: "Wiederkehrend erwartet",
  amount_tolerance: "Betrag fast gleich (Gebühren)",
  partial: "Teilzahlung",
  ambiguous: "mehrdeutig",
};

/** BNK-048: the normalised counterparty token learned on confirmation. */
export const aliasToken = (tx: Pick<UnmatchedTransaction, "counterpartyName">): string | null => {
  const n = tx.counterpartyName ? normaliseName(tx.counterpartyName) : "";
  return n.length >= 3 ? n : null;
};
