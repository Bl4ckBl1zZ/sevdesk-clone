import { computeInterestClaim, interestClaimLetter } from "../../src/domain/dunning/interest-claim";
import { mahnbescheidData, mahnbescheidSheet } from "../../src/domain/dunning/mahnbescheid";
import { paymentConfirmationLetter } from "../../src/domain/payments/confirmation";
import type { LetterCompany, LetterContent, LetterKind, LetterRecipient } from "../../src/domain/receivables/letter";
import {
  accountStatementLetter,
  buildAccountStatement,
  type StatementDocKind,
} from "../../src/domain/receivables/statement";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { type CalendarDate, formatGermanDate, isCalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import { defaultStartFor, evaluationContext, loadInvoiceState, remindersOf } from "./dunning";
import { documentSettlement, paymentsOfTarget } from "./payments";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Receivables letters (F05 PAY-005, PAY-048, DUN-028, DUN-044) — the only writer of `receivableLetters`. The content
 * is computed by the pure builders in src/domain (statement, confirmation, interest claim, Mahnbescheid); the Convex
 * action renders it with src/pdf/letter.ts, archives the PDF here (sha256, audit) and returns it for the export. The
 * letter is never sent by the app (B2); `markLetterSent` records the manual dispatch once.
 */

export type LetterRequest =
  | { kind: "account_statement"; contactId: Id<"contacts">; from: string; to: string; confirmationRequest?: boolean }
  | {
      kind: "payment_confirmation";
      paymentId: Id<"payments">;
      lang?: "de" | "en";
      subject?: string;
      body?: string;
    }
  | { kind: "interest_claim"; invoiceId: Id<"salesDocuments"> }
  | { kind: "mahnbescheid_sheet"; invoiceId: Id<"salesDocuments"> };

export interface PlannedLetter {
  content: LetterContent;
  /** DUN-044 JSON export. */
  data?: string;
  links: { contactId?: Id<"contacts">; documentId?: Id<"salesDocuments">; paymentId?: Id<"payments"> };
}

const SALUTATION = "Sehr geehrte Damen und Herren";
const INVOICE_KINDS = new Set([
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
  "correction",
  "cancellation",
]);

async function letterCompany(ctx: ReadCtx): Promise<LetterCompany> {
  const p = await getCompanyProfile(ctx);
  if (!p) throw appError("setup_incomplete");
  const accounts = (await ctx.db.query("bankAccounts").collect())
    .filter((a) => a.showOnInvoices && a.archivedAt === undefined && a.currency === "EUR")
    .sort((a, b) => Number(b.isDefaultForInvoices) - Number(a.isDefaultForInvoices))
    .map((a) => ({
      ...(a.name ? { name: a.name } : {}),
      ...(a.iban ? { iban: a.iban } : {}),
      ...(a.bic ? { bic: a.bic } : {}),
      accountHolder: a.accountHolder,
    }));
  return {
    legalForm: p.legalForm,
    name: p.name,
    ...(p.tradeName ? { tradeName: p.tradeName } : {}),
    address: {
      street: p.address.street,
      postalCode: p.address.postalCode,
      city: p.address.city,
      countryCode: p.address.countryCode,
      ...(p.address.poBox ? { poBox: p.address.poBox } : {}),
    },
    ...(p.seat ? { seat: p.seat } : {}),
    contact: p.contact,
    ...(p.register ? { register: p.register } : {}),
    representatives: p.representatives,
    ...(p.generalPartner ? { generalPartner: p.generalPartner } : {}),
    ...(p.supervisoryBoardChair ? { supervisoryBoardChair: p.supervisoryBoardChair } : {}),
    ...(p.shareCapital ? { shareCapital: p.shareCapital } : {}),
    ...(p.taxNumber ? { taxNumber: p.taxNumber } : {}),
    ...(p.taxNumberState ? { taxNumberState: p.taxNumberState } : {}),
    ...(p.vatId ? { vatId: p.vatId } : {}),
    accounts,
  };
}

async function billingAddress(ctx: ReadCtx, contactId: Id<"contacts">) {
  const rows = (
    await ctx.db
      .query("contactAddresses")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId).eq("type", "billing"))
      .collect()
  ).filter((a) => a.archivedAt === undefined);
  return (rows.find((a) => a.isDefault) ?? rows[0])?.address ?? null;
}

