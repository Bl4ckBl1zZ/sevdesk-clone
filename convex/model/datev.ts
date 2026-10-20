import { ConvexError } from "convex/values";
import { chartAt, supplyEnd } from "../../src/domain/accounting/period";
import { splitByFiscalYear } from "../../src/domain/datev/extf";
import type { DatevBeleg, DatevJournalEntry } from "../../src/domain/datev/mapping";
import type { PreviousExport } from "../../src/domain/datev/masterdata";
import {
  bookingScopeOf,
  type DatevBookingScope,
  type DatevContactData,
  type DatevDocData,
  type DatevRunSettings,
  type DatevScope,
  type DatevYear,
} from "../../src/domain/datev/run";
import { chartAccounts } from "../../src/domain/rules/accounting";
import type { CalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import { cashAccountNumber } from "./cash";
import { getCompanyProfile } from "./companyProfile";
import { ensurePersonalAccount } from "./contacts";
import { createJob } from "./jobs";
import { resolveContextAt } from "./journal";
import { lockThrough, previewLock } from "./periodLock";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * F09 EXP-001…016 DATEV export — database side. The pure flow is src/domain/datev/run.ts; this module loads the
 * settings, the journal (read only, as stored), the Belege and contacts, records the history (`datevExports`,
 * append-only) and the advisor acceptance (`datevAcceptance`). The worker is convex/datevJob.ts.
 */

export interface DatevContext {
  settings: DatevRunSettings;
  years: DatevYear[];
  lockedMonths: string[];
  /** EXP-011 with „Zeitraum festschreiben": the lock checklist blockers (F08 ACC-017) — the export cannot start. */
  lockBlockers: string[];
  previous: PreviousExport[];
  accepted: boolean;
  running: boolean;
  contacts: DatevContactData[];
  usedAccounts: string[];
}

export interface DatevEntriesPage {
  entries: DatevJournalEntry[];
  belege: Record<string, DatevBeleg>;
  docs: (Omit<DatevDocData, "files"> & { files: { ext: string; sha256: string; storageId: string }[] })[];
  contacts: DatevContactData[];
  isDone: boolean;
  continueCursor: string;
}

const PAGE = 100;
const OPEN_JOB = ["queued", "running"] as const;
const overlaps = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from <= b.to && a.to >= b.from;
const ext = (mime: string, name: string) =>
  mime === "application/pdf"
    ? "pdf"
    : mime.includes("xml")
      ? "xml"
      : (/\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase() ?? "bin");

async function contactData(ctx: ReadCtx, c: Doc<"contacts">): Promise<DatevContactData> {
  const addresses = await ctx.db
    .query("contactAddresses")
    .withIndex("by_contact", (q) => q.eq("contactId", c._id).eq("type", "billing"))
    .collect();
  const billing = addresses.find((a) => a.isDefault && !a.archivedAt) ?? addresses.find((a) => !a.archivedAt);
  const channels = await ctx.db
    .query("contactChannels")
    .withIndex("by_contact", (q) => q.eq("contactId", c._id))
    .collect();
  const first = (type: string) =>
    channels.find((x) => x.type === type && x.isPrimary) ?? channels.find((x) => x.type === type);
  return {
    id: c._id,
    kind: c.kind,
    number: c.number,
    displayName: c.displayName,
    organizationName: c.organizationName,
    firstName: c.firstName,
    lastName: c.lastName,
    salutation: c.salutation,
    academicTitle: c.academicTitle,
    vatId: c.vatId,
    taxNumber: c.taxNumber,
    ...(billing
      ? {
          address: {
            street: billing.address.street,
            postalCode: billing.address.postalCode,
            city: billing.address.city,
            countryCode: billing.address.countryCode,
            ...(billing.address.poBox ? { poBox: billing.address.poBox } : {}),
          },
        }
      : {}),
    phone: first("phone")?.value,
    email: first("email")?.value,
    web: first("web")?.value,
    iban: c.iban,
    bic: c.bic,
    language: c.language,
    debtorAccount: c.debtorAccount,
    creditorAccount: c.creditorAccount,
    useCollectiveDebtor: c.useCollectiveDebtor,
  };
}

export async function datevContext(
  ctx: ReadCtx,
  a: { from: string; to: string; now: number; lockPeriod?: boolean | undefined },
): Promise<DatevContext> {
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("not_found", "Unternehmensdaten fehlen.");
  const startMonth = profile.fiscalYearStartMonth ?? 1;
  const cash = await cashAccountNumber(ctx, a.now);
  const years: DatevYear[] = [];
  if (a.from <= a.to) {
    for (const y of splitByFiscalYear(a.from, a.to, startMonth)) {
      const chart = chartAt(profile.chartOfAccounts, startMonth, y.from);
      const seeded = chartAccounts(chart, y.from as CalendarDate);
      const accounts = new Map<string, boolean>();
      for (const acc of seeded.ok ? seeded.value : []) accounts.set(acc.number, acc.automaticVatAccount === true);
      const rctx = await resolveContextAt(ctx, y.from as CalendarDate);
      for (const b of rctx.bankAccounts) if (!accounts.has(b.ledgerAccount)) accounts.set(b.ledgerAccount, false);
      for (const o of rctx.overrides) if (!accounts.has(o.account)) accounts.set(o.account, false);
      if (cash && !accounts.has(cash)) accounts.set(cash, false);
      years.push({ ...y, chart, accounts: [...accounts].map(([n, auto]) => ({ n, auto })) });
    }
  }
  const periods = await ctx.db.query("periods").collect();
  const lockedMonths = periods
    .filter((p) => p.status === "locked" && p.period >= a.from.slice(0, 7) && p.period <= a.to.slice(0, 7))
    .map((p) => p.period);
  const lockBlockers: string[] = [];
  if (a.lockPeriod) {
    // EXP-011: the months the lock would cover count as locked for the preview; blockers stop the export.
    for (const y of years) {
      try {
        const p = await previewLock(ctx, y.to.slice(0, 7), a.now);
        for (const m of p.months) if (m >= a.from.slice(0, 7) && m <= a.to.slice(0, 7)) lockedMonths.push(m);
        lockBlockers.push(...p.checklist.blockers.map((b) => b.message));
      } catch (e) {
        if (errorCode(e) !== "period_locked") lockBlockers.push(errorMessage(e));
      }
    }
  }
  const exports = await ctx.db.query("datevExports").collect();
  const previous = exports.filter((e) => overlaps(e, a)).map(previousOf);
  let running = false;
  for (const status of OPEN_JOB) {
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", status))
      .collect();
    running ||= jobs.some((j) => j.kind === "datev_export" && overlaps(j.params as { from: string; to: string }, a));
  }
  const all = (await ctx.db.query("contacts").collect()).filter((c) => !c.mergedIntoId);
  const usedAccounts = all.flatMap((c) => [c.debtorAccount, c.creditorAccount]).filter((x): x is string => !!x);
  const contacts: DatevContactData[] = [];
  for (const c of all) if (c.debtorAccount || c.creditorAccount) contacts.push(await contactData(ctx, c));
  return {
    settings: {
      consultantNumber: profile.datev.consultantNumber,
      clientNumber: profile.datev.clientNumber,
      accountLength: profile.datev.accountLength,
      formatVersion: profile.datev.formatVersion ?? 13,
      personalAccounts: profile.datev.personalAccounts,
      collectiveDebtorAccount: profile.datev.collectiveDebtorAccount,
      companyName: profile.name,
    },
    years,
    lockedMonths: [...new Set(lockedMonths)],
    lockBlockers,
    previous,
    accepted: (await ctx.db.query("datevAcceptance").first()) !== null,
    running,
    contacts,
    usedAccounts,
  };
}

function previousOf(e: Doc<"datevExports">): PreviousExport {
  return {
    id: e._id,
    fileName: e.files.find((f) => f.name.startsWith("EXTF_Buchungsstapel"))?.name ?? e.file.name,
    createdAt: e.at,
    festschreibung: e.festschreibung ? 1 : 0,
    from: e.from,
    to: e.to,
    lineIds: e.journalLineIds,
    sha256ByFile: Object.fromEntries(e.files.filter((f) => f.rowsSha256).map((f) => [f.name, f.rowsSha256 as string])),
  };
}

/** One page of journal entries of the range in the booking scopes, with Belege, document files and contacts. */
export async function datevEntriesPage(
  ctx: ReadCtx,
  a: { from: string; to: string; scope: readonly DatevScope[]; cursor: string | null; documents: boolean },
): Promise<DatevEntriesPage> {
  const res = await ctx.db
    .query("journalEntries")
    .withIndex("by_period", (q) => q.gte("period", a.from.slice(0, 7)).lte("period", a.to.slice(0, 7)))
    .paginate({ cursor: a.cursor, numItems: PAGE });
  const scope = new Set<string>(a.scope);
  const entries: DatevJournalEntry[] = [];
  const belege: Record<string, DatevBeleg> = {};
  const docs: DatevEntriesPage["docs"] = [];
  const contactIds = new Set<Id<"contacts">>();
  for (const e of res.page) {
    if (e.date < a.from || e.date > a.to) continue;
    let targetKind: string | undefined;
    if (e.source.kind === "payment") {
      const p = await ctx.db.get(e.source.id as Id<"payments">);
      targetKind = p?.target.kind;
      if (p?.number && !belege[e.source.id]) belege[e.source.id] = { belegfeld1: p.number };
    }
    const bookingScope: DatevBookingScope = bookingScopeOf(e.source.kind, targetKind);
    if (!scope.has(bookingScope)) continue;
    entries.push({
      id: e._id,
      seq: e.seq,
      date: e.date,
      ...(e.originalDate ? { originalDate: e.originalDate } : {}),
      text: e.text,
      source: e.source,
      ...(e.reversalOfId ? { reversalOfId: e.reversalOfId } : {}),
      lines: e.lines.map((l) => ({ ...l, ...(l.contactId ? { contactId: l.contactId as string } : {}) })),
    });
    for (const l of e.lines) if (l.contactId) contactIds.add(l.contactId);
    if (belege[e.source.id]) continue;
    if (e.source.kind === "salesDocument") {
      const d = await ctx.db.get(e.source.id as Id<"salesDocuments">);
      if (!d) continue;
      const contact = d.contactId ? await ctx.db.get(d.contactId) : null;
      const number = d.datevBelegnummer ?? d.number ?? "";
      belege[e.source.id] = {
        belegfeld1: number,
        ...(d.dueDate ? { dueDate: d.dueDate } : {}),
        ...(d.supplyDate ? { supplyDate: supplyEnd(d.supplyDate) } : {}),
        ...(contact?.vatId ? { euVatId: contact.vatId.replace(/\s/g, "") } : {}),
        internalId: d._id,
      };
      if (a.documents) {
        const artifacts = await ctx.db
          .query("documentArtifacts")
          .withIndex("by_document", (q) => q.eq("documentId", d._id))
          .collect();
        const originals = artifacts.filter((x) => x.variant !== "copy" && x.variant !== "reading");
        const pdf = originals.find((x) => x.kind === "zugferd_pdf") ?? originals.find((x) => x.kind === "pdf");
        const xml = originals.find((x) => x.kind === "xrechnung_xml");
        docs.push({
          sourceId: d._id,
          belegfeld1: number,
          numbered: false,
          files: [pdf, xml]
            .filter((x): x is Doc<"documentArtifacts"> => !!x)
            .map((x) => ({ ext: ext(x.mime, x.name), sha256: x.sha256, storageId: x.storageId })),
        });
      }
    } else if (e.source.kind === "voucher") {
      const v = await ctx.db.get(e.source.id as Id<"vouchers">);
      if (!v) continue;
      belege[e.source.id] = {
        belegfeld1: v.internalNumber ?? "",
        ...(v.documentNumber ? { supplierNumber: v.documentNumber } : {}),
        ...(v.supplierVatId ? { euVatId: v.supplierVatId.replace(/\s/g, "") } : {}),
        internalId: v._id,
      };
      if (a.documents) {
        const originals = v.originalFiles.filter((f) => f.role === "original");
        docs.push({
          sourceId: v._id,
          belegfeld1: v.internalNumber ?? "",
          numbered: true,
          files: originals.map((f) => ({ ext: ext(f.mime, f.name), sha256: f.sha256, storageId: f.storageId })),
        });
      }
    }
  }
  const contacts: DatevContactData[] = [];
  for (const id of contactIds) {
    const c = await ctx.db.get(id);
    if (c) contacts.push(await contactData(ctx, c));
  }
  return { entries, belege, docs, contacts, isDone: res.isDone, continueCursor: res.continueCursor };
}

export interface DatevStartArgs {
  from: string;
  to: string;
  scope: DatevScope[];
  mode: "new" | "full";
  festschreibung?: boolean | undefined;
  confirmReplace?: boolean | undefined;
  /** EXP-011 „Zeitraum beim Export festschreiben" (only via `exports.datev.lock`, fresh session). */
  lockPeriod?: boolean | undefined;
}

const errorCode = (e: unknown) => (e instanceof ConvexError ? (e.data as { code?: string }).code : undefined);
const errorMessage = (e: unknown) =>
  e instanceof ConvexError ? String((e.data as { message?: string }).message ?? "") : String(e);

/** E-EXP-20: one export per overlapping range at a time; the job carries the arguments. */
export async function startDatevExport(ctx: ModelCtx, args: DatevStartArgs): Promise<Id<"jobs">> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.from) || !/^\d{4}-\d{2}-\d{2}$/.test(args.to) || args.from > args.to) {
    throw appError(
      "invalid_input",
      "Bitte einen gültigen Zeitraum wählen (Beginn vor Ende, höchstens zwei Wirtschaftsjahre).",
    );
  }
  if (args.scope.length === 0) throw appError("invalid_input", "Bitte mindestens einen Umfang auswählen.");
  for (const status of OPEN_JOB) {
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", status))
      .collect();
    if (jobs.some((j) => j.kind === "datev_export" && overlaps(j.params as DatevStartArgs, args))) {
      throw appError("conflict", "Für diesen Zeitraum läuft bereits ein Export.");
    }
  }
  if (args.lockPeriod) {
    // EXP-011 / §4.1.3: the lock must succeed before the file is written with Festschreibung = 1 (same transaction
    // as the job; blockers abort both — `period_lock_blocked`). Already locked fiscal years are skipped.
    const profile = await getCompanyProfile(ctx);
    for (const y of splitByFiscalYear(args.from, args.to, profile?.fiscalYearStartMonth ?? 1)) {
      try {
        await lockThrough(ctx, y.to.slice(0, 7), "datev_export");
      } catch (e) {
        if (errorCode(e) !== "period_locked") throw e;
      }
    }
  }
  return createJob(ctx, {
    kind: "datev_export",
    label: `DATEV-Export ${args.from} – ${args.to}`,
    params: args,
    total: 3,
  });
}

