/**
 * Duplicate detection (F02 CON-130/131, T-CON-050): same VAT ID, same invoice e-mail, same IBAN, or Jaro-Winkler
 * similarity ≥ 0.92 of normalised names (lower case, legal-form suffix and punctuation removed) with the same postal
 * code. Hints never block; the same `number` is a blocking error elsewhere (CONTACT_NUMBER_TAKEN).
 */
import { foldSearch } from "./core";

export const NAME_SIMILARITY_THRESHOLD = 0.92;

/** Jaro-Winkler similarity (prefix scale 0.1, max prefix 4). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array<boolean>(a.length).fill(false);
  const bMatch = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(i + range + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

const LEGAL_FORMS =
  /\b(gmbh\s*&\s*co\.?\s*kg|gmbh|ug(\s*\(haftungsbeschrankt\))?|ag|kg|ohg|gbr|e\.?\s?k\.?|e\.?\s?v\.?|mbh|ltd|limited|inc|llc|sarl|sas|s\.?a\.?|b\.?v\.?|s\.?r\.?l\.?|partg(\s*mbb)?|co)\b\.?/g;

/** Lower case, umlauts transliterated, legal-form suffixes and punctuation removed ("Müller GmbH" → "mueller"). */
export function normalizeName(name: string): string {
  const translit = name.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
  return foldSearch(translit)
    .replace(LEGAL_FORMS, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface DuplicateCandidate {
  readonly id: string;
  readonly displayName: string;
  readonly number?: string;
  readonly vatId?: string | undefined;
  readonly invoiceEmails: readonly string[];
  readonly iban?: string | undefined;
  readonly postalCode?: string | undefined;
}

export type DuplicateReason = "vat_id" | "invoice_email" | "iban" | "name";

export const DUPLICATE_REASON_LABELS: Readonly<Record<DuplicateReason, string>> = {
  vat_id: "gleiche USt-IdNr",
  invoice_email: "gleiche Rechnungs-E-Mail",
  iban: "gleiche IBAN",
  name: "ähnlicher Name, gleiche PLZ",
};

export interface DuplicateHint {
  readonly id: string;
  readonly score: number;
  readonly reasons: DuplicateReason[];
}

/** Reasons why `a` and `b` look like duplicates, with a score (1 for exact identifiers, else the name similarity). */
export function compareCandidates(a: DuplicateCandidate, b: DuplicateCandidate): DuplicateHint | null {
  if (a.id === b.id) return null;
  const reasons: DuplicateReason[] = [];
  let score = 0;
  if (a.vatId && b.vatId && a.vatId === b.vatId) {
    reasons.push("vat_id");
    score = 1;
  }
  const emails = new Set(a.invoiceEmails.map((e) => e.toLowerCase()));
  if (b.invoiceEmails.some((e) => emails.has(e.toLowerCase()))) {
    reasons.push("invoice_email");
    score = 1;
  }
  if (a.iban && b.iban && a.iban === b.iban) {
    reasons.push("iban");
    score = 1;
  }
  if (a.postalCode && b.postalCode && a.postalCode.trim() === b.postalCode.trim()) {
    const na = normalizeName(a.displayName);
    const nb = normalizeName(b.displayName);
    const sim = na && nb ? jaroWinkler(na, nb) : 0;
    if (sim >= NAME_SIMILARITY_THRESHOLD) {
      reasons.push("name");
      score = Math.max(score, sim);
    }
  }
  return reasons.length > 0 ? { id: b.id, score: Math.round(score * 1000) / 1000, reasons } : null;
}

/** CON-130: hints for one (new or edited) contact against the others. */
export function findDuplicateHints(
  subject: DuplicateCandidate,
  others: readonly DuplicateCandidate[],
): DuplicateHint[] {
  return others
    .map((o) => compareCandidates(subject, o))
    .filter((h): h is DuplicateHint => h !== null)
    .sort((x, y) => y.score - x.score);
}

/** Canonical pair key (a < b) for `dismissedDuplicates` (03 §2). */
export const pairKey = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

export interface DuplicatePair {
  readonly a: string;
  readonly b: string;
  readonly score: number;
  readonly reasons: DuplicateReason[];
}

/**
 * CON-131: all candidate pairs (each pair once, dismissed pairs excluded). Exact identifiers are bucketed; names are
 * compared within the same postal code only, so the work stays near-linear for real data.
 */
export function findDuplicatePairs(
  all: readonly DuplicateCandidate[],
  dismissed: ReadonlySet<string> = new Set(),
): DuplicatePair[] {
  const pairs = new Map<string, DuplicatePair>();
  const consider = (x: DuplicateCandidate, y: DuplicateCandidate) => {
    const [a, b] = pairKey(x.id, y.id);
    const key = `${a}|${b}`;
    if (pairs.has(key) || dismissed.has(key)) return;
    const hint = compareCandidates(x, y);
    if (hint) pairs.set(key, { a, b, score: hint.score, reasons: hint.reasons });
  };
  const buckets = new Map<string, DuplicateCandidate[]>();
  const add = (k: string, c: DuplicateCandidate) => {
    const list = buckets.get(k) ?? [];
    list.push(c);
    buckets.set(k, list);
  };
  for (const c of all) {
    if (c.vatId) add(`v:${c.vatId}`, c);
    for (const e of c.invoiceEmails) add(`e:${e.toLowerCase()}`, c);
    if (c.iban) add(`i:${c.iban}`, c);
    if (c.postalCode) add(`p:${c.postalCode.trim()}`, c);
  }
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) consider(list[i] as DuplicateCandidate, list[j] as DuplicateCandidate);
    }
  }
  return [...pairs.values()].sort((x, y) => y.score - x.score);
}
