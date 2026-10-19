import type { PaginationResult } from "convex/server";
import { fiscalYearEnd, fiscalYearStart } from "../../src/domain/accounting/period";
import {
  bankRow,
  buchungRow,
  buchungszeilenRows,
  dokumentRow,
  eingangsbelegRow,
  eingangsPositionRow,
  type FileLike,
  firmaRow,
  type JournalEntryLike,
  kontaktRow,
  kontoRow,
  nummerRow,
  type ProfileLike,
  positionRows,
  protokollRow,
  rechnungRow,
  zahlungRow,
} from "../../src/domain/gdpdu/adapters";
import type { GdpduRow } from "../../src/domain/gdpdu/schema-v1";
import { chartAccounts } from "../../src/domain/rules/accounting";
import type { Chart } from "../../src/domain/rules/accounting/types";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { CalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert } from "./audit";
import { cashAccountNumber } from "./cash";
import { getCompanyProfile } from "./companyProfile";
import { createJob } from "./jobs";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * F09 EXP-017…019 / GOBD-11: database side of the GDPdU (Z3) export. The worker (convex/gdpduJob.ts) pulls one
 * source page at a time; each page returns the `gdpdu-v1` rows (mapped by the pure adapters in
 * src/domain/gdpdu/adapters.ts), the number of database records read per file (E-EXP-32 cross-check) and the
 * archived files referenced from `dokumente.csv`. Reads only — the journal is read as stored (append-only).
 */

export const GDPDU_SOURCES = [
  "firma",
  "kontakte",
  "journal",
  "rechnungen",
  "eingangsbelege",
  "zahlungen",
  "bank",
  "nummern",
  "protokoll",
] as const;
export type GdpduSource = (typeof GDPDU_SOURCES)[number];

export interface GdpduRange {
  year: number;
  from: CalendarDate;
  to: CalendarDate;
  startMonth: number;
}

export interface GdpduFileRef {
  storageId: string;
  path: string;
}

export interface GdpduPage {
  rows: Record<string, GdpduRow[]>;
  db: Record<string, number>;
  files: GdpduFileRef[];
  isDone: boolean;
  continueCursor: string;
}

const PAGE = 100;

export async function gdpduRange(ctx: ReadCtx, year: number): Promise<GdpduRange> {
  const profile = await getCompanyProfile(ctx);
  const startMonth = profile?.fiscalYearStartMonth ?? 1;
  return { year, from: fiscalYearStart(year, startMonth), to: fiscalYearEnd(year, startMonth), startMonth };
}

const inRange = (d: string | undefined, r: GdpduRange) => d !== undefined && d >= r.from && d <= r.to;
const msInRange = (ms: number, r: GdpduRange) => inRange(berlinCalendarDate(ms), r);
const ext = (mime: string, name: string) =>
  mime === "application/pdf"
    ? "pdf"
    : mime.includes("xml")
      ? "xml"
      : (/\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase() ?? "bin");
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

function page(
  res: PaginationResult<unknown>,
  rows: Record<string, GdpduRow[]>,
  db: Record<string, number>,
  files: GdpduFileRef[] = [],
): GdpduPage {
  return { rows, db, files, isDone: res.isDone, continueCursor: res.continueCursor };
}

const single = (rows: Record<string, GdpduRow[]>, db: Record<string, number>): GdpduPage => ({
  rows,
  db,
  files: [],
  isDone: true,
  continueCursor: "",
});

async function firmaPage(ctx: ReadCtx, r: GdpduRange): Promise<GdpduPage> {
  const versions = await ctx.db.query("companyProfileVersions").withIndex("by_version").collect();
  const rows: GdpduRow[] = versions.map((v, i) => {
    const next = versions[i + 1];
    return firmaRow(
      {
        version: v.version,
        validFrom: berlinCalendarDate(v.validFrom),
        supersededOn: next ? berlinCalendarDate(next.validFrom) : null,
        profile: JSON.parse(v.profile) as ProfileLike,
      },
      r.year,
      r.from,
    );
  });
  if (rows.length === 0) {
    const p = await getCompanyProfile(ctx);
    if (p) {
      rows.push(
        firmaRow(
          { version: p.version, validFrom: r.from, supersededOn: null, profile: p as unknown as ProfileLike },
          r.year,
          r.from,
        ),
      );
    }
  }
  const profile = await getCompanyProfile(ctx);
  const chart = ([...(profile?.chartOfAccounts ?? [])]
    .filter((c) => c.validFromFiscalYear <= r.year)
    .sort((a, b) => b.validFromFiscalYear - a.validFromFiscalYear)[0]?.chart ?? "SKR03") as Chart;
  const accounts = chartAccounts(chart, r.from);
  const konten = accounts.ok ? accounts.value.map((a) => kontoRow(a)) : [];
  return single({ "firma.csv": rows, "konten.csv": konten }, { "firma.csv": rows.length });
}