/** EXP-006: personal accounts for the contacts of the export (audited `contact.account.assign`, job actor). */
export async function assignDatevAccounts(
  ctx: ModelCtx,
  needs: readonly { contactId: string; kind: "debtor" | "creditor" }[],
): Promise<number> {
  let n = 0;
  for (const x of needs) {
    const c = await ctx.db.get(x.contactId as Id<"contacts">);
    if (!c) continue;
    const had = x.kind === "debtor" ? c.debtorAccount : c.creditorAccount;
    if (had) continue;
    if (await ensurePersonalAccount(ctx, c._id, x.kind)) n++;
  }
  return n;
}

export interface DatevRecord {
  storageId: Id<"_storage">;
  name: string;
  sha256: string;
  bytes: number;
  files: { name: string; sha256: string; rowsSha256?: string }[];
  lineIds: string[];
  rowCount: number;
  sumUmsatzCents: number;
  festschreibung: boolean;
  isRepeat: boolean;
  doNotReimport: boolean;
  formatVersion: 12 | 13;
  report: unknown;
}

export async function recordDatevExport(ctx: ModelCtx, job: Doc<"jobs">, r: DatevRecord): Promise<Id<"datevExports">> {
  const p = job.params as DatevStartArgs;
  return auditedInsert(
    ctx,
    "datevExports",
    {
      from: p.from,
      to: p.to,
      scope: p.scope,
      mode: p.mode,
      formatVersion: r.formatVersion,
      festschreibung: r.festschreibung,
      isRepeat: r.isRepeat,
      ...(r.doNotReimport ? { doNotReimport: true } : {}),
      journalLineIds: r.lineIds,
      rowCount: r.rowCount,
      sumUmsatzCents: r.sumUmsatzCents,
      file: { storageId: r.storageId, sha256: r.sha256, bytes: r.bytes, mime: "application/zip", name: r.name },
      files: r.files,
      validationReport: r.report,
      jobId: job._id,
      actor: ctx.actor,
      at: ctx.now(),
    },
    { action: "export.datev", label: r.name },
  );
}

