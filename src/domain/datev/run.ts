/**
 * F09 §4.1.3 DATEV export flow (pure): settings check (E-EXP-01), line selection with the re-export rules (EXP-010,
 * EC-174), Festschreibung (EXP-011), personal accounts (EXP-006), mapping and validation per fiscal year (EXP-005,
 * EXP-007, E-EXP-02), master data (EXP-013), document index (EXP-014/015) and the report. The same function serves
 * the dry run („Prüfen", no bytes) and the export job; Convex only loads the data and stores the result.
 */
import { sha256Hex } from "../audit/chain";
import { type BookingFormatVersion, bookingColumns } from "./columns";
import { type DatevDocInput, datevDocumentPackage, deterministicGuid } from "./documents";
import { buchungsstapelFile, debitorenKreditorenFile, type ExtfHeader, type ExtfRow, extfTimestamp } from "./extf";
import { validateDatevKeys } from "./keys";
import {
  DATEV_MESSAGES,
  type DatevBeleg,
  type DatevIssue,
  type DatevJournalEntry,
  type DatevMapContext,
  mapEntries,
} from "./mapping";
import {
  assignPersonalAccounts,
  type DatevContactInput,
  masterDataRow,
  type PreviousExport,
  planReexport,
} from "./masterdata";

export const DATEV_SCOPES = [
  "revenue",
  "vouchers",
  "payments",
  "assets",
  "manual",
  "master_data",
  "documents",
] as const;
export type DatevScope = (typeof DATEV_SCOPES)[number];
export type DatevBookingScope = Exclude<DatevScope, "master_data" | "documents">;

/**
 * EXP-008: which booking scope a journal entry belongs to. `revenue` = sales documents and their payments;
 * `vouchers` = purchase vouchers; `payments` = other payments (voucher payments, credits), bank-rule bookings and
 * cash transfers; `assets` = AfA/disposals; `manual` = manual, opening, tax, FX and closing entries.
 */
export function bookingScopeOf(sourceKind: string, paymentTargetKind?: string): DatevBookingScope {
  switch (sourceKind) {
    case "salesDocument":
      return "revenue";
    case "voucher":
      return "vouchers";
    case "payment":
      return paymentTargetKind === "salesDocument" || paymentTargetKind === "opening_item" ? "revenue" : "payments";
    case "bankTransaction":
    case "cashTransfer":
      return "payments";
    case "asset_depreciation":
      return "assets";
    default:
      return "manual";
  }
}

export interface DatevRunSettings {
  consultantNumber?: number | undefined;
  clientNumber?: number | undefined;
  accountLength: number;
  formatVersion: BookingFormatVersion;
  personalAccounts: boolean;
  collectiveDebtorAccount?: string | undefined;
  companyName: string;
}

export interface DatevYear {
  from: string;
  to: string;
  fiscalYearStart: string;
  chart: "SKR03" | "SKR04";
  /** Accounts of the chart for that year plus bank/cash ledgers; `auto` = DATEV automatic VAT account. */
  accounts: readonly { n: string; auto: boolean }[];
}

export interface DatevContactData extends Omit<DatevContactInput, "account"> {
  id: string;
  debtorAccount?: string | undefined;
  creditorAccount?: string | undefined;
  useCollectiveDebtor?: boolean | undefined;
}

export interface DatevDocData {
  /** Source id of the journal entry (sales document or voucher id). */
  sourceId: string;
  belegfeld1: string;
  numbered: boolean;
  files: readonly { ext: string; sha256: string; bytes?: Uint8Array | undefined }[];
}