async function kontaktePage(ctx: ReadCtx, cursor: string | null): Promise<GdpduPage> {
  const res = await ctx.db.query("contacts").paginate({ cursor, numItems: PAGE });
  const rows: GdpduRow[] = [];
  const konten: GdpduRow[] = [];
  for (const c of res.page) {
    const addresses = await ctx.db
      .query("contactAddresses")
      .withIndex("by_contact", (q) => q.eq("contactId", c._id).eq("type", "billing"))
      .collect();
    const billing = addresses.find((a) => a.isDefault && !a.archivedAt) ?? addresses.find((a) => !a.archivedAt);
    rows.push(kontaktRow(c, billing?.address ?? null));
    if (c.debtorAccount)
      konten.push(kontoRow({ number: c.debtorAccount, name: `Debitor ${c.number} ${c.displayName}`, type: "debtor" }));
    if (c.creditorAccount) {
      konten.push(
        kontoRow({ number: c.creditorAccount, name: `Kreditor ${c.number} ${c.displayName}`, type: "creditor" }),
      );
    }
  }
  return page(res, { "kontakte.csv": rows, "konten.csv": konten }, { "kontakte.csv": res.page.length });
}

async function journalPage(ctx: ReadCtx, r: GdpduRange, cursor: string | null, now: number): Promise<GdpduPage> {
  const fromPeriod = r.from.slice(0, 7);
  const toPeriod = r.to.slice(0, 7);
  const res = await ctx.db
    .query("journalEntries")
    .withIndex("by_period", (q) => q.gte("period", fromPeriod).lte("period", toPeriod))
    .paginate({ cursor, numItems: PAGE });
  const seqCache = new Map<string, number>();
  for (const e of res.page) seqCache.set(e._id, e.seq);
  const seqOf = (id: string) => seqCache.get(id);
  for (const e of res.page) {
    if (e.reversalOfId && !seqCache.has(e.reversalOfId)) {
      const o = await ctx.db.get(e.reversalOfId);
      if (o) seqCache.set(o._id, o.seq);
    }
  }
  const entries = res.page as unknown as JournalEntryLike[];
  const buchungen = entries.map((e) => buchungRow(e, seqOf));
  const zeilen = entries.flatMap((e) => buchungszeilenRows(e));
  // E-EXP-32: the lines read model (journalLines) is an independent count of the lines.
  let lineCount = 0;
  for (const e of res.page) {
    lineCount += (
      await ctx.db
        .query("journalLines")
        .withIndex("by_entry", (q) => q.eq("entryId", e._id))
        .collect()
    ).length;
  }
  const cash = await cashAccountNumber(ctx, now);
  const kasse: GdpduRow[] = [];
  if (cash) {
    for (const e of entries) {
      e.lines.forEach((l, i) => {
        if (l.account !== cash) return;
        kasse.push({
          seq: e.seq,
          zeile: i + 1,
          datum: e.date,
          text: e.text,
          quelle_art: e.source.kind,
          quelle_id: e.source.id,
          betrag: l.debitCents - l.creditCents,
          saldo: null, // running balance: filled by the worker over all pages (needs the opening balance)
        });
      });
    }
  }
  return page(
    res,
    { "buchungen.csv": buchungen, "buchungszeilen.csv": zeilen, "kassenbewegungen.csv": kasse },
    { "buchungen.csv": res.page.length, "buchungszeilen.csv": lineCount },
  );
}