export async function listDatevExports(ctx: ReadCtx) {
  const rows = await ctx.db.query("datevExports").order("desc").take(200);
  return rows.map((r) => ({
    id: r._id,
    from: r.from,
    to: r.to,
    scope: r.scope,
    mode: r.mode,
    formatVersion: r.formatVersion,
    festschreibung: r.festschreibung,
    isRepeat: r.isRepeat,
    doNotReimport: r.doNotReimport === true,
    rowCount: r.rowCount,
    sumUmsatzCents: r.sumUmsatzCents,
    sha256: r.file.sha256,
    name: r.file.name,
    actor: r.actor,
    at: r.at,
  }));
}

export async function datevStatus(ctx: ReadCtx) {
  const profile = await getCompanyProfile(ctx);
  const acceptance = await ctx.db.query("datevAcceptance").withIndex("by_recordedAt").order("desc").first();
  return {
    configured: profile?.datev.consultantNumber !== undefined && profile?.datev.clientNumber !== undefined,
    formatVersion: profile?.datev.formatVersion ?? 13,
    personalAccounts: profile?.datev.personalAccounts ?? true,
    fiscalYearStartMonth: profile?.fiscalYearStartMonth ?? 1,
    acceptance: acceptance
      ? {
          testedOn: acceptance.testedOn,
          formatVersion: acceptance.formatVersion,
          buKeysConfirmed: acceptance.buKeysConfirmed,
          advisorName: acceptance.advisorName,
          recordedAt: acceptance.recordedAt,
        }
      : null,
  };
}