/** The addressee: an organisation's person writes to the organisation („z. Hd.“, CON-009); its billing address. */
async function recipientOf(ctx: ReadCtx, contactId: Id<"contacts">) {
  const contact = await ctx.db.get(contactId);
  if (!contact) throw appError("not_found", "Der Kontakt existiert nicht.");
  const parent = contact.parentId ? await ctx.db.get(contact.parentId) : null;
  const addressee = parent ?? contact;
  const a = (await billingAddress(ctx, addressee._id)) ?? (parent ? await billingAddress(ctx, contact._id) : null);
  const recipient: LetterRecipient = {
    name: addressee.displayName,
    customerNumber: addressee.number,
    address: [
      ...(parent ? [`z. Hd. ${contact.displayName}`] : []),
      ...(a?.street ? [a.street] : []),
      ...(a?.street2 ? [a.street2] : []),
      ...(a ? [[a.postalCode, a.city].filter(Boolean).join(" ")] : []),
      ...(a && a.countryCode !== "DE" ? [a.countryCode] : []),
    ],
  };
  return { contact, addressee, address: a, recipient };
}

const statementKind = (t: string): StatementDocKind => t as StatementDocKind;

async function statementLetter(
  ctx: ReadCtx,
  r: Extract<LetterRequest, { kind: "account_statement" }>,
  today: CalendarDate,
): Promise<PlannedLetter> {
  if (!isCalendarDate(r.from) || !isCalendarDate(r.to) || r.to < r.from) {
    throw appError("invalid_input", "Bitte einen gültigen Zeitraum angeben.", { field: "from" });
  }
  if (r.to > today) throw appError("invalid_input", "Der Zeitraum darf nicht in der Zukunft enden.", { field: "to" });
  const { recipient } = await recipientOf(ctx, r.contactId);
  const persons = await ctx.db
    .query("contacts")
    .withIndex("by_parent", (q) => q.eq("parentId", r.contactId))
    .collect();
  const ids = [r.contactId, ...persons.map((p) => p._id)];
  const documents = [];
  const payments = [];
  for (const cid of ids) {
    for (const d of await ctx.db
      .query("salesDocuments")
      .withIndex("by_contact", (q) => q.eq("contactId", cid))
      .collect()) {
      if (!INVOICE_KINDS.has(d.type) || d.status === "draft" || !d.number || !d.documentDate) continue;
      documents.push({
        id: d._id,
        kind: statementKind(d.type),
        number: d.number,
        date: d.documentDate,
        payableCents: d.totals.payableCents,
      });
    }
    for (const item of await ctx.db.query("openingItems").collect()) {
      if (item.contactId !== cid || item.documentId) continue;
      documents.push({
        id: item._id,
        kind: "opening_item" as const,
        number: item.number,
        date: item.documentDate,
        payableCents: item.openCents,
      });
    }
    for (const p of await ctx.db
      .query("payments")
      .withIndex("by_contact", (q) => q.eq("contactId", cid))
      .collect()) {
      if (p.target.kind === "voucher") continue;
      payments.push({
        id: p._id,
        date: p.date,
        targetKind: p.target.kind,
        number: p.number,
        amountCents: p.amountCents,
        differences: p.differences.map((x) => ({ reason: x.reason, amountCents: x.amountCents })),
        reversal: p.reversalOfId !== undefined,
        sourceKind: p.source.kind,
      });
    }
  }
  const statement = buildAccountStatement({ from: r.from, to: r.to, documents, payments });
  return {
    content: accountStatementLetter({
      statement,
      company: await letterCompany(ctx),
      recipient,
      date: today,
      ...(r.confirmationRequest ? { confirmationRequest: true } : {}),
    }),
    links: { contactId: r.contactId },
  };
}

async function confirmationLetter(
  ctx: ReadCtx,
  r: Extract<LetterRequest, { kind: "payment_confirmation" }>,
  today: CalendarDate,
): Promise<PlannedLetter> {
  const p = await ctx.db.get(r.paymentId);
  if (
    p?.target.kind !== "salesDocument" ||
    p.amountCents <= 0 ||
    p.reversalOfId ||
    p.reversedById ||
    p.source.kind === "adjustment" ||
    p.source.kind === "credit"
  ) {
    throw appError(
      "invalid_input",
      "Eine Zahlungsbestätigung gibt es nur für erfasste, nicht stornierte Zahlungseingänge auf Rechnungen.",
      { reason: "NOT_CONFIRMABLE" },
    );
  }
  const doc = await ctx.db.get(p.target.id as Id<"salesDocuments">);
  if (!doc?.number || !doc.documentDate || !doc.contactId) throw appError("not_found", "Die Rechnung existiert nicht.");
  const { recipient } = await recipientOf(ctx, doc.contactId);
  return {
    content: paymentConfirmationLetter({
      paymentId: p._id,
      paymentDate: p.date,
      amountCents: p.amountCents,
      invoiceNumber: doc.number,
      invoiceDate: doc.documentDate,
      openAfterCents: doc.openAmountCents ?? 0,
      salutation: r.lang === "en" ? "Dear Sir or Madam" : SALUTATION,
      company: await letterCompany(ctx),
      recipient,
      date: today,
      ...(r.lang ? { lang: r.lang } : {}),
      ...(r.subject?.trim() && r.body?.trim() ? { template: { subject: r.subject.trim(), body: r.body.trim() } } : {}),
    }),
    links: { contactId: doc.contactId, documentId: doc._id, paymentId: p._id },
  };
}