export interface DatevRunInput {
  from: string;
  to: string;
  mode: "new" | "full";
  scope: readonly DatevScope[];
  /** Requested Festschreibung (default: 1 when every month of the range is locked, EXP-011). */
  festschreibung?: boolean | undefined;
  /** E-EXP-05 confirmation of a full re-export of an unlocked range. */
  confirmReplace?: boolean | undefined;
  settings: DatevRunSettings;
  years: readonly DatevYear[];
  lockedMonths: readonly string[];
  /** EXP-011: blockers of the requested period lock (F08 ACC-017 checklist) — blocking errors. */
  lockBlockers?: readonly string[] | undefined;
  /** Exports whose range overlaps the requested one. */
  previous: readonly PreviousExport[];
  /** Entries of the range in the selected booking scopes, ordered by seq. */
  entries: readonly DatevJournalEntry[];
  /** Beleg data per `source.id`. */
  belege: Readonly<Record<string, DatevBeleg>>;
  contacts: readonly DatevContactData[];
  /** Document files per source (sales documents, vouchers) of the range. */
  docs: readonly DatevDocData[];
  /** Personal account numbers in use (all contacts) — the dry run previews the numbers it would assign. */
  usedAccounts: readonly string[];
  /** Contacts that received an account number for this export (E-EXP-13 info of the job). */
  assignedCount?: number | undefined;
  accepted: boolean;
  createdAt: number;
}

export interface DatevReport {
  issues: DatevIssue[];
  blocking: boolean;
  /** E-EXP-03 / empty range: no file is written. */
  nothingToExport: boolean;
  needsConfirmation: string | null;
  festschreibung: 0 | 1;
  isRepeat: boolean;
  doNotReimport: boolean;
  files: { name: string; rows: number }[];
  rowCount: number;
  sumUmsatzCents: number;
  entryCount: number;
  accepted: boolean;
}

export interface DatevRunResult {
  report: DatevReport;
  /** ZIP content (file name → bytes). */
  files: Record<string, Uint8Array>;
  lineIds: string[];
  fileHashes: { name: string; sha256: string; rowsSha256?: string }[];
  /** Contacts that need a personal account before the real export (EXP-006). */
  needsAccount: { contactId: string; kind: "debtor" | "creditor" }[];
}

const MASTER_FILE = "EXTF_Debitoren_Kreditoren.csv";
const monthLabel = (p: string) => `${p.slice(5, 7)}/${p.slice(0, 4)}`;

