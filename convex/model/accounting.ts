import type { OpeningBalancePart, OpeningReceivable } from "../../src/domain/accounting/events";
import { openingSourceId } from "../../src/domain/accounting/events";
import { chartAt, fiscalYearEnd, fiscalYearOf, fiscalYearStart } from "../../src/domain/accounting/period";
import { explanationText } from "../../src/domain/accounting/post";
import { roleMappingView } from "../../src/domain/accounting/resolve";
import { roleLabel, STATIC_ROLES } from "../../src/domain/accounting/roles";
import { type ChartAccount, chartAccounts, seededAccount } from "../../src/domain/rules/accounting";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { type CalendarDate, calendarDate, isCalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert } from "./audit";
import { getCompanyProfile, patchCompanyProfile } from "./companyProfile";
import {
  entriesBySource,
  hasJournalEntries,
  type PostJournalResult,
  postJournalEntry,
  resolveContextAt,
  reversalOf,
} from "./journal";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Bookkeeping features around the journal (F08 §6): read views for the journal viewer and the chart of accounts,
 * role mapping overrides (ACC-008), the Buchungsbeginn (ACC-014) and the P1 opening balances (ACC-013).
 * Every journal write goes through `postJournalEntry` (model/journal.ts).
 */

const SOURCE_LABEL: Record<string, string> = {
  salesDocument: "Verkaufsbeleg",
  voucher: "Beleg",
  payment: "Zahlung",
  bankTransaction: "Banktransaktion",
  cashTransfer: "Barbewegung",
  asset_depreciation: "Abschreibung",
  manual: "Manuelle Buchung",
  opening_balance: "Eröffnungsbilanz",
  tax: "Steuer",
  fx: "Kursdifferenz",
  period_close: "Abschluss",
};

async function profileOrThrow(ctx: ReadCtx) {
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  return profile;
}

/** Account name lookup for a date: seeded accounts of the chart plus the bank accounts' names. */
async function accountNamer(ctx: ReadCtx) {
  const profile = await getCompanyProfile(ctx);
  const banks = await ctx.db.query("bankAccounts").collect();
  return (account: string, date: string): string => {
    const chart = chartAt(profile?.chartOfAccounts ?? [], profile?.fiscalYearStartMonth ?? 1, date);
    const bank = banks.find((b) => b.ledgerAccount === account);
    if (bank) return bank.name;
    return seededAccount(chart, calendarDate(date), account)?.name ?? account;
  };
}

// ── journal viewer (F08 §6 /buchhaltung/journal, read-only in P1) ───────────────────────────────────────

export interface JournalLineView {
  account: string;
  accountName: string;
  role?: string;
  roleLabel?: string;
  debitCents: number;
  creditCents: number;
  taxKey?: string;
  taxPointDate?: string;
  contactId?: string;
}

export interface JournalEntryView {
  id: Id<"journalEntries">;
  seq: number;
  date: string;
  period: string;
  originalDate?: string;
  latePostingReason?: string;
  text: string;
  source: { kind: string; id: string; label: string };
  ruleVersion: string;
  roleMappingVersion: string;
  explanation: string;
  explanationText: string;
  totalCents: number;
  lines: JournalLineView[];
  reversalOfSeq?: number;
  reversedBySeq?: number;
  recordedAt: number;
  actor: string;
  locked: boolean;
}

export async function journalEntryView(ctx: ReadCtx, e: Doc<"journalEntries">): Promise<JournalEntryView> {
  const name = await accountNamer(ctx);
  const reversedBy = await reversalOf(ctx, e._id);
  const original = e.reversalOfId ? await ctx.db.get(e.reversalOfId) : null;
  return {
    id: e._id,
    seq: e.seq,
    date: e.date,
    period: e.period,
    ...(e.originalDate ? { originalDate: e.originalDate } : {}),
    ...(e.latePosting ? { latePostingReason: e.latePosting.reason } : {}),
    text: e.text,
    source: { ...e.source, label: SOURCE_LABEL[e.source.kind] ?? e.source.kind },
    ruleVersion: e.ruleVersion,
    roleMappingVersion: e.roleMappingVersion,
    explanation: e.explanation,
    explanationText: explanationText(e.explanation),
    totalCents: e.lines.reduce((s, l) => s + l.debitCents, 0),
    lines: e.lines.map((l) => ({
      account: l.account,
      accountName: name(l.account, e.date),
      ...(l.role ? { role: l.role, roleLabel: roleLabel(l.role) } : {}),
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      ...(l.taxKey ? { taxKey: l.taxKey } : {}),
      ...(l.taxPointDate ? { taxPointDate: l.taxPointDate } : {}),
      ...(l.contactId ? { contactId: l.contactId } : {}),
    })),
    ...(original ? { reversalOfSeq: original.seq } : {}),
    ...(reversedBy ? { reversedBySeq: reversedBy.seq } : {}),
    recordedAt: e.recordedAt,
    actor: e.actor,
    locked: e.lockedAt !== undefined,
  };
}