/** Fees of issued reminders and the dunning fees/interest received with payments (PAY-024). */
async function dunningMoney(ctx: ReadCtx, inv: Doc<"salesDocuments">) {
  const reminders = (await remindersOf(ctx, inv._id)).filter((r) => r.status === "finalized" || r.status === "sent");
  const reminderFeesCents = reminders.reduce((s, r) => s + (r.reminder?.feeCents ?? 0), 0);
  let feesReceivedCents = 0;
  let interestReceivedCents = 0;
  for (const p of await paymentsOfTarget(ctx, { kind: "salesDocument", id: inv._id })) {
    for (const d of p.differences) {
      if (d.reason === "dunning_fees") feesReceivedCents -= d.amountCents;
      if (d.reason === "default_interest") interestReceivedCents -= d.amountCents;
    }
  }
  return { reminderFeesCents, feesReceivedCents, interestReceivedCents };
}

async function invoiceFacts(ctx: ReadCtx, invoiceId: Id<"salesDocuments">, today: CalendarDate) {
  const inv = await ctx.db.get(invoiceId);
  if (!inv?.number || !inv.documentDate || inv.status === "draft") {
    throw appError("not_found", "Die Rechnung existiert nicht.");
  }
  if (!inv.contactId) throw appError("invalid_input", "Die Rechnung hat keinen Kunden.");
  const l = await loadInvoiceState(ctx, inv, today);
  const s = await evaluationContext(ctx, today);
  const defaultStart = defaultStartFor(l, s);
  return { inv: inv as Doc<"salesDocuments"> & { number: string; documentDate: string }, l, s, defaultStart };
}

async function interestClaim(
  ctx: ReadCtx,
  r: Extract<LetterRequest, { kind: "interest_claim" }>,
  today: CalendarDate,
): Promise<PlannedLetter> {
  const { inv, l, s, defaultStart } = await invoiceFacts(ctx, r.invoiceId, today);
  const settlement = await documentSettlement(ctx, inv._id);
  const money = await dunningMoney(ctx, inv);
  const claim = computeInterestClaim({
    date: today,
    currency: inv.currency,
    isConsumer: l.state.contact.isConsumer,
    defaultStart,
    openAmountCents: settlement.openAmountCents,
    paidOn: settlement.fullySettled && settlement.paidOn ? (settlement.paidOn as CalendarDate) : null,
    history: l.state.history,
    ...money,
    ...(s.ctx.state ? { state: s.ctx.state } : {}),
    ...(s.ctx.overrides ? { overrides: s.ctx.overrides } : {}),
  });
  if (!claim.ok) throw appError("invalid_input", claim.error.message, { reason: claim.error.code.toUpperCase() });
  const { recipient } = await recipientOf(ctx, inv.contactId as Id<"contacts">);
  return {
    content: interestClaimLetter({
      claim: claim.value,
      invoice: { number: inv.number, documentDate: inv.documentDate, payableCents: inv.totals.payableCents },
      defaultRoute: (defaultStart as NonNullable<typeof defaultStart>).route,
      isConsumer: l.state.contact.isConsumer,
      salutation: SALUTATION,
      company: await letterCompany(ctx),
      recipient,
      date: today,
    }),
    links: { contactId: inv.contactId as Id<"contacts">, documentId: inv._id },
  };
}

async function mahnbescheid(
  ctx: ReadCtx,
  r: Extract<LetterRequest, { kind: "mahnbescheid_sheet" }>,
  today: CalendarDate,
): Promise<PlannedLetter> {
  const { inv, l, defaultStart } = await invoiceFacts(ctx, r.invoiceId, today);
  const { addressee, address } = await recipientOf(ctx, inv.contactId as Id<"contacts">);
  const money = await dunningMoney(ctx, inv);
  const company = await letterCompany(ctx);
  const data = mahnbescheidData({
    date: today,
    company,
    debtor: {
      name: addressee.displayName,
      kind: addressee.kind === "organization" ? "organisation" : "person",
      isConsumer: l.state.contact.isConsumer,
      address: {
        street: address?.street ?? "",
        postalCode: address?.postalCode ?? "",
        city: address?.city ?? "",
        countryCode: address?.countryCode ?? "DE",
      },
      customerNumber: addressee.number,
    },
    invoice: {
      number: inv.number,
      documentDate: inv.documentDate,
      dueDate: inv.dueDate ?? inv.documentDate,
      currency: inv.currency,
      payableCents: inv.totals.payableCents,
      openAmountCents: inv.openAmountCents ?? inv.totals.payableCents,
    },
    defaultStart,
    reminderFeesCents: money.reminderFeesCents,
    feesReceivedCents: money.feesReceivedCents,
  });
  if (!data.ok) throw appError("invalid_input", data.error.message, { reason: data.error.code.toUpperCase() });
  return {
    content: mahnbescheidSheet(data.value, company, today),
    data: JSON.stringify(data.value, null, 2),
    links: { contactId: inv.contactId as Id<"contacts">, documentId: inv._id },
  };
}

