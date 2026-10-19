import { z } from "zod";
import { decodeId, encodeId, encodeOptionalId } from "@/domain/api/ids";
import { isoDate, prefixedId, toOptionalInstant } from "./common";

/**
 * F07 §7.1 wire shapes of the Enable Banking connection (`GET /bank-connection`, no secrets — BNK-013) and the
 * matching rules (`/matching-rules`, BNK-050…054). The rule action is called `apply` on the wire as in the store
 * (03 `matchingRules.then`: an object with a `then` member is a thenable in JavaScript).
 */

// ── connection ─────────────────────────────────────────────────────────────────────────────────────────

const connectionAccountOut = z.object({
  id: z.string(),
  name: z.string(),
  currency: z.string(),
  iban: z.string().nullable(),
  linked: z.boolean(),
  missing: z.boolean(),
  last_polled_at: z.string().nullable(),
  unattended_fetches_today: z.number().int(),
  unattended_limit: z.number().int(),
  backoff_until: z.string().nullable(),
  pending_count: z.number().int(),
});

export const bankConnectionOut = z
  .object({
    provider: z.literal("enable_banking"),
    status: z.enum(["not_configured", "pending_consent", "active", "reauth_required", "error", "disconnected"]),
    status_label: z.string(),
    configured: z.boolean(),
    environment: z.enum(["production", "sandbox"]),
    application_id: z.string().nullable(),
    key_stored: z.boolean().meta({ description: "Der private Schlüssel ist verschlüsselt hinterlegt (nie abrufbar)." }),
    redirect_url: z.string().nullable(),
    aspsp: z.object({ name: z.string(), country: z.string() }).nullable(),
    valid_until: z.string().nullable(),
    validity: z.string().nullable(),
    banner: z.string().nullable(),
    reminders_sent: z
      .array(z.number().int())
      .meta({ description: "Tage vor Ablauf, zu denen erinnert wurde (14, 3, 0)" }),
    last_successful_poll_at: z.string().nullable(),
    next_poll_at: z.string().nullable(),
    last_error: z.string().nullable(),
    feed_lost: z.boolean(),
    accounts: z.array(connectionAccountOut),
  })
  .meta({ id: "BankConnection" });

export interface ConnectionViewRecord {
  status: z.infer<typeof bankConnectionOut>["status"];
  statusLabel: string;
  configured: boolean;
  environment: "production" | "sandbox";
  applicationId: string | null;
  keyStored: boolean;
  redirectUrl: string | null;
  aspsp: { name: string; country: string } | null;
  validUntil: number | null;
  validity: string | null;
  banner: string | null;
  remindersSent?: number[];
  lastSuccessfulPollAt: number | null;
  nextPollAt: number | null;
  lastError: string | null;
  feedLost: unknown;
  accounts: {
    id: string;
    name: string;
    currency: string;
    iban: string | null;
    linked: boolean;
    missing: boolean;
    lastPolledAt: number | null;
    unattendedToday: number;
    unattendedLimit: number;
    backoffUntil: number | null;
    pending: number;
  }[];
}

export function serializeConnection(c: ConnectionViewRecord): z.infer<typeof bankConnectionOut> {
  return {
    provider: "enable_banking",
    status: c.status,
    status_label: c.statusLabel,
    configured: c.configured,
    environment: c.environment,
    application_id: c.applicationId,
    key_stored: c.keyStored,
    redirect_url: c.redirectUrl,
    aspsp: c.aspsp,
    valid_until: toOptionalInstant(c.validUntil),
    validity: c.validity,
    banner: c.banner,
    reminders_sent: c.remindersSent ?? [],
    last_successful_poll_at: toOptionalInstant(c.lastSuccessfulPollAt),
    next_poll_at: toOptionalInstant(c.nextPollAt),
    last_error: c.lastError,
    feed_lost: !!c.feedLost,
    accounts: c.accounts.map((a) => ({
      id: encodeId("bankAccounts", a.id),
      name: a.name,
      currency: a.currency,
      iban: a.iban,
      linked: a.linked,
      missing: a.missing,
      last_polled_at: toOptionalInstant(a.lastPolledAt),
      unattended_fetches_today: a.unattendedToday,
      unattended_limit: a.unattendedLimit,
      backoff_until: toOptionalInstant(a.backoffUntil),
      pending_count: a.pending,
    })),
  };
}

// ── matching rules ─────────────────────────────────────────────────────────────────────────────────────