export async function recordDatevAcceptance(
  ctx: ModelCtx,
  a: { testedOn: string; formatVersion: 12 | 13; buKeysConfirmed: boolean; advisorName?: string; remarks?: string },
): Promise<Id<"datevAcceptance">> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.testedOn))
    throw appError("invalid_input", "Bitte das Datum des Testimports angeben.");
  return auditedInsert(
    ctx,
    "datevAcceptance",
    {
      testedOn: a.testedOn,
      formatVersion: a.formatVersion,
      buKeysConfirmed: a.buKeysConfirmed,
      ...(a.advisorName?.trim() ? { advisorName: a.advisorName.trim() } : {}),
      ...(a.remarks?.trim() ? { remarks: a.remarks.trim() } : {}),
      recordedAt: ctx.now(),
      actor: ctx.actor,
    },
    { action: "export.datev_acceptance", label: a.advisorName ?? a.testedOn },
  );
}

const DATEV_BELEG_RE = /^[A-Za-z0-9$%&*+\-/]{1,36}$/;

/** E-EXP-10: a DATEV-safe alias for a (legacy) document number DATEV rejects — set once, audited. */
export async function setDatevBelegnummer(
  ctx: ModelCtx,
  a: { documentId: Id<"salesDocuments">; alias: string },
): Promise<void> {
  const d = await ctx.db.get(a.documentId);
  if (!d?.number) throw appError("not_found", "Dokument nicht gefunden.");
  if (d.datevBelegnummer) throw appError("conflict", "Die DATEV-Belegnummer ist bereits festgelegt.");
  if (DATEV_BELEG_RE.test(d.number)) throw appError("invalid_input", "Die Belegnummer ist für DATEV bereits gültig.");
  const alias = a.alias.trim();
  if (!DATEV_BELEG_RE.test(alias)) {
    throw appError(
      "invalid_input",
      "Die DATEV-Belegnummer darf höchstens 36 Zeichen aus A–Z, a–z, 0–9 und $ % & * + - / enthalten.",
    );
  }
  await auditedPatch(
    ctx,
    "salesDocuments",
    d._id,
    { datevBelegnummer: alias },
    { action: "document.datev_alias", label: d.number },
  );
}
