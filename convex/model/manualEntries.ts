import {
  buildManualLines,
  MANUAL_TEMPLATES,
  type ManualContext,
  type ManualIssue,
  type ManualLineInput,
} from "../../src/domain/accounting/manual-entry";
import { postableAccounts, resolveRole } from "../../src/domain/accounting/resolve";
import { STATIC_ROLES } from "../../src/domain/accounting/roles";
import { type CalendarDate, isCalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError, type ErrorCode } from "../lib/errors";
import { auditedInsert } from "./audit";
import { fileRefFromStorage } from "./bankImport";
import { postJournalEntry, resolveContextAt } from "./journal";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Manual journal entries (F08 ACC-011, GOBD-07; E-ACC-01/02/04/05/10/11). The pure rules live in
 * src/domain/accounting/manual-entry.ts; this module resolves the accounts of the posting date, stores the entry
 * as entered (`manualEntries`, append-only) and posts it (`manual:<id>`, user-dated → refused in a locked period).
 * A correction is the „Gegenbuchung“: the Generalumkehr of the entry on a date the user picks in an open period.
 */

export interface ManualEntryArgs {
  date: string;
  text: string;
  longText?: string;
  templateKey?: string;
  lines: ManualLineInput[];
  attachments: { storageId: Id<"_storage">; name: string }[];
  acknowledgedWarnings?: string[];
}

const ISSUE_ERROR: Record<ManualIssue["code"], ErrorCode> = {
  "E-ACC-01": "invalid_input",
  "E-ACC-02": "invalid_input",
  "E-ACC-10": "invalid_input",
  "E-ACC-11": "invalid_input",
  manual_invalid: "invalid_input",
  rule_missing: "posting_rejected",
};

/** Account type lookup and VAT accounts of the chart valid on `date` (bank ledgers count as `bank`). */
async function manualContextAt(ctx: ReadCtx, date: CalendarDate, acknowledged: readonly string[]) {
  const rctx = await resolveContextAt(ctx, date);
  const accounts = postableAccounts(rctx);
  if (!accounts.ok) throw appError("posting_rejected", accounts.error.message);
  const banks = new Set(rctx.bankAccounts.filter((b) => !b.archived).map((b) => b.ledgerAccount));
  const vatAccounts = new Set<string>();
  for (const role of STATIC_ROLES.filter((r) => r.startsWith("vat."))) {
    const r = resolveRole(role, rctx);
    if (r.ok && r.value.account) vatAccounts.add(r.value.account);
  }
  const mctx: ManualContext = {
    accountType: (nr) => {
      if (banks.has(nr)) return "bank";
      if (!accounts.value.has(nr)) return null;
      return accounts.value.get(nr)?.type ?? "bank";
    },
    vatAccounts,
    acknowledged,
  };
  return { rctx, mctx };
}

async function costCenterRef(ctx: ReadCtx, id: string): Promise<Id<"costCenters">> {
  const ref = ctx.db.normalizeId("costCenters", id);
  if (!ref || !(await ctx.db.get(ref))) throw appError("invalid_input", "Die Kostenstelle existiert nicht.");
  return ref;
}

async function contactRef(ctx: ReadCtx, id: string): Promise<Id<"contacts">> {
  const ref = ctx.db.normalizeId("contacts", id);
  if (!ref || !(await ctx.db.get(ref))) throw appError("invalid_input", "Der Kontakt der Buchung existiert nicht.");
  return ref;
}

