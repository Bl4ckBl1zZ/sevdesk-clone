/**
 * Account mapping after every consent (F07 BNK-104, SET-050a, SET-050c; EC-BNK-84/91/92, EC-159). Enable Banking
 * account `uid`s are session-specific, so a consent is mapped to the existing `bank` accounts by **IBAN**, else by the
 * stable `identification_hash` — never by `uid`. Pure: the caller passes the accounts of the new session and the
 * existing accounts.
 */
import { normaliseIban } from "../normalise";
import { accountClosed, accountIban, accountLocalDetails, type EbAccount } from "../sources/enable-banking";
import { FEED_MESSAGES } from "./messages";

export interface ExistingAccount {
  id: string;
  name: string;
  currency: string;
  iban?: string;
  accountHolder?: string;
  archived?: boolean;
  feed?: { connectionId?: string; identificationHash?: string };
}

export interface SessionAccountView {
  uid: string;
  identificationHash?: string;
  iban?: string;
  currency: string;
  name?: string;
  holderName?: string;
  localDetails: { scheme: string; identification: string }[];
  closed: boolean;
}

export type MappingProposal =
  | { uid: string; account: SessionAccountView; kind: "matched"; accountId: string; by: "iban" | "identification_hash" }
  | { uid: string; account: SessionAccountView; kind: "new"; message: string };

export interface AccountChange {
  accountId: string;
  field: "iban" | "accountHolder";
  before?: string;
  after: string;
}

export interface RemapResult {
  proposals: MappingProposal[];
  /** Previously linked accounts that are missing from the new consent (EC-BNK-92). */
  missing: { accountId: string; message: string }[];
  /** SET-050c: IBAN / holder name changes the bank reported for matched accounts (future documents only). */
  changes: AccountChange[];
  /** SET-050c: matched accounts the bank reports as closed. */
  closed: string[];
}

export function sessionAccountView(a: EbAccount): SessionAccountView {
  const iban = accountIban(a);
  const hash = a.identification_hash ?? a.identification_hashes?.[0] ?? undefined;
  return {
    uid: a.uid,
    ...(hash ? { identificationHash: hash } : {}),
    ...(iban ? { iban } : {}),
    currency: (a.currency ?? "EUR").toUpperCase(),
    ...(a.name ? { holderName: a.name } : {}),
    ...(a.product || a.details ? { name: String(a.product ?? a.details) } : {}),
    localDetails: accountLocalDetails(a),
    closed: accountClosed(a),
  };
}

export function remapAccounts(input: {
  connectionId: string;
  sessionAccounts: readonly EbAccount[];
  existing: readonly ExistingAccount[];
}): RemapResult {
  const live = input.existing.filter((e) => !e.archived);
  const claimed = new Set<string>();
  const proposals: MappingProposal[] = [];
  const changes: AccountChange[] = [];
  const closed: string[] = [];
  for (const raw of input.sessionAccounts) {
    const a = sessionAccountView(raw);
    let hit: ExistingAccount | undefined;
    let by: "iban" | "identification_hash" = "iban";
    if (a.iban) {
      hit = live.find(
        (e) => !claimed.has(e.id) && e.iban && normaliseIban(e.iban) === a.iban && e.currency === a.currency,
      );
    }
    if (!hit && a.identificationHash) {
      hit = live.find((e) => !claimed.has(e.id) && e.feed?.identificationHash === a.identificationHash);
      by = "identification_hash";
    }
    if (!hit) {
      proposals.push({ uid: a.uid, account: a, kind: "new", message: FEED_MESSAGES.newAccount(a.currency) });
      continue;
    }
    claimed.add(hit.id);
    proposals.push({ uid: a.uid, account: a, kind: "matched", accountId: hit.id, by });
    if (a.iban && (!hit.iban || normaliseIban(hit.iban) !== a.iban))
      changes.push({ accountId: hit.id, field: "iban", ...(hit.iban ? { before: hit.iban } : {}), after: a.iban });
    if (a.holderName && hit.accountHolder !== undefined && hit.accountHolder.trim() !== a.holderName.trim())
      changes.push({ accountId: hit.id, field: "accountHolder", before: hit.accountHolder, after: a.holderName });
    if (a.closed) closed.push(hit.id);
  }
  const missing = live
    .filter((e) => e.feed?.connectionId === input.connectionId && !claimed.has(e.id))
    .map((e) => ({ accountId: e.id, message: FEED_MESSAGES.missingAccount(e.name) }));
  return { proposals, missing, changes, closed };
}