// ── chart of accounts (F08 §6 /buchhaltung/konten) ──────────────────────────────────────────────────────

export interface AccountView {
  number: string;
  name: string;
  type: ChartAccount["type"] | "bank";
  automaticVatAccount: boolean;
  euerKey: string;
  bwaGroup: string;
  verified: boolean;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
  used: boolean;
  roles: string[];
}

export async function chartView(ctx: ReadCtx, now: number, fiscalYear?: number) {
  const profile = await getCompanyProfile(ctx);
  const startMonth = profile?.fiscalYearStartMonth ?? 1;
  const today = berlinCalendarDate(now);
  const fy = fiscalYear ?? fiscalYearOf(today, startMonth);
  const from = fiscalYearStart(fy, startMonth);
  const to = fiscalYearEnd(fy, startMonth);
  const at: CalendarDate = today >= from && today <= to ? today : to;
  const rctx = await resolveContextAt(ctx, at);
  const seed = chartAccounts(rctx.chart, at);
  const accounts = new Map<string, AccountView>();
  const base = { debitCents: 0, creditCents: 0, balanceCents: 0, used: false, roles: [] as string[] };
  for (const a of seed.ok ? seed.value : []) {
    accounts.set(a.number, {
      number: a.number,
      name: a.name,
      type: a.type,
      automaticVatAccount: a.automaticVatAccount === true,
      euerKey: a.euerKey,
      bwaGroup: a.bwaGroup,
      verified: a.verified,
      ...base,
      roles: [],
    });
  }
  for (const b of await ctx.db.query("bankAccounts").collect()) {
    const existing = accounts.get(b.ledgerAccount);
    if (existing) existing.name = `${existing.name} – ${b.name}`;
    else {
      accounts.set(b.ledgerAccount, {
        number: b.ledgerAccount,
        name: b.name,
        type: "bank",
        automaticVatAccount: false,
        euerKey: "NONE",
        bwaGroup: "NONE",
        verified: true,
        ...base,
        roles: [],
      });
    }
  }
  const lines = await ctx.db
    .query("journalLines")
    .withIndex("by_date", (q) => q.gte("date", from).lte("date", to))
    .collect();
  for (const l of lines) {
    const a = accounts.get(l.account);
    if (!a) continue;
    a.debitCents += l.debitCents;
    a.creditCents += l.creditCents;
    a.balanceCents = a.debitCents - a.creditCents;
    a.used = true;
  }
  const roles = roleMappingView(rctx);
  for (const r of roles) if (r.account) accounts.get(r.account)?.roles.push(r.role);
  return {
    fiscalYear: fy,
    from,
    to,
    chart: rctx.chart,
    accounts: [...accounts.values()].sort((a, b) => a.number.localeCompare(b.number)),
    roles,
    journalEntries: lines.length > 0,
  };
}

// ── role overrides (ACC-008) ────────────────────────────────────────────────────────────────────────────