/** Cash balance before the fiscal year (opening of the running balance in kassenbewegungen.csv). */
export async function cashOpening(
  ctx: ReadCtx,
  r: GdpduRange,
  now: number,
): Promise<{ account: string | null; cents: number }> {
  const account = await cashAccountNumber(ctx, now);
  if (!account) return { account: null, cents: 0 };
  let cents = 0;
  for await (const l of ctx.db
    .query("journalLines")
    .withIndex("by_account_date_seq", (q) => q.eq("account", account).lt("date", r.from))) {
    cents += l.debitCents - l.creditCents;
  }
  return { account, cents };
}

async function rechnungenPage(
  ctx: ReadCtx,
  r: GdpduRange,
  cursor: string | null,
  includeFiles: boolean,
): Promise<GdpduPage> {
  const res = await ctx.db.query("salesDocuments").paginate({ cursor, numItems: PAGE });
  const docs = res.page.filter((d) => d.status !== "draft" && inRange(d.documentDate, r));
  const belege: GdpduRow[] = [];
  const positionen: GdpduRow[] = [];
  const dokumente: GdpduRow[] = [];
  const files: GdpduFileRef[] = [];
  const numbers = new Map<string, string>();
  const numberOf = (id: string) => numbers.get(id);
  for (const d of docs) {
    for (const id of [d.correctsId, d.cancellation?.byDocumentId]) {
      if (!id || numbers.has(id)) continue;
      const o = await ctx.db.get(id);
      if (o?.number) numbers.set(id, o.number);
    }
  }
  let lineCount = 0;
  for (const d of docs) {
    const artifacts = await ctx.db
      .query("documentArtifacts")
      .withIndex("by_document", (q) => q.eq("documentId", d._id))
      .collect();
    const original =
      artifacts.find((a) => a.kind === "zugferd_pdf" && a.variant !== "copy") ??
      artifacts.find((a) => a.kind === "pdf" && a.variant !== "copy") ??
      artifacts.find((a) => a.kind === "xrechnung_xml");
    belege.push(rechnungRow(d, d.billingAddress?.name ?? null, original?.sha256 ?? null, numberOf));
    const lines = await ctx.db
      .query("documentLines")
      .withIndex("by_document", (q) => q.eq("documentId", d._id))
      .collect();
    const items = positionRows(lines);
    lineCount += lines.filter((l) => l.kind === "item").length;
    positionen.push(...items);
    for (const a of artifacts) {
      const path = includeFiles
        ? `rechnungen/${safe(d.number ?? d._id)}_${a.kind}${a.variant ? `_${a.variant}` : ""}.${ext(a.mime, a.name)}`
        : null;
      if (path) files.push({ storageId: a.storageId, path });
      dokumente.push(
        dokumentRow({
          id: a._id,
          table: "salesDocuments",
          entityId: d._id,
          kind: a.kind,
          fileName: path ? `belege/${path}` : null,
          sha256: a.sha256,
          bytes: a.bytes,
          mime: a.mime,
          createdAt: a.createdAt,
        } satisfies FileLike),
      );
    }
  }
  return page(
    res,
    { "rechnungen.csv": belege, "rechnungspositionen.csv": positionen, "dokumente.csv": dokumente },
    { "rechnungen.csv": docs.length, "rechnungspositionen.csv": lineCount },
    files,
  );
}