/** Builds the letter content (preview and act share it). Throws structured errors with the German message. */
export async function planLetter(ctx: ReadCtx, request: LetterRequest, now: number): Promise<PlannedLetter> {
  const today = berlinCalendarDate(now);
  switch (request.kind) {
    case "account_statement":
      return statementLetter(ctx, request, today);
    case "payment_confirmation":
      return confirmationLetter(ctx, request, today);
    case "interest_claim":
      return interestClaim(ctx, request, today);
    case "mahnbescheid_sheet":
      return mahnbescheid(ctx, request, today);
  }
}

export interface ArchiveLetterArgs {
  kind: LetterKind;
  links: PlannedLetter["links"];
  date: string;
  title: string;
  subject: string;
  file: Doc<"receivableLetters">["file"];
  data?: string;
}

/** Archives a generated letter (immutable afterwards except the one-time sent mark). */
export async function archiveLetter(ctx: ModelCtx, a: ArchiveLetterArgs): Promise<Id<"receivableLetters">> {
  return auditedInsert(
    ctx,
    "receivableLetters",
    {
      kind: a.kind,
      ...(a.links.contactId ? { contactId: a.links.contactId } : {}),
      ...(a.links.documentId ? { documentId: a.links.documentId } : {}),
      ...(a.links.paymentId ? { paymentId: a.links.paymentId } : {}),
      date: a.date,
      title: a.title,
      subject: a.subject,
      file: a.file,
      ...(a.data ? { data: a.data } : {}),
      actor: ctx.actor,
      createdAt: ctx.now(),
    },
    { action: "receivables.letter_archive", label: `${a.title}: ${a.subject}` },
  );
}

export const LETTER_SENT_MESSAGES = {
  dateRange: (date: string) =>
    `Das Versanddatum muss zwischen dem Datum des Schreibens (${formatGermanDate(date as CalendarDate)}) und heute liegen.`,
  already: "Das Schreiben ist bereits als versendet markiert.",
  noteRequired: "Bitte beschreiben, wie das Schreiben übermittelt wurde.",
} as const;

/** PAY-048 „Als versendet markieren“ (manual, once; B2). */
export async function markLetterSent(
  ctx: ModelCtx,
  id: Id<"receivableLetters">,
  v: { sentOn: string; channel: NonNullable<Doc<"receivableLetters">["sent"]>["channel"]; note?: string },
): Promise<void> {
  const letter = await ctx.db.get(id);
  if (!letter) throw appError("not_found", "Das Schreiben existiert nicht.");
  if (letter.sent) throw appError("conflict", LETTER_SENT_MESSAGES.already, { reason: "already_sent" });
  const today = berlinCalendarDate(ctx.now());
  if (!isCalendarDate(v.sentOn) || v.sentOn < letter.date || v.sentOn > today) {
    throw appError("invalid_input", LETTER_SENT_MESSAGES.dateRange(letter.date), { field: "sentOn" });
  }
  const note = v.note?.trim();
  if (v.channel === "other" && !note)
    throw appError("invalid_input", LETTER_SENT_MESSAGES.noteRequired, { field: "note" });
  await auditedPatch(
    ctx,
    "receivableLetters",
    id,
    { sent: { sentOn: v.sentOn, channel: v.channel, ...(note ? { note } : {}), at: ctx.now(), actor: ctx.actor } },
    { action: "receivables.letter_mark_sent", label: `${letter.title}: ${letter.subject}` },
  );
}

/** Archived letters of a contact (incl. its persons' documents) or of one document, newest first. */
export async function lettersOf(ctx: ReadCtx, by: { contactId?: Id<"contacts">; documentId?: Id<"salesDocuments"> }) {
  const rows = by.documentId
    ? await ctx.db
        .query("receivableLetters")
        .withIndex("by_document", (q) => q.eq("documentId", by.documentId))
        .collect()
    : by.contactId
      ? await ctx.db
          .query("receivableLetters")
          .withIndex("by_contact", (q) => q.eq("contactId", by.contactId))
          .collect()
      : [];
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}
