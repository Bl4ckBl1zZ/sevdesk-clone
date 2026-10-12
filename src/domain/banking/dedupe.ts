/**
 * Dedupe and cross-source dedupe (F07 BNK-109, BNK-110, BNK-034, BNK-026, BNK-113; §4.8; EC-148, EC-157, EC-192,
 * RI-29). Pure: the Convex import pipeline passes the candidate rows of one file and the existing rows of the account
 * and gets a plan back; nothing is ever inserted twice and nothing ambiguous is inserted silently.
 *
 * Keys: a row with a bank transaction ID (statement entry reference, Revolut CSV `ID`) → `{accountId}:er:{id}`;
 * otherwise `{accountId}:h:{contentHash}:{ordinal}` where the ordinal counts identical content hashes within the
 * file (two genuine identical coffees stay two rows; a re-import of a superset inserts only the surplus).
 *
 * Decision per candidate (file order):
 *  1. same dedupeKey, same source kind → `duplicate` (re-delivery; content changes → `conflict`, never applied);
 *     same dedupeKey, other source kind → `merge` (the same bank ID delivered by another format);
 *  2. same bank transaction ID in the existing row's sources → `merge` (ID matches are not limited to the same day,
 *     because date-only formats and UTC timestamps can disagree around midnight, EC-155);
 *  3. same content hash on the same booking date, not yet delivered by this source kind: exactly one → `merge`,
 *     several → `possible_duplicate`;
 *  4. near-duplicate (same date, amount and currency, compatible counterparty, different text formatting) →
 *     `possible_duplicate` (BNK-034, EC-BNK-77);
 *  5. otherwise `new`.
 * A `merge` whose amount differs, or whose date differs by more than a day, is a `conflict` (EC-BNK-15).
 */
import { sha256Hex } from "../audit/chain";
import { counterpartyKey, normaliseText } from "./normalise";
import type { BankSourceKind, ParsedTransaction } from "./types";

export interface Candidate extends ParsedTransaction {
  contentHash: string;
  rawSha256: string;
}

export interface ExistingBankRow {
  id: string;
  dedupeKey: string;
  contentHash: string;
  bookingDate: string;
  amountCents: number;
  currency: string;
  counterpartyName?: string;
  counterpartyIban?: string;
  counterpartyBic?: string;
  /** Bank transaction IDs of every source that delivered the row (entry references, Revolut IDs). */
  bankTxIds: readonly string[];
  sourceKinds: readonly string[];
  rawSha256s: readonly string[];
}

export type Enrichment = Partial<Pick<ParsedTransaction, "counterpartyName" | "counterpartyIban" | "counterpartyBic">>;

export type PlanItem =
  | { kind: "new"; tx: Candidate; dedupeKey: string }
  | { kind: "duplicate"; tx: Candidate; existingId: string }
  | { kind: "merge"; tx: Candidate; existingId: string; by: "bank_id" | "content_hash"; enrich: Enrichment }
  | { kind: "conflict"; tx: Candidate; existingId: string; fields: string[] }
  | { kind: "possible_duplicate"; tx: Candidate; existingIds: string[]; reason: "content_hash" | "near_duplicate" };

export interface ImportPlan {
  items: PlanItem[];
  counts: {
    total: number;
    new: number;
    duplicates: number;
    merged: number;
    conflicts: number;
    possibleDuplicates: number;
  };
}

/** Bank transaction ID used for keys and cross-source matching: entry reference, else the provider ID. */
export const bankTxId = (t: Pick<ParsedTransaction, "entryReference" | "providerTransactionId">): string | undefined =>
  t.entryReference ?? t.providerTransactionId;

/** BNK-109 content hash input: (account, booking date, value date, amount, currency, counterparty, remittance). */
export function contentHashInput(accountId: string, t: ParsedTransaction): string {
  return [
    accountId,
    t.bookingDate,
    t.valueDate ?? "",
    String(t.amountCents),
    t.currency,
    counterpartyKey(t),
    normaliseText(t.purpose),
  ].join("\u001f");
}

export async function toCandidates(accountId: string, txs: readonly ParsedTransaction[]): Promise<Candidate[]> {
  return Promise.all(
    txs.map(async (t) => ({
      ...t,
      contentHash: await sha256Hex(contentHashInput(accountId, t)),
      rawSha256: await sha256Hex(t.raw),
    })),
  );
}

/** Keys for a file's candidates (ordinals count identical content hashes within the file, BNK-034). */
export function dedupeKeys(accountId: string, candidates: readonly Candidate[]): string[] {
  const ordinals = new Map<string, number>();
  return candidates.map((c) => {
    const id = bankTxId(c);
    if (id) return `${accountId}:er:${id}`;
    const n = ordinals.get(c.contentHash) ?? 0;
    ordinals.set(c.contentHash, n + 1);
    return `${accountId}:h:${c.contentHash}:${n}`;
  });
}

const dayDiff = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

function conflictFields(c: Candidate, e: ExistingBankRow, dateToleranceDays: number): string[] {
  const out: string[] = [];
  if (c.amountCents !== e.amountCents) out.push("Betrag");
  if (c.currency !== e.currency) out.push("Währung");
  if (dayDiff(c.bookingDate, e.bookingDate) > dateToleranceDays) out.push("Buchungsdatum");
  if (c.counterpartyIban && e.counterpartyIban && c.counterpartyIban !== e.counterpartyIban) out.push("IBAN");
  return out;
}