export async function createManualEntry(
  ctx: ModelCtx,
  args: ManualEntryArgs,
): Promise<{ manualEntryId: Id<"manualEntries">; entryId: Id<"journalEntries">; seq: number }> {
  if (!isCalendarDate(args.date)) throw appError("invalid_input", "Bitte ein gültiges Buchungsdatum angeben.");
  if (args.attachments.length > 10) throw appError("invalid_input", "Höchstens 10 Belege je Buchung.");
  const acknowledged = args.acknowledgedWarnings ?? [];
  const { mctx } = await manualContextAt(ctx, args.date, acknowledged);
  const built = buildManualLines(
    { date: args.date, text: args.text, lines: args.lines, attachmentCount: args.attachments.length },
    mctx,
  );
  if (!built.ok) {
    throw appError(ISSUE_ERROR[built.error.code], built.error.message, { reason: built.error.code });
  }
  if (built.value.warnings.length > 0) {
    throw appError("invalid_input", built.value.warnings.map((w) => w.message).join(" "), {
      reason: "WARNINGS_UNACKNOWLEDGED",
      warnings: built.value.warnings.map((w) => w.code).join(","),
    });
  }
  const lines: Doc<"manualEntries">["lines"] = [];
  for (const l of args.lines) {
    lines.push({
      account: l.account,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      ...(l.taxKey ? { taxKey: l.taxKey } : {}),
      ...(l.costCenterId ? { costCenterId: await costCenterRef(ctx, l.costCenterId) } : {}),
      ...(l.contactId ? { contactId: await contactRef(ctx, l.contactId) } : {}),
    });
  }
  const files = await Promise.all(args.attachments.map((a) => fileRefFromStorage(ctx, a.storageId, a.name)));
  const text = args.text.trim();
  const manualEntryId = await auditedInsert(
    ctx,
    "manualEntries",
    {
      date: args.date,
      text,
      ...(args.longText?.trim() ? { longText: args.longText.trim() } : {}),
      ...(args.templateKey ? { templateKey: args.templateKey } : {}),
      lines,
      attachments: files,
      ...(acknowledged.length > 0 ? { acknowledgedWarnings: [...acknowledged] } : {}),
      recordedAt: ctx.now(),
      actor: ctx.actor,
    },
    { action: "journal.manual", label: text },
  );
  const posted = await postJournalEntry(
    ctx,
    { kind: "manual_entry", manualEntryId, date: args.date, text, lines: built.value.lines },
    { attachments: files, ...(args.longText?.trim() ? { longText: args.longText.trim() } : {}) },
  );
  if (posted.status !== "posted") {
    throw appError(
      "invalid_input",
      posted.reason === "before_bookkeeping_start"
        ? "Das Buchungsdatum liegt vor dem Buchungsbeginn."
        : "Die Buchung ergibt keine Journalzeilen.",
      { reason: posted.reason },
    );
  }
  const entry = posted.entries[0];
  if (!entry) throw appError("posting_rejected");
  return { manualEntryId, entryId: entry.entryId, seq: entry.seq };
}

/** „Gegenbuchung“ (F08 §6): Generalumkehr of a manual entry on a user-chosen date (E-ACC-04 locked, E-ACC-05 twice). */
export async function reverseManualEntry(
  ctx: ModelCtx,
  args: { entryId: Id<"journalEntries">; date: string; reason: string },
): Promise<{ entryId: Id<"journalEntries">; seq: number }> {
  const original = await ctx.db.get(args.entryId);
  if (!original) throw appError("not_found", "Die Buchung existiert nicht.");
  if (original.source.kind !== "manual") {
    throw appError("invalid_input", "Eine Gegenbuchung ist nur für manuelle Buchungen möglich.", {
      reason: "NOT_MANUAL",
    });
  }
  if (original.reversalOfId) throw appError("already_reversed", "Eine Gegenbuchung kann nicht storniert werden.");
  if (!isCalendarDate(args.date)) throw appError("invalid_input", "Bitte ein gültiges Buchungsdatum angeben.");
  const reason = args.reason.trim();
  if (reason.length === 0) throw appError("invalid_input", "Bitte einen Grund für die Gegenbuchung angeben.");
  const posted = await postJournalEntry(
    ctx,
    { kind: "manual_entry_reversed", manualEntryId: original.source.id, date: args.date, reason },
    { dating: "user", longText: reason },
  );
  if (posted.status !== "posted") throw appError("already_reversed");
  const entry = posted.entries[0];
  if (!entry) throw appError("posting_rejected");
  return { entryId: entry.entryId, seq: entry.seq };
}

export interface ManualTemplateView {
  key: string;
  label: string;
  text: string;
  hint?: string;
  lines: { side: "debit" | "credit"; account: string | null; taxKey?: string }[];
}

/** ACC-011 templates with the accounts resolved for `date` (role mapping, default EUR bank account, chart). */
export async function manualTemplatesAt(ctx: ReadCtx, date: CalendarDate): Promise<ManualTemplateView[]> {
  const rctx = await resolveContextAt(ctx, date);
  const banks = await ctx.db.query("bankAccounts").collect();
  const bank =
    banks.find((b) => b.archivedAt === undefined && b.currency === "EUR" && b.isDefaultForInvoices)?.ledgerAccount ??
    null;
  return MANUAL_TEMPLATES.map((t) => ({
    key: t.key,
    label: t.label,
    text: t.text,
    ...(t.hint ? { hint: t.hint } : {}),
    lines: t.lines.map((l) => {
      let account: string | null = null;
      if (l.bank) account = bank;
      else if (l.accounts) account = l.accounts[rctx.chart];
      else if (l.role) {
        const r = resolveRole(l.role, rctx);
        account = r.ok ? r.value.account : null;
      }
      return { side: l.side, account, ...(l.taxKey ? { taxKey: l.taxKey } : {}) };
    }),
  }));
}
