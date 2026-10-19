/**
 * Bank feed adapter boundary (F07 BNK-100). A thin internal interface so the feed is testable against a fake HTTP
 * server; **only the Enable Banking implementation exists** (`./enable-banking.ts`). Every row a provider returns is
 * mapped by the pure domain (`src/domain/banking/sources/enable-banking.ts`) into the one normalised
 * `ParsedTransaction` model shared with CAMT.053 / MT940 / CSV (CLAUDE.md rule 5).
 *
 * No `import "server-only"`: the Convex actions (convex/bankFeedNode.ts) import this module.
 */
import type { EbAccount, EbAmount, EbTransaction } from "../../src/domain/banking/sources/enable-banking";

export interface Aspsp {
  name: string;
  country: string;
  /** Seconds (Enable Banking `maximum_consent_validity`). */
  maximumConsentValidity?: number;
  psuTypes?: string[];
  sandbox?: boolean;
  beta?: boolean;
}

/** PSU headers of an owner-present request (BNK-107): the call then does not use the unattended budget. */
export interface PsuHeaders {
  ipAddress?: string;
  userAgent?: string;
}

export interface ConsentStart {
  aspsp: { name: string; country: string };
  validUntil: number;
  redirectUrl: string;
  state: string;
  psuType: "business" | "personal";
}

export interface ConsentSession {
  sessionId: string;
  accounts: EbAccount[];
  validUntil?: number;
  aspsp?: { name: string; country: string };
}

export interface FetchOptions {
  dateFrom: string;
  dateTo?: string;
  strategy: "default" | "longest";
  psu?: PsuHeaders;
  /** Stop paging after this instant (callback backfill timeout, EC-BNK-88). */
  deadline?: number;
  /** Called after every page (progress, incremental writes). */
  onPage?: (page: EbTransaction[], index: number) => Promise<void> | void;
}

export interface FetchResult {
  transactions: EbTransaction[];
  pages: number;
  /** All pages were fetched (no continuation key left). */
  complete: boolean;
}

export interface Balance {
  name?: string;
  balanceAmount: EbAmount;
  balanceType?: string;
  referenceDate?: string;
}

export interface ConsentStatus {
  status: string;
  validUntil?: number;
  accounts: string[];
}

export interface BankFeedProvider {
  readonly kind: "enable_banking";
  listAspsps(country?: string): Promise<Aspsp[]>;
  startConsent(input: ConsentStart): Promise<{ url: string; authorizationId?: string }>;
  completeConsent(code: string): Promise<ConsentSession>;
  listAccounts(sessionId: string): Promise<EbAccount[]>;
  fetchTransactions(accountUid: string, options: FetchOptions): Promise<FetchResult>;
  fetchBalances(accountUid: string, psu?: PsuHeaders): Promise<Balance[]>;
  consentStatus(sessionId: string): Promise<ConsentStatus>;
  /** BNK-011: `DELETE /sessions/{id}`. */
  revokeSession(sessionId: string): Promise<void>;
}

/** A failed provider call; `message` is already redacted (BNK-013). */
export class FeedHttpError extends Error {
  readonly status: number | undefined;
  readonly error: string | undefined;
  constructor(message: string, opts: { status?: number; error?: string }) {
    super(message);
    this.name = "FeedHttpError";
    this.status = opts.status;
    this.error = opts.error;
  }
}