function enrichment(c: Candidate, e: ExistingBankRow): Enrichment {
  return {
    ...(!e.counterpartyName && c.counterpartyName ? { counterpartyName: c.counterpartyName } : {}),
    ...(!e.counterpartyIban && c.counterpartyIban ? { counterpartyIban: c.counterpartyIban } : {}),
    ...(!e.counterpartyBic && c.counterpartyBic ? { counterpartyBic: c.counterpartyBic } : {}),
  };
}

export function planImport(input: {
  accountId: string;
  kind: BankSourceKind;
  candidates: readonly Candidate[];
  existing: readonly ExistingBankRow[];
}): ImportPlan {
  const { accountId, kind, candidates, existing } = input;
  const keys = dedupeKeys(accountId, candidates);
  const byKey = new Map(existing.map((e) => [e.dedupeKey, e]));
  const byBankId = new Map<string, ExistingBankRow>();
  for (const e of existing) for (const id of e.bankTxIds) byBankId.set(id, e);
  const claimed = new Set<string>();
  const items: PlanItem[] = [];
  const occurrences = new Map<string, number>();
  for (const c of candidates) occurrences.set(c.contentHash, (occurrences.get(c.contentHash) ?? 0) + 1);

  for (const [i, c] of candidates.entries()) {
    const key = keys[i] as string;
    const id = bankTxId(c);
    // 1. same key (hash keys only count as the same delivery if this source kind delivered them; another source
    //    with the same content goes through step 3 and its occurrence comparison)
    const sameKey = byKey.get(key);
    if (sameKey && (id !== undefined || sameKey.sourceKinds.includes(kind))) {
      claimed.add(sameKey.id);
      const fields = conflictFields(c, sameKey, sameKey.sourceKinds.includes(kind) ? 0 : 1);
      if (fields.length > 0) items.push({ kind: "conflict", tx: c, existingId: sameKey.id, fields });
      else if (sameKey.sourceKinds.includes(kind)) {
        items.push({ kind: "duplicate", tx: c, existingId: sameKey.id });
      } else
        items.push({ kind: "merge", tx: c, existingId: sameKey.id, by: "bank_id", enrich: enrichment(c, sameKey) });
      continue;
    }
    // 2. same bank transaction ID delivered by another source
    const sameId = id ? byBankId.get(id) : undefined;
    if (sameId) {
      claimed.add(sameId.id);
      const fields = conflictFields(c, sameId, 1);
      if (fields.length > 0) items.push({ kind: "conflict", tx: c, existingId: sameId.id, fields });
      else if (sameId.sourceKinds.includes(kind)) items.push({ kind: "duplicate", tx: c, existingId: sameId.id });
      else items.push({ kind: "merge", tx: c, existingId: sameId.id, by: "bank_id", enrich: enrichment(c, sameId) });
      continue;
    }
    // 3. same content hash on the same day, not yet delivered by this source kind
    const sameHashAll = existing.filter(
      (e) => e.contentHash === c.contentHash && e.bookingDate === c.bookingDate && !e.sourceKinds.includes(kind),
    );
    const sameHash = sameHashAll
      .filter((e) => !claimed.has(e.id))
      .sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey));
    // Occurrence counts equal (the file has as many identical rows as the account) → pair them in order.
    if (sameHash.length > 0 && sameHashAll.length === occurrences.get(c.contentHash)) {
      const e = sameHash[0] as ExistingBankRow;
      claimed.add(e.id);
      items.push({ kind: "merge", tx: c, existingId: e.id, by: "content_hash", enrich: enrichment(c, e) });
      continue;
    }
    if (sameHash.length > 0) {
      items.push({ kind: "possible_duplicate", tx: c, existingIds: sameHash.map((e) => e.id), reason: "content_hash" });
      continue;
    }
    // 4. near-duplicates (same day/amount/currency, compatible counterparty, other text formatting)
    const cp = counterpartyKey(c);
    const near = existing.filter((e) => {
      if (
        claimed.has(e.id) ||
        e.bookingDate !== c.bookingDate ||
        e.amountCents !== c.amountCents ||
        e.currency !== c.currency
      )
        return false;
      const ecp = counterpartyKey(e);
      if (cp && ecp && cp !== ecp && normaliseText(c.counterpartyName) !== normaliseText(e.counterpartyName))
        return false;
      // Same source family with own, different bank IDs: two distinct bookings by the bank's own numbering.
      if (id && e.bankTxIds.length > 0 && e.sourceKinds.includes(kind)) return false;
      return true;
    });
    if (near.length > 0) {
      items.push({ kind: "possible_duplicate", tx: c, existingIds: near.map((e) => e.id), reason: "near_duplicate" });
      continue;
    }
    items.push({ kind: "new", tx: c, dedupeKey: key });
  }

  const count = (k: PlanItem["kind"]) => items.filter((x) => x.kind === k).length;
  return {
    items,
    counts: {
      total: items.length,
      new: count("new"),
      duplicates: count("duplicate"),
      merged: count("merge"),
      conflicts: count("conflict"),
      possibleDuplicates: count("possible_duplicate"),
    },
  };
}