export async function setRoleOverride(
  ctx: ModelCtx,
  input: { role: string; account: string; validFrom: string; sourceText: string },
): Promise<Id<"accountRoleMappings">> {
  const profile = await profileOrThrow(ctx);
  if (!STATIC_ROLES.includes(input.role)) throw appError("invalid_input", "Unbekannte Kontenrolle.");
  if (!isCalendarDate(input.validFrom))
    throw appError("invalid_input", "Bitte ein gültiges „Gültig ab“-Datum angeben.");
  const sourceText = input.sourceText.trim();
  if (sourceText.length < 5) {
    throw appError("invalid_input", "Bitte eine Begründung bzw. Quelle angeben (mindestens 5 Zeichen).");
  }
  const chart = chartAt(profile.chartOfAccounts, profile.fiscalYearStartMonth, input.validFrom);
  if (!seededAccount(chart, calendarDate(input.validFrom), input.account)) {
    throw appError("account_unknown", `Konto ${input.account} ist im Kontenrahmen ${chart} nicht vorhanden.`);
  }
  const count = (await ctx.db.query("accountRoleMappings").collect()).filter((r) => r.source === "override").length;
  const mappingVersion = `override-${count + 1}`;
  return auditedInsert(
    ctx,
    "accountRoleMappings",
    {
      chart,
      role: input.role,
      account: input.account,
      validFrom: input.validFrom,
      mappingVersion,
      source: "override",
      sourceText,
    },
    { action: "rule_override.add", label: `${roleLabel(input.role)} → ${input.account}`, reason: sourceText },
  );
}

// ── Buchungsbeginn (ACC-014) ────────────────────────────────────────────────────────────────────────────

export async function setBookkeepingStart(ctx: ModelCtx, date: string): Promise<void> {
  const profile = await profileOrThrow(ctx);
  if (!isCalendarDate(date)) throw appError("invalid_input", "Bitte ein gültiges Datum angeben.");
  if (profile.bookkeepingStartDate === date) return;
  // E-ACC-14
  if (await hasJournalEntries(ctx)) throw appError("bookkeeping_start_locked");
  await patchCompanyProfile(ctx, { bookkeepingStartDate: date }, { action: "settings.bookkeeping.update" });
}

// ── opening balances (ACC-013, P1: cash, bank, open receivables) ────────────────────────────────────────

export interface OpeningReceivableInput {
  number: string;
  documentDate: string;
  dueDate?: string;
  counterpartyName: string;
  contactId?: string;
  grossCents: number;
  openCents: number;
  taxedAs: "soll" | "ist";
  notDueVat?: { rateBp: number; vatCents: number }[];
}

export type OpeningPartInput =
  | { kind: "cash"; amountCents: number }
  | { kind: "bank"; bankAccountId: Id<"bankAccounts">; amountCents: number }
  | { kind: "receivables"; items: OpeningReceivableInput[] };

/** The opening date of a fiscal year: the Buchungsbeginn if it lies in that year, else the fiscal-year start. */
export async function openingDate(ctx: ReadCtx, fiscalYear: number): Promise<CalendarDate> {
  const profile = await profileOrThrow(ctx);
  const start = profile.bookkeepingStartDate;
  if (start && isCalendarDate(start) && fiscalYearOf(start, profile.fiscalYearStartMonth) === fiscalYear) return start;
  return fiscalYearStart(fiscalYear, profile.fiscalYearStartMonth);
}

function checkReceivable(i: OpeningReceivableInput): void {
  const bad = (m: string) => {
    throw appError("invalid_input", `${i.number || "Forderung"}: ${m}`);
  };
  if (!i.number.trim()) bad("Bitte die Rechnungsnummer angeben.");
  if (!i.counterpartyName.trim()) bad("Bitte den Kunden angeben.");
  if (!isCalendarDate(i.documentDate)) bad("Bitte ein gültiges Rechnungsdatum angeben.");
  if (!Number.isSafeInteger(i.grossCents) || !Number.isSafeInteger(i.openCents)) bad("Beträge in ganzen Cent.");
  if (i.openCents <= 0 || i.openCents > i.grossCents)
    bad("Der offene Betrag muss zwischen 0 und dem Bruttobetrag liegen.");
  const vat = (i.notDueVat ?? []).reduce((s, v) => s + v.vatCents, 0);
  if (i.taxedAs === "ist" && (vat < 0 || vat >= i.openCents)) {
    bad("Die noch nicht fällige Umsatzsteuer muss kleiner als der offene Betrag sein.");
  }
}