async function eingangsbelegePage(
  ctx: ReadCtx,
  r: GdpduRange,
  cursor: string | null,
  includeFiles: boolean,
): Promise<GdpduPage> {
  const res = await ctx.db
    .query("vouchers")
    .withIndex("by_documentDate", (q) => q.gte("documentDate", r.from).lte("documentDate", r.to))
    .paginate({ cursor, numItems: PAGE });
  const vouchers = res.page.filter((v) => v.status !== "draft");
  const belege: GdpduRow[] = [];
  const positionen: GdpduRow[] = [];
  const dokumente: GdpduRow[] = [];
  const files: GdpduFileRef[] = [];
  let lineCount = 0;
  for (const v of vouchers) {
    belege.push(eingangsbelegRow(v));
    const lines = await ctx.db
      .query("voucherLines")
      .withIndex("by_voucher", (q) => q.eq("voucherId", v._id))
      .collect();
    lineCount += lines.length;
    positionen.push(...lines.map((l) => eingangsPositionRow(l)));
    v.originalFiles.forEach((f, i) => {
      const path = includeFiles
        ? `eingangsbelege/${safe(v.internalNumber ?? v._id)}_${i + 1}.${ext(f.mime, f.name)}`
        : null;
      if (path) files.push({ storageId: f.storageId, path });
      dokumente.push(
        dokumentRow({
          id: `${v._id}:${i}`,
          table: "vouchers",
          entityId: v._id,
          kind: f.role,
          fileName: path ? `belege/${path}` : null,
          sha256: f.sha256,
          bytes: f.bytes,
          mime: f.mime,
          createdAt: f.capturedAt,
        }),
      );
    });
  }
  return page(
    res,
    { "eingangsbelege.csv": belege, "eingangsbelegpositionen.csv": positionen, "dokumente.csv": dokumente },
    { "eingangsbelege.csv": vouchers.length, "eingangsbelegpositionen.csv": lineCount },
    files,
  );
}

async function zahlungenPage(ctx: ReadCtx, r: GdpduRange, cursor: string | null): Promise<GdpduPage> {
  const res = await ctx.db
    .query("payments")
    .withIndex("by_date", (q) => q.gte("date", r.from).lte("date", r.to))
    .paginate({ cursor, numItems: PAGE });
  return page(
    res,
    { "zahlungen.csv": res.page.map((p) => zahlungRow(p as never)) },
    { "zahlungen.csv": res.page.length },
  );
}

async function bankPage(ctx: ReadCtx, r: GdpduRange, cursor: string | null): Promise<GdpduPage> {
  const res = await ctx.db.query("bankTransactions").paginate({ cursor, numItems: PAGE });
  const rows = res.page.filter((t) => t.status !== "ignored" && inRange(t.bookingDate, r));
  const labels = new Map<string, string>();
  for (const t of rows) {
    if (labels.has(t.accountId)) continue;
    const a = await ctx.db.get(t.accountId);
    labels.set(t.accountId, a?.iban ?? a?.name ?? t.accountId);
  }
  return page(
    res,
    { "bankumsaetze.csv": rows.map((t) => bankRow(t, labels.get(t.accountId) ?? t.accountId)) },
    { "bankumsaetze.csv": rows.length },
  );
}

async function nummernPage(ctx: ReadCtx, r: GdpduRange, cursor: string | null): Promise<GdpduPage> {
  const res = await ctx.db.query("numberRegister").paginate({ cursor, numItems: PAGE });
  const rows = res.page.filter((n) => msInRange(n.assignedAt, r));
  return page(res, { "nummernregister.csv": rows.map((n) => nummerRow(n)) }, { "nummernregister.csv": rows.length });
}

async function protokollPage(ctx: ReadCtx, r: GdpduRange, cursor: string | null): Promise<GdpduPage> {
  const res = await ctx.db.query("auditLog").withIndex("by_seq").paginate({ cursor, numItems: PAGE });
  // E-EXP-34: the purge evidence (tombstones, chain anchors) of later purge runs is part of the year's log.
  const purgeEvidence = (e: { action: string; at: number }) =>
    (e.action === "retention.purge" || e.action === "retention.anchor") && berlinCalendarDate(e.at) > r.to;
  const rows = res.page.filter((e) => msInRange(e.at, r) || purgeEvidence(e));
  return page(res, { "protokoll.csv": rows.map((e) => protokollRow(e)) }, { "protokoll.csv": rows.length });
}

export async function gdpduSourcePage(
  ctx: ReadCtx,
  args: { source: GdpduSource; year: number; cursor: string | null; includeFiles: boolean; now: number },
): Promise<GdpduPage> {
  const r = await gdpduRange(ctx, args.year);
  switch (args.source) {
    case "firma":
      return firmaPage(ctx, r);
    case "kontakte":
      return kontaktePage(ctx, args.cursor);
    case "journal":
      return journalPage(ctx, r, args.cursor, args.now);
    case "rechnungen":
      return rechnungenPage(ctx, r, args.cursor, args.includeFiles);
    case "eingangsbelege":
      return eingangsbelegePage(ctx, r, args.cursor, args.includeFiles);
    case "zahlungen":
      return zahlungenPage(ctx, r, args.cursor);
    case "bank":
      return bankPage(ctx, r, args.cursor);
    case "nummern":
      return nummernPage(ctx, r, args.cursor);
    case "protokoll":
      return protokollPage(ctx, r, args.cursor);
  }
}