/** Months "YYYY-MM" covered by [from, to]. */
export function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (;;) {
    const p = `${y}-${String(m).padStart(2, "0")}`;
    if (p > end) break;
    out.push(p);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** Header Bezeichnung (≤ 30): „Rechnungen 10/2026", „Rechnungen 10/2026–12/2026"; repeats „Wiederholung …". */
export function batchDescription(from: string, to: string, repeat: boolean): string {
  const a = monthLabel(from.slice(0, 7));
  const b = monthLabel(to.slice(0, 7));
  const label = a === b ? a : `${a}–${b}`;
  return `${repeat ? "Wiederholung" : "Rechnungen"} ${label}`.slice(0, 30);
}

const lineIdsOf = (e: DatevJournalEntry) => e.lines.map((_, i) => `${e.id}:${i}`);
const formatDate = (ms: number) => {
  const d = new Date(ms + 3_600_000); // display only (date of a past export)
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
};

export async function runDatevExport(input: DatevRunInput): Promise<DatevRunResult> {
  const issues: DatevIssue[] = [];
  const add = (level: DatevIssue["level"], code: string, message: string) => issues.push({ level, code, message });
  const s = input.settings;
  const empty = (report: Partial<DatevReport>): DatevRunResult => ({
    report: {
      issues,
      blocking: issues.some((i) => i.level === "error"),
      nothingToExport: true,
      needsConfirmation: null,
      festschreibung: 0,
      isRepeat: false,
      doNotReimport: false,
      files: [],
      rowCount: 0,
      sumUmsatzCents: 0,
      entryCount: 0,
      accepted: input.accepted,
      ...report,
    },
    files: {},
    lineIds: [],
    fileHashes: [],
    needsAccount: [],
  });

  // settings (E-EXP-01, SET-044)
  if (s.consultantNumber === undefined || s.clientNumber === undefined)
    add("error", "DATEV_KEYS_MISSING", DATEV_MESSAGES.keysMissing);
  for (const i of validateDatevKeys(s)) add("error", i.code, i.message);
  if (input.from > input.to || input.years.length === 0) add("error", "DATEV_RANGE", DATEV_MESSAGES.rangeInvalid);
  if (input.scope.length === 0) add("error", "DATEV_SCOPE", DATEV_MESSAGES.nothingSelected);
  for (const m of input.lockBlockers ?? []) add("error", "DATEV_LOCK_BLOCKED", m);
  if (issues.some((i) => i.level === "error")) return empty({ nothingToExport: false });
  if (input.years.length > 1) add("info", "DATEV_TWO_YEARS", DATEV_MESSAGES.twoYears);

  // EXP-010 / EC-174: which lines go into this export
  const allIds = input.entries.flatMap(lineIdsOf);
  const plan = planReexport({ mode: input.mode, lineIds: allIds, previous: input.previous, formatDate });
  const chosen = new Set(plan.lineIds);
  const entries = input.entries.filter((e) => lineIdsOf(e).some((id) => chosen.has(id)));
  if (plan.info) add("info", plan.doNotReimport ? "DATEV_LOCKED_REPEAT" : "DATEV_NOTHING_NEW", plan.info);
  if (input.mode === "new" && input.previous.length > 0) {
    const late = entries.filter((e) => e.originalDate !== undefined).length;
    if (late > 0)
      add("info", "DATEV_LATE", `${late} nachträgliche Buchungen zu bereits exportierten Zeiträumen enthalten.`);
  }
  if (input.mode === "full" && input.previous.length > 0 && !plan.doNotReimport) {
    const before = new Set(input.previous.flatMap((p) => p.lineIds));
    const now = new Set(allIds);
    const added = allIds.filter((id) => !before.has(id)).length;
    const removed = [...before].filter((id) => !now.has(id)).length;
    add("info", "DATEV_DIFF", DATEV_MESSAGES.diff(added, removed));
  }
  const withMaster = input.scope.includes("master_data");
  if (entries.length === 0 && (!withMaster || plan.info)) {
    if (!plan.info) add("info", "DATEV_EMPTY", "Im gewählten Zeitraum und Umfang gibt es keine Buchungen.");
    return empty({ isRepeat: plan.repeat });
  }

  // EXP-011 Festschreibung
  const months = monthsOf(input.from, input.to);
  const locked = new Set(input.lockedMonths);
  const unlocked = months.filter((m) => !locked.has(m));
  const requested = input.festschreibung ?? unlocked.length === 0;
  if (requested && unlocked.length > 0) {
    add(
      "warning",
      "DATEV_FORCED_ZERO",
      `Nicht festgeschriebene Monate (${unlocked.map(monthLabel).join(", ")}) werden ohne Festschreibung exportiert.`,
    );
  }
  const festschreibung: 0 | 1 = requested && unlocked.length === 0 ? 1 : 0;

  // EXP-006 personal accounts
  const contacts = new Map(input.contacts.map((c) => [c.id, c]));
  const used = [...input.usedAccounts];
  const provisional = new Map<string, string>();
  const needsAccount: DatevRunResult["needsAccount"] = [];
  const personalAccount = (contactId: string, kind: "debtor" | "creditor"): string | null => {
    if (!s.personalAccounts) return null;
    const c = contacts.get(contactId);
    if (kind === "debtor" && c?.useCollectiveDebtor) return s.collectiveDebtorAccount ?? null;
    const own = kind === "debtor" ? c?.debtorAccount : c?.creditorAccount;
    if (own) return own;
    const key = `${kind}:${contactId}`;
    const known = provisional.get(key);
    if (known) return known;
    const [nr] = assignPersonalAccounts(1, kind, used, s.accountLength);
    used.push(nr as string);
    provisional.set(key, nr as string);
    needsAccount.push({ contactId, kind });
    return nr as string;
  };

  // EXP-014/015 documents: GUID per source with files (Beleglink only when the file is in the ZIP)
  const withDocs = input.scope.includes("documents");
  const docBySource = new Map(input.docs.filter((d) => d.files.length > 0).map((d) => [d.sourceId, d]));
  const usedSources = new Set(entries.map((e) => e.source.id));
  let missingFiles = 0;
  if (withDocs) {
    for (const e of entries) {
      if ((e.source.kind === "salesDocument" || e.source.kind === "voucher") && !docBySource.has(e.source.id))
        missingFiles++;
    }
    if (missingFiles > 0) add("warning", "DATEV_MISSING_FILES", DATEV_MESSAGES.missingFiles(missingFiles));
  }

  const out: Record<string, Uint8Array> = {};
  const fileHashes: DatevRunResult["fileHashes"] = [];
  const reportFiles: DatevReport["files"] = [];
  const lineIds: string[] = [];
  const transliterated = new Map<string, string>();
  let rowCount = 0;
  let umsatz = 0;
  const createdAt = extfTimestamp(input.createdAt);
  const repeatIndex = input.previous.length;
  const allRows: ExtfRow[] = [];

  for (const y of input.years) {
    const yearEntries = entries.filter((e) => e.date >= y.from && e.date <= y.to);
    if (yearEntries.length === 0) continue;
    const accounts = new Map(y.accounts.map((a) => [a.n, a.auto]));
    const ctx: DatevMapContext = {
      accountLength: s.accountLength,
      festschreibung,
      from: y.from,
      to: y.to,
      isAutomatic: (a) => accounts.get(a) === true,
      accountExists: (a) => accounts.has(a),
      personalAccount,
      beleg: (e) => {
        const b = input.belege[e.source.id] ?? {};
        return withDocs && docBySource.has(e.source.id) ? { ...b, guid: deterministicGuid(e.source.id) } : b;
      },
    };
    const r = mapEntries(yearEntries, ctx);
    issues.push(...r.issues);
    lineIds.push(...r.lineIds);
    allRows.push(...r.rows);
    const header: ExtfHeader = {
      category: 21,
      formatName: "Buchungsstapel",
      formatVersion: s.formatVersion,
      createdAt,
      exportedBy: s.companyName,
      consultantNumber: s.consultantNumber as number,
      clientNumber: s.clientNumber as number,
      fiscalYearStart: y.fiscalYearStart,
      accountLength: s.accountLength,
      from: y.from,
      to: y.to,
      description: batchDescription(y.from, y.to, plan.repeat),
      festschreibung,
      chart: y.chart,
    };
    const f = buchungsstapelFile(header, s.formatVersion, r.rows);
    const name = `EXTF_Buchungsstapel_${y.from.replaceAll("-", "")}_${y.to.replaceAll("-", "")}${repeatIndex > 0 ? `_${repeatIndex + 1}` : ""}.csv`;
    for (const [a, b] of f.encoded.transliterated) transliterated.set(a, b);
    for (const ch of f.encoded.unmappable) transliterated.set(ch, "?");
    out[name] = f.encoded.bytes;
    const rowsText = f.text.slice(f.text.indexOf("\r\n") + 2);
    fileHashes.push({ name, sha256: await sha256Hex(f.encoded.bytes), rowsSha256: await sha256Hex(rowsText) });
    reportFiles.push({ name, rows: r.rows.length });
    rowCount += r.rows.length;
    umsatz += r.umsatzCents;
  }

  // E-EXP-04: a full re-export of a festgeschrieben range must reproduce the first export's rows
  if (plan.mustEqual) {
    const prev = plan.mustEqual;
    const before = new Set(input.previous.flatMap((p) => p.lineIds));
    const sameLines = lineIds.every((id) => before.has(id));
    const sameRange = prev.from === input.from && prev.to === input.to;
    const prevRows = Object.entries(prev.sha256ByFile)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, h]) => h);
    const nowRows = fileHashes.map((h) => h.rowsSha256);
    const sameRows = !sameRange || (prevRows.length === nowRows.length && prevRows.every((h, i) => h === nowRows[i]));
    if (!sameLines || !sameRows)
      add(
        "error",
        "DATEV_LOCKED_CHANGED",
        "Der festgeschriebene Zeitraum hat sich seit dem Export verändert – Integritätsfehler, Export abgebrochen.",
      );
  }

  // EXP-013 master data: every contact with a personal account (plus the ones assigned for this export)
  const fyStart = input.years[0] as DatevYear;
  if (withMaster) {
    const masterRows: ExtfRow[] = [];
    const rowsFor = (c: DatevContactData, account: string | undefined) => {
      if (account) masterRows.push(masterRow(c, account));
    };
    for (const c of input.contacts) {
      if (!s.personalAccounts) break;
      rowsFor(c, c.debtorAccount ?? provisional.get(`debtor:${c.id}`));
      rowsFor(c, c.creditorAccount ?? provisional.get(`creditor:${c.id}`));
    }
    masterRows.sort((a, b) => cellText(a.Konto).localeCompare(cellText(b.Konto)));
    if (masterRows.length > 0) {
      const f = debitorenKreditorenFile(
        {
          category: 16,
          formatName: "Debitoren/Kreditoren",
          formatVersion: 5,
          createdAt,
          exportedBy: s.companyName,
          consultantNumber: s.consultantNumber as number,
          clientNumber: s.clientNumber as number,
          fiscalYearStart: fyStart.fiscalYearStart,
          accountLength: s.accountLength,
          chart: fyStart.chart,
        },
        masterRows,
      );
      for (const [a, b] of f.encoded.transliterated) transliterated.set(a, b);
      for (const ch of f.encoded.unmappable) transliterated.set(ch, "?");
      out[MASTER_FILE] = f.encoded.bytes;
      fileHashes.push({ name: MASTER_FILE, sha256: await sha256Hex(f.encoded.bytes) });
      reportFiles.push({ name: MASTER_FILE, rows: masterRows.length });
    }
  }
  if (transliterated.size > 0) {
    const [[a, b]] = [...transliterated] as [[string, string]];
    add("warning", "DATEV_TRANSLITERATED", DATEV_MESSAGES.transliterated(transliterated.size, a, b));
  }
  if (needsAccount.length > 0)
    add("info", "DATEV_ACCOUNTS_TO_ASSIGN", DATEV_MESSAGES.accountsToAssign(needsAccount.length));
  if (input.assignedCount) add("info", "DATEV_ACCOUNTS_ASSIGNED", DATEV_MESSAGES.accountsAssigned(input.assignedCount));

  // EXP-014 document ZIP part
  if (withDocs) {
    const docs: DatevDocInput[] = [...docBySource.values()]
      .filter((d) => usedSources.has(d.sourceId))
      .map((d) => ({
        belegfeld1: d.belegfeld1,
        sourceId: d.sourceId,
        numbered: d.numbered,
        files: d.files.map((f) => ({ ext: f.ext, sha256: f.sha256, bytes: f.bytes ?? new Uint8Array() })),
      }));
    if (docs.length > 0) {
      const pkg = datevDocumentPackage(docs, {
        createdAt: new Date(input.createdAt).toISOString().slice(0, 19),
        description: batchDescription(input.from, input.to, plan.repeat),
      });
      // EXP-007: every Beleglink target is in the ZIP
      const guids = new Set(pkg.guids.values());
      const cols = bookingColumns(s.formatVersion);
      if (cols.includes("Beleglink")) {
        for (const row of allRows) {
          const link = /^BEDI "(.+)"$/.exec(cellText(row.Beleglink))?.[1];
          if (link && !guids.has(link))
            add("error", "DATEV_BELEGLINK", `Beleglink ${link} verweist auf keine Datei im Export.`);
        }
      }
      for (const [name, bytes] of Object.entries(pkg.files)) out[name] = bytes;
      const enc = new TextEncoder();
      out["document.xml"] = enc.encode(pkg.documentXml);
      out["manifest.csv"] = enc.encode(pkg.manifestCsv);
    }
  }

  const needsConfirmation = plan.needsConfirmation && !input.confirmReplace ? plan.needsConfirmation : null;
  return {
    report: {
      issues,
      blocking: issues.some((i) => i.level === "error"),
      nothingToExport: false,
      needsConfirmation,
      festschreibung,
      isRepeat: plan.repeat,
      doNotReimport: plan.doNotReimport,
      files: reportFiles,
      rowCount,
      sumUmsatzCents: umsatz,
      entryCount: entries.length,
      accepted: input.accepted,
    },
    files: out,
    lineIds,
    fileHashes,
    needsAccount,
  };
}

function cellText(c: unknown): string {
  if (!c || typeof c !== "object") return "";
  const o = c as { t?: string; r?: string };
  return o.t ?? o.r ?? "";
}

function masterRow(c: DatevContactData, account: string): ExtfRow {
  const { id: _id, debtorAccount: _d, creditorAccount: _c, useCollectiveDebtor: _u, ...rest } = c;
  return masterDataRow({ ...rest, account });
}