export const ruleWhenWire = z
  .object({
    account_id: prefixedId("bankAccounts").optional(),
    direction: z.enum(["in", "out"]).optional(),
    currency: z.string().length(3).optional(),
    bank_transaction_code: z.string().max(60).optional(),
    proprietary_code: z.string().max(60).optional(),
    purpose_contains: z.string().max(200).optional(),
    purpose_regex: z
      .string()
      .max(200)
      .optional()
      .meta({ description: "RE2-sicher, höchstens 200 Zeichen (EC-BNK-70)" }),
    counterparty_contains: z.string().max(200).optional(),
    iban_equals: z.string().max(34).optional(),
    merchant_contains: z.string().max(200).optional(),
    mcc_in: z
      .array(z.string().regex(/^\d{4}$/))
      .max(50)
      .optional(),
    amount_min_cents: z.number().int().optional().meta({ description: "Betrag (Absolutwert) in Cent" }),
    amount_max_cents: z.number().int().optional(),
  })
  .meta({ id: "MatchingRuleConditions", description: "Alle angegebenen Bedingungen müssen zutreffen." });

export const ruleApplyWire = z
  .object({
    action: z.enum(["categorize", "private", "transfer", "link_contact", "ignore", "loan"]),
    account: z.string().max(10).optional().meta({ description: "Sachkonto (categorize)" }),
    tax_rule: z.string().max(40).optional(),
    contact_id: prefixedId("contacts").optional(),
    transfer_target: z
      .union([
        z.object({ kind: z.literal("bank"), account_id: prefixedId("bankAccounts") }),
        z.object({ kind: z.literal("cash") }),
      ])
      .optional(),
    loan_account: z.string().max(10).optional(),
    interest_account: z.string().max(10).optional(),
    statement_suffices_as_voucher: z
      .boolean()
      .optional()
      .meta({ description: "„Kontoauszug genügt als Beleg“ (nur in der Oberfläche als Automatik wirksam)" }),
  })
  .meta({ id: "MatchingRuleAction" });

export const ruleWire = z
  .object({
    name: z.string().min(1).max(120),
    priority: z.number().int().min(0).max(100_000).default(100),
    enabled: z.boolean().default(true),
    mode: z
      .enum(["suggest", "auto"])
      .optional()
      .meta({ description: "Über die API immer `suggest` (BNK-054); Automatik nur in der Oberfläche" }),
    when: ruleWhenWire,
    apply: ruleApplyWire,
  })
  .meta({ id: "MatchingRuleRequest" });

export const rulePatchWire = ruleWire.partial().meta({ id: "MatchingRulePatch" });

export const ruleOut = z
  .object({
    id: z.string(),
    name: z.string(),
    priority: z.number().int(),
    enabled: z.boolean(),
    mode: z.enum(["suggest", "auto"]),
    when: ruleWhenWire,
    apply: ruleApplyWire,
    created_via: z.string(),
    hits_90_days: z.number().int().nullable(),
    warning: z.string().nullable(),
  })
  .meta({ id: "MatchingRule" });

export const rulePreviewWire = z.object({ when: ruleWhenWire }).meta({ id: "MatchingRulePreviewRequest" });

export const rulePreviewOut = z
  .object({
    count: z.number().int(),
    message: z.string(),
    hits: z.array(
      z.object({
        transaction_id: z.string(),
        account_id: z.string(),
        booking_date: isoDate,
        amount_cents: z.number().int(),
        currency: z.string(),
        counterparty_name: z.string().nullable(),
        purpose: z.string(),
        status: z.string(),
      }),
    ),
  })
  .meta({ id: "MatchingRulePreview" });

type Dropped<T> = { [K in keyof T]: Exclude<T[K], undefined> };
const compact = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<Dropped<T>>;