export async function postOpeningBalance(
  ctx: ModelCtx,
  fiscalYear: number,
  part: OpeningPartInput,
): Promise<PostJournalResult> {
  const date = await openingDate(ctx, fiscalYear);
  let eventPart: OpeningBalancePart;
  if (part.kind === "receivables") {
    if (part.items.length === 0) throw appError("invalid_input", "Bitte mindestens eine offene Forderung erfassen.");
    for (const i of part.items) checkReceivable(i);
    const existing = await entriesBySource(ctx, { kind: "opening_balance", id: openingSourceId(fiscalYear, part) });
    for (const e of existing) {
      if (!(await reversalOf(ctx, e._id))) {
        throw appError("already_posted", `Für ${fiscalYear} sind bereits Saldenvorträge erfasst.`);
      }
    }
    const items: OpeningReceivable[] = [];
    for (const i of part.items) {
      const id = await auditedInsert(
        ctx,
        "openingItems",
        {
          fiscalYear,
          kind: "receivable",
          number: i.number.trim(),
          documentDate: i.documentDate,
          ...(i.dueDate ? { dueDate: i.dueDate } : {}),
          ...(i.contactId ? { contactId: i.contactId } : {}),
          counterpartyName: i.counterpartyName.trim(),
          grossCents: i.grossCents,
          openCents: i.openCents,
          taxedAs: i.taxedAs,
          ...(i.taxedAs === "ist" && i.notDueVat?.length ? { notDueVat: i.notDueVat } : {}),
          openAmountCents: i.openCents,
          recordedAt: ctx.now(),
          actor: ctx.actor,
        },
        { action: "journal.opening_balance", label: `Offener Posten ${i.number}` },
      );
      items.push({
        openingItemId: id,
        number: i.number.trim(),
        ...(i.contactId ? { contactId: i.contactId } : {}),
        openCents: i.openCents,
        taxedAs: i.taxedAs,
        ...(i.taxedAs === "ist" && i.notDueVat?.length ? { notDueVat: i.notDueVat } : {}),
      });
    }
    eventPart = { kind: "receivables", items };
  } else if (part.kind === "bank") {
    const bank = await ctx.db.get(part.bankAccountId);
    if (!bank || bank.archivedAt !== undefined) throw appError("not_found", "Das Bankkonto ist nicht eingerichtet.");
    eventPart = { kind: "bank", bankAccountId: part.bankAccountId, amountCents: part.amountCents };
  } else {
    eventPart = part;
  }
  return postJournalEntry(ctx, { kind: "opening_balance", fiscalYear, date, part: eventPart });
}

/** Wizard state; without `fiscalYear` the year of the Buchungsbeginn (or of today) is shown. */
export async function openingStatus(ctx: ReadCtx, now: number, requestedYear?: number) {
  const profile = await profileOrThrow(ctx);
  const start = profile.bookkeepingStartDate;
  const fiscalYear =
    requestedYear ??
    fiscalYearOf(start && isCalendarDate(start) ? start : berlinCalendarDate(now), profile.fiscalYearStartMonth);
  const date = await openingDate(ctx, fiscalYear);
  const posted = async (part: OpeningBalancePart) => {
    for (const e of await entriesBySource(ctx, { kind: "opening_balance", id: openingSourceId(fiscalYear, part) })) {
      if (!(await reversalOf(ctx, e._id)))
        return { seq: e.seq, totalCents: e.lines.reduce((s, l) => s + l.debitCents, 0) };
    }
    return null;
  };
  const banks = (await ctx.db.query("bankAccounts").collect()).filter((b) => b.archivedAt === undefined);
  const items = await ctx.db
    .query("openingItems")
    .withIndex("by_fiscalYear", (q) => q.eq("fiscalYear", fiscalYear))
    .collect();
  return {
    fiscalYear,
    date,
    bookkeepingStartDate: profile.bookkeepingStartDate ?? null,
    canChangeBookkeepingStart: !(await hasJournalEntries(ctx)),
    cash: await posted({ kind: "cash", amountCents: 0 }),
    banks: await Promise.all(
      banks.map(async (b) => ({
        id: b._id,
        name: b.name,
        iban: b.iban ?? null,
        currency: b.currency,
        ledgerAccount: b.ledgerAccount,
        posted: await posted({ kind: "bank", bankAccountId: b._id, amountCents: 0 }),
      })),
    ),
    receivables: await posted({ kind: "receivables", items: [] }),
    openingItems: items.map((i) => ({
      id: i._id,
      number: i.number,
      counterpartyName: i.counterpartyName,
      documentDate: i.documentDate,
      openCents: i.openCents,
      taxedAs: i.taxedAs,
    })),
  };
}