/** Package metadata read by the worker (supplier, range, restricted contacts, purge batches, cash opening). */
export async function gdpduMeta(ctx: ReadCtx, jobId: Id<"jobs">, now: number) {
  const job = await ctx.db.get(jobId);
  if (!job || job.kind !== "gdpdu_export" || (job.status !== "queued" && job.status !== "running")) return null;
  const params = job.params as { year: number; encoding: "utf8" | "ansi"; includeFiles: boolean };
  const r = await gdpduRange(ctx, params.year);
  const profile = await getCompanyProfile(ctx);
  let restricted = 0;
  for await (const c of ctx.db.query("contacts")) if (c.dsgvo?.restrictedAt !== undefined) restricted++;
  const purges = (await ctx.db.query("purgeBatches").withIndex("by_createdAt").collect())
    .filter((b) => b.status === "done")
    .map((b) => ({
      id: b._id as string,
      date: berlinCalendarDate(b.createdAt).split("-").reverse().join("."),
      classes: b.classes,
      count: Object.values(b.counts ?? {}).reduce((s: number, n) => s + Number(n), 0),
    }));
  return {
    ...params,
    range: { from: r.from, to: r.to },
    supplier: { name: profile?.name ?? "—", location: profile?.address?.city ?? "—" },
    restrictedContacts: restricted,
    purges,
    cash: await cashOpening(ctx, r, now),
  };
}

// ── start + completion ───────────────────────────────────────────────────────────────────────────────

export const GDPDU_MESSAGES_DE = {
  year: "Bitte ein Wirtschaftsjahr zwischen 2000 und dem laufenden Jahr wählen.",
} as const;

export async function startGdpduExport(
  ctx: ModelCtx,
  args: { year: number; encoding: "utf8" | "ansi"; includeFiles: boolean },
): Promise<Id<"jobs">> {
  const current = Number(berlinCalendarDate(ctx.now()).slice(0, 4));
  if (!Number.isInteger(args.year) || args.year < 2000 || args.year > current) {
    throw appError("invalid_input", GDPDU_MESSAGES_DE.year);
  }
  return createJob(ctx, {
    kind: "gdpdu_export",
    label: `GDPdU-Export ${args.year}`,
    params: args,
    total: GDPDU_SOURCES.length + 1,
  });
}

/** Records a finished package (append-only `gdpduExports`; the auditor's Z3 download list, AUD-023). */
export async function recordGdpduExport(
  ctx: ModelCtx,
  job: Doc<"jobs">,
  file: { storageId: Id<"_storage">; name: string; sha256: string; bytes: number; counts: Record<string, number> },
) {
  const params = job.params as { year: number; encoding: "utf8" | "ansi"; includeFiles: boolean };
  return auditedInsert(
    ctx,
    "gdpduExports",
    {
      year: params.year,
      encoding: params.encoding,
      includeFiles: params.includeFiles,
      jobId: job._id,
      storageId: file.storageId,
      name: file.name,
      sha256: file.sha256,
      bytes: file.bytes,
      counts: file.counts,
      createdAt: ctx.now(),
      actor: job.by.actor,
    },
    { action: "export.gdpdu", label: file.name },
  );
}

/** AUD-023: packages visible to the caller — the auditor only those of the granted fiscal years. */
export async function listGdpduExports(ctx: ReadCtx, years: readonly number[] | null) {
  const rows = await ctx.db.query("gdpduExports").withIndex("by_year").order("desc").collect();
  return rows
    .filter((r) => years === null || years.includes(r.year))
    .map((r) => ({
      id: r._id,
      year: r.year,
      encoding: r.encoding,
      includeFiles: r.includeFiles,
      name: r.name,
      sha256: r.sha256,
      bytes: r.bytes,
      createdAt: r.createdAt,
    }));
}