/** Store shapes (raw Convex ids) — mirrors `vRuleWhen` / `vRuleApply`. */
export interface RuleWhenRecord {
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
export interface RuleApplyRecord {
  action: z.infer<typeof ruleApplyWire>["action"];
  account?: string;
  taxRule?: string;
  contactId?: string;
  transferTarget?: { kind: "bank"; accountId: string } | { kind: "cash" };
  loanAccount?: string;
  interestAccount?: string;
  createVoucher?: boolean;
  statementSufficesAsVoucher?: boolean;
}
export interface RuleRecord {
  _id: string;
  name: string;
  priority: number;
  enabled: boolean;
  mode: "suggest" | "auto";
  when: RuleWhenRecord;
  apply: RuleApplyRecord;
  createdVia: string;
  hits90?: number;
}

/** Wire → store; null when a prefixed id does not decode (→ 404/422 by the caller). */
export function ruleWhenArgs(w: z.infer<typeof ruleWhenWire>): RuleWhenRecord | null {
  const accountId = w.account_id ? decodeId("bankAccounts", w.account_id) : undefined;
  if (accountId === null) return null;
  return compact({
    accountId,
    direction: w.direction,
    currency: w.currency?.toUpperCase(),
    bankTransactionCode: w.bank_transaction_code,
    proprietaryCode: w.proprietary_code,
    purposeContains: w.purpose_contains,
    purposeRegex: w.purpose_regex,
    counterpartyContains: w.counterparty_contains,
    ibanEquals: w.iban_equals?.replace(/\s+/g, "").toUpperCase(),
    merchantContains: w.merchant_contains,
    mccIn: w.mcc_in,
    amountMinCents: w.amount_min_cents,
    amountMaxCents: w.amount_max_cents,
  }) as RuleWhenRecord;
}

export function ruleApplyArgs(a: z.infer<typeof ruleApplyWire>): RuleApplyRecord | null {
  const contactId = a.contact_id ? decodeId("contacts", a.contact_id) : undefined;
  if (contactId === null) return null;
  let transferTarget: RuleApplyRecord["transferTarget"];
  if (a.transfer_target?.kind === "bank") {
    const id = decodeId("bankAccounts", a.transfer_target.account_id);
    if (!id) return null;
    transferTarget = { kind: "bank", accountId: id };
  } else if (a.transfer_target) transferTarget = { kind: "cash" };
  return compact({
    action: a.action,
    account: a.account,
    taxRule: a.tax_rule,
    contactId,
    transferTarget,
    loanAccount: a.loan_account,
    interestAccount: a.interest_account,
    statementSufficesAsVoucher: a.statement_suffices_as_voucher,
  }) as RuleApplyRecord;
}

export function serializeRule(r: RuleRecord, warning: string | null = null): z.infer<typeof ruleOut> {
  const w = r.when;
  const a = r.apply;
  return {
    id: encodeId("matchingRules", r._id),
    name: r.name,
    priority: r.priority,
    enabled: r.enabled,
    mode: r.mode,
    when: compact({
      account_id: encodeOptionalId("bankAccounts", w.accountId) ?? undefined,
      direction: w.direction,
      currency: w.currency,
      bank_transaction_code: w.bankTransactionCode,
      proprietary_code: w.proprietaryCode,
      purpose_contains: w.purposeContains,
      purpose_regex: w.purposeRegex,
      counterparty_contains: w.counterpartyContains,
      iban_equals: w.ibanEquals,
      merchant_contains: w.merchantContains,
      mcc_in: w.mccIn,
      amount_min_cents: w.amountMinCents,
      amount_max_cents: w.amountMaxCents,
    }),
    apply: {
      action: a.action,
      ...compact({
        account: a.account,
        tax_rule: a.taxRule,
        contact_id: encodeOptionalId("contacts", a.contactId) ?? undefined,
        transfer_target: a.transferTarget
          ? a.transferTarget.kind === "bank"
            ? { kind: "bank" as const, account_id: encodeId("bankAccounts", a.transferTarget.accountId) }
            : { kind: "cash" as const }
          : undefined,
        loan_account: a.loanAccount,
        interest_account: a.interestAccount,
        statement_suffices_as_voucher: a.statementSufficesAsVoucher,
      }),
    },
    created_via: r.createdVia,
    hits_90_days: r.hits90 ?? null,
    warning,
  };
}

export interface RulePreviewRecord {
  count: number;
  message: string;
  hits: {
    id: string;
    accountId: string;
    bookingDate: string;
    amountCents: number;
    currency: string;
    counterpartyName: string | null;
    purpose: string;
    status: string;
  }[];
}

export function serializeRulePreview(p: RulePreviewRecord): z.infer<typeof rulePreviewOut> {
  return {
    count: p.count,
    message: p.message,
    hits: p.hits.map((h) => ({
      transaction_id: encodeId("bankTransactions", h.id),
      account_id: encodeId("bankAccounts", h.accountId),
      booking_date: h.bookingDate,
      amount_cents: h.amountCents,
      currency: h.currency,
      counterparty_name: h.counterpartyName,
      purpose: h.purpose,
      status: h.status,
    })),
  };
}
