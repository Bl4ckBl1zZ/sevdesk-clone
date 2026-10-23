/**
 * sevdesk's DATEV export as reference data (F09 IMP-026, §4.3.1 row "DATEV export from sevdesk").
 *
 * The EXTF reader is the counterpart of our writer (`src/domain/datev/extf.ts`): line 1 = the 31-field header
 * (format category 21 Buchungsstapel / 16 Debitoren/Kreditoren, version, Sachkontenlänge, chart), line 2 = column
 * names, then data rows (`;`, text in `"`). What we take: Stammdaten → `contacts.debtorAccount/creditorAccount`;
 * Buchungsstapel → revenue account / BU key per Belegfeld 1 refine the tax case of imported invoices (IMP-010). The
 * bookings themselves never enter our journal.
 *
 * Pure: decoded text in, reference data out.
 */
import { foldSearch, normalizeContactNumber } from "../../contacts/core";
import { parseCsvRecords } from "../../csv/csv";
import { personalAccountRanges } from "../../datev/keys";
import { vatCents } from "../../money/vat";
import { normalizeNumber } from "../../numbering/format";
import { err, type Issue, issue, ok, type Result } from "../../result";
import type { Chart } from "../../rules/accounting/types";
import { datevBuRow } from "../../rules/datev-bu";
import { type RevenueTaxHint, revenueTaxHint } from "../../rules/import/datev-revenue-roles";
import type { ImportedDocument } from "./invoices";
import type { ImportFinding } from "./types";

export interface ExtfTable {
  readonly category: 16 | 21;
  readonly formatName: string;
  readonly formatVersion: number;
  readonly accountLength?: number;
  readonly chart?: Chart;
  /** "YYYY-MM-DD" from header field 13 (Wirtschaftsjahr-Beginn). */
  readonly fiscalYearStart?: string;
  readonly columns: string[];
  readonly rows: { readonly line: number; readonly cells: string[] }[];
}

export type ExtfIssueCode = "extf_header" | "extf_category" | "extf_empty";

/** EXTF text (already decoded) → header facts, column names and rows. */
export function parseExtf(text: string): Result<ExtfTable, Issue<ExtfIssueCode>> {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const [header, columns, ...rows] = parseCsvRecords(clean, ";");
  if (header?.cells[0]?.trim() !== "EXTF") {
    return err(issue("extf_header", "Die Datei beginnt nicht mit einem DATEV-Kopfsatz (EXTF)."));
  }
  const category = Number(header.cells[2]);
  if (category !== 16 && category !== 21) {
    return err(
      issue(
        "extf_category",
        `DATEV-Formatkategorie ${header.cells[2] ?? "?"} wird nicht gelesen (nur Buchungsstapel 21 und Debitoren/Kreditoren 16).`,
      ),
    );
  }
  if (!columns) return err(issue("extf_empty", "Die DATEV-Datei enthält keine Spaltenüberschriften."));
  const ymd = header.cells[12]?.trim() ?? "";
  const accountLength = Number(header.cells[13]);
  const skr = header.cells[26]?.trim();
  return ok({
    category,
    formatName: header.cells[3]?.trim() ?? "",
    formatVersion: Number(header.cells[4]),
    ...(Number.isInteger(accountLength) && accountLength >= 4 && accountLength <= 8 ? { accountLength } : {}),
    ...(skr === "03" ? { chart: "SKR03" as const } : skr === "04" ? { chart: "SKR04" as const } : {}),
    ...(/^\d{8}$/.test(ymd) ? { fiscalYearStart: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` } : {}),
    columns: columns.cells.map((c) => c.trim()),
    rows,
  });
}

// ── reference data ─────────────────────────────────────────────────────────────────────────────────────

export interface DatevPersonalAccount {
  readonly fileId: string;
  readonly line: number;
  readonly account: string;
  readonly kind: "debtor" | "creditor";
  readonly name: string;
  readonly customerNumber?: string;
}

export interface DatevBookingHint {
  readonly fileId: string;
  readonly line: number;
  /** Normalised Belegfeld 1 (the invoice number). */
  readonly belegfeld1: string;
  readonly accounts: readonly string[];
  readonly bu: string;
}

export interface DatevReference {
  readonly accounts: DatevPersonalAccount[];
  readonly bookings: DatevBookingHint[];
  /** Chart of the Buchungsstapel (header field 27). */
  readonly chart?: Chart;
}

/** Column value by DATEV column name. */
const col = (t: ExtfTable, row: { cells: string[] }, name: string) => {
  const i = t.columns.indexOf(name);
  return i < 0 ? "" : (row.cells[i] ?? "").trim();
};

/**
 * IMP-026: reference data of one EXTF file. Stammdaten rows outside the personal-account ranges of the header's
 * Sachkontenlänge (§5.3 debtors 10^L … 7·10^L − 1, creditors above) are reported and ignored.
 */
export function datevReference(
  t: ExtfTable,
  file: { id: string; name: string },
): { reference: DatevReference; findings: ImportFinding[] } {
  const findings: ImportFinding[] = [];
  const accounts: DatevPersonalAccount[] = [];
  const bookings: DatevBookingHint[] = [];
  if (t.category === 16) {
    const ranges = personalAccountRanges(t.accountLength ?? 4);
    for (const r of t.rows) {
      const account = col(t, r, "Konto");
      if (!account) continue;
      const n = Number(account);
      const kind =
        /^\d+$/.test(account) && n >= ranges.debtors.from && n <= ranges.debtors.to
          ? "debtor"
          : /^\d+$/.test(account) && n >= ranges.creditors.from && n <= ranges.creditors.to
            ? "creditor"
            : null;
      if (!kind) {
        findings.push({
          code: "E-IMP-49",
          severity: "warning",
          message: `${file.name}, Zeile ${r.line}: Konto ${account} ist kein Personenkonto (Sachkontenlänge ${t.accountLength ?? 4}) und wird ignoriert.`,
          fileId: file.id,
          fileName: file.name,
          line: r.line,
        });
        continue;
      }
      const person = [
        col(t, r, "Vorname (Adressatentyp natürl. Person)"),
        col(t, r, "Name (Adressatentyp natürl. Person)"),
      ]
        .filter(Boolean)
        .join(" ");
      const name =
        col(t, r, "Name (Adressatentyp Unternehmen)") ||
        person ||
        col(t, r, "Name (Adressatentyp keine Angabe)") ||
        col(t, r, "Kurzbezeichnung");
      const customerNumber = col(t, r, "Kundennummer");
      accounts.push({
        fileId: file.id,
        line: r.line,
        account,
        kind,
        name,
        ...(customerNumber ? { customerNumber } : {}),
      });
    }
  } else {
    for (const r of t.rows) {
      const belegfeld1 = col(t, r, "Belegfeld 1");
      if (!belegfeld1) continue;
      bookings.push({
        fileId: file.id,
        line: r.line,
        belegfeld1: normalizeNumber(belegfeld1),
        accounts: [col(t, r, "Konto"), col(t, r, "Gegenkonto (ohne BU-Schlüssel)")].filter(Boolean),
        bu: col(t, r, "BU-Schlüssel"),
      });
    }
  }
  return { reference: { accounts, bookings, ...(t.chart ? { chart: t.chart } : {}) }, findings };
}

/** G/L account as written with a Sachkontenlänge > 4 („84000“) → the 4-digit chart number. */
const chartAccount = (a: string) => (a.length > 4 && /^\d{4}0+$/.test(a) ? a.slice(0, 4) : a);

/** BU key → VAT rate of the date's DATEV table (USt keys only); `undefined` = no key / not a USt key. */
function buRate(bu: string, date: string): number | undefined {
  if (!bu) return undefined;
  const row = datevBuRow(date);
  if (!row) return undefined;
  const taxKey = Object.entries(row.keys).find(([k, v]) => v === bu && k.startsWith("USt"))?.[0];
  return taxKey ? row.rates[taxKey] : undefined;
}

export type DatevHintResult =
  | { readonly kind: "hint"; readonly hint: RevenueTaxHint; readonly account: string }
  | { readonly kind: "ambiguous"; readonly reason: string }
  | { readonly kind: "none" };

/** The tax hint of one invoice from its DATEV lines (Belegfeld 1): exactly one mapped revenue role, BU consistent. */
export function datevHintFor(
  bookings: readonly DatevBookingHint[],
  chart: Chart,
  number: string,
  date: string,
): DatevHintResult {
  const mine = bookings.filter((b) => b.belegfeld1 === normalizeNumber(number));
  if (mine.length === 0) return { kind: "none" };
  const hits = new Map<string, { hint: RevenueTaxHint; account: string }>();
  for (const b of mine) {
    for (const a of b.accounts) {
      const hint = revenueTaxHint(chart, chartAccount(a));
      if (!hint) continue;
      const rate = buRate(b.bu, date);
      if (rate !== undefined && rate !== hint.rateBp) {
        return { kind: "ambiguous", reason: `BU-Schlüssel ${b.bu} passt nicht zu Konto ${a}` };
      }
      hits.set(hint.role, { hint, account: chartAccount(a) });
    }
  }
  if (hits.size === 0) return { kind: "none" };
  if (hits.size > 1)
    return {
      kind: "ambiguous",
      reason: `mehrere Erlöskonten (${[...hits.values()].map((h) => h.account).join(", ")})`,
    };
  const [only] = [...hits.values()];
  return only ? { kind: "hint", ...only } : { kind: "none" };
}

/** Amounts consistent with the hint: rate > 0 → VAT = net × rate within 1 ct per group; rate 0 → no VAT. */
const fits = (doc: ImportedDocument, hint: RevenueTaxHint) =>
  doc.groups.length > 0 &&
  doc.groups.every((g) =>
    hint.rateBp === 0
      ? g.vatCents === 0
      : g.vatCents !== 0 && Math.abs(vatCents(g.netCents, hint.rateBp) - g.vatCents) <= 1,
  );

/**
 * IMP-010 / §4.3.2 with the DATEV export (input 2): refines the tax case of imported invoices. Priority: an explicit
 * tax-rule label wins (a contradicting DATEV account is a warning); the DATEV account beats amounts and the company's
 * Kleinunternehmer history — but only when the exported amounts fit the account's rate (the list has no VAT column,
 * so a 19 % revenue account on an invoice without VAT stays a warning, never a change). E-IMP-48.
 */
export function refineWithDatev(
  documents: readonly ImportedDocument[],
  reference: DatevReference,
  findings: ImportFinding[],
): { documents: ImportedDocument[]; refined: number } {
  const chart = reference.chart;
  if (!chart || reference.bookings.length === 0) return { documents: [...documents], refined: 0 };
  let refined = 0;
  const out = documents.map((d) => {
    const r = datevHintFor(reference.bookings, chart, d.number, d.documentDate);
    const at = { fileId: d.fileId, line: d.line, rowRef: d.rowRef, key: d.key };
    if (r.kind === "none") return d;
    if (r.kind === "ambiguous") {
      findings.push({
        code: "E-IMP-48",
        severity: "warning",
        message: `${d.number}: DATEV-Export nicht eindeutig (${r.reason}) – Steuerfall bleibt wie aus der Liste ermittelt.`,
        ...at,
      });
      return d;
    }
    const { hint, account } = r;
    if (d.taxCase === hint.taxCase && (hint.rateBp === 0 || d.groups.every((g) => g.rateBp === hint.rateBp))) return d;
    if (d.taxCaseFromLabel) {
      findings.push({
        code: "E-IMP-48",
        severity: "warning",
        message: `${d.number}: Konto ${account} im DATEV-Export widerspricht der Steuerregel aus der Rechnungsliste – die Steuerregel gilt.`,
        ...at,
      });
      return d;
    }
    if (!fits(d, hint)) {
      findings.push({
        code: "E-IMP-48",
        severity: "warning",
        message: `${d.number}: Konto ${account} im DATEV-Export passt nicht zu den Beträgen der Rechnungsliste – Steuerfall nicht übernommen.`,
        ...at,
      });
      return d;
    }
    refined++;
    const { taxCaseFromCompany: _company, ...rest } = d;
    return {
      ...rest,
      taxCase: hint.taxCase,
      groups: d.groups.map((g) => ({ ...g, category: hint.category, rateBp: hint.rateBp })),
      deviations: [
        ...d.deviations.filter((x) => !x.startsWith("Steuerfall nicht eindeutig")),
        `Steuerfall aus dem DATEV-Export von sevdesk (Konto ${account}).`,
      ],
    };
  });
  if (refined > 0) {
    // The E-IMP-09 warnings of refined rows no longer apply.
    const refinedKeys = new Set(out.filter((d, i) => d !== documents[i]).map((d) => d.key));
    for (let i = findings.length - 1; i >= 0; i--) {
      const f = findings[i];
      if (f?.code === "E-IMP-09" && f.key && refinedKeys.has(f.key)) findings.splice(i, 1);
    }
  }
  return { documents: out, refined };
}

// ── personal accounts → contacts (plan) ───────────────────────────────────────────────────────────────

/** The contact a DATEV account lands on: a contact of this import (by key) or a local one. */
export type AccountContactRef =
  | { readonly kind: "import"; readonly key: string }
  | { readonly kind: "local"; readonly id: string };

export interface PlannedAccount {
  readonly account: string;
  readonly field: "debtorAccount" | "creditorAccount";
  readonly contact: AccountContactRef;
  readonly contactLabel: string;
  readonly status: "new" | "skip" | "conflict";
}

export interface AccountMatchInput {
  readonly accounts: readonly DatevPersonalAccount[];
  /** Contacts of this import (planned status new/existing/skip with their local id). */
  readonly importContacts: readonly {
    key: string;
    number?: string;
    name: string;
    status: string;
    localId?: string;
    debtorAccount?: string;
    creditorAccount?: string;
  }[];
  readonly contactsByNumber: Readonly<Record<string, { id: string; name: string }>>;
  readonly contactsByName: Readonly<Record<string, string[]>>;
  /** Current personal accounts of local contacts (by id). */
  readonly contactAccounts: Readonly<Record<string, { debtorAccount?: string; creditorAccount?: string }>>;
  /** Local contact owning an account already (account → contact id). */
  readonly accountOwners: Readonly<Record<string, string>>;
  readonly fileName: (id: string) => string;
}

/**
 * IMP-026: Stammdaten account → contact by customer number, else by exact (folded) name when unique. The account is
 * set only where the contact has none; a different existing account or an account another contact already owns is
 * a conflict that is reported and never overwritten (E-IMP-47). Unmatched rows are listed (E-IMP-49).
 */
export function planDatevAccounts(input: AccountMatchInput, findings: ImportFinding[]): PlannedAccount[] {
  const out: PlannedAccount[] = [];
  let unmatched = 0;
  const taken = new Map<string, string>(); // `${field}:${contact}` → account planned in this run
  const byNumber = new Map(
    input.importContacts.filter((c) => c.number).map((c) => [normalizeContactNumber(c.number as string), c]),
  );
  const byName = new Map<string, (typeof input.importContacts)[number][]>();
  for (const c of input.importContacts) byName.set(foldSearch(c.name), [...(byName.get(foldSearch(c.name)) ?? []), c]);
  for (const a of input.accounts) {
    const field = a.kind === "debtor" ? "debtorAccount" : "creditorAccount";
    const at = { fileId: a.fileId, fileName: input.fileName(a.fileId), line: a.line };
    const number = a.customerNumber ? normalizeContactNumber(a.customerNumber) : "";
    const fromImport =
      (number ? byNumber.get(number) : undefined) ??
      (() => {
        const hits = byName.get(foldSearch(a.name)) ?? [];
        return hits.length === 1 ? hits[0] : undefined;
      })();
    let ref: AccountContactRef | undefined;
    let current: string | undefined;
    let label = a.name;
    if (fromImport) {
      label = fromImport.number ?? fromImport.name;
      if (fromImport.status === "new") {
        ref = { kind: "import", key: fromImport.key };
        current = fromImport[field];
      } else if (fromImport.localId) {
        ref = { kind: "local", id: fromImport.localId };
        current = input.contactAccounts[fromImport.localId]?.[field];
      }
    } else {
      const local = number ? input.contactsByNumber[number] : undefined;
      const nameHits = input.contactsByName[foldSearch(a.name)] ?? [];
      const id = local?.id ?? (nameHits.length === 1 ? nameHits[0] : undefined);
      if (id) {
        ref = { kind: "local", id };
        label = local?.name ?? a.name;
        current = input.contactAccounts[id]?.[field];
      }
    }
    if (!ref) {
      unmatched++;
      continue;
    }
    const contactKey = ref.kind === "import" ? `i:${ref.key}` : `l:${ref.id}`;
    const owner = input.accountOwners[a.account];
    const ownerIsOther = owner !== undefined && !(ref.kind === "local" && ref.id === owner);
    const plannedBefore = taken.get(`${field}:${contactKey}`);
    const accountUsedInRun = [...taken.entries()].some(([k, v]) => v === a.account && k !== `${field}:${contactKey}`);
    const conflict = (message: string) => {
      findings.push({ code: "E-IMP-47", severity: "warning", message, ...at });
      out.push({
        account: a.account,
        field,
        contact: ref as AccountContactRef,
        contactLabel: label,
        status: "conflict",
      });
    };
    if (current === a.account || plannedBefore === a.account) {
      out.push({ account: a.account, field, contact: ref, contactLabel: label, status: "skip" });
      continue;
    }
    if (current) {
      conflict(
        `Kontakt ${label} hat bereits das Personenkonto ${current} – ${a.account} aus dem DATEV-Export wird nicht übernommen.`,
      );
      continue;
    }
    if (ownerIsOther || accountUsedInRun) {
      conflict(
        `Personenkonto ${a.account} ist bereits einem anderen Kontakt zugeordnet – für ${label} nicht übernommen.`,
      );
      continue;
    }
    if (plannedBefore && plannedBefore !== a.account) {
      conflict(
        `Für ${label} enthält der DATEV-Export mehrere Personenkonten (${plannedBefore}, ${a.account}) – nur ${plannedBefore} wird übernommen.`,
      );
      continue;
    }
    taken.set(`${field}:${contactKey}`, a.account);
    out.push({ account: a.account, field, contact: ref, contactLabel: label, status: "new" });
  }
  if (unmatched > 0) {
    findings.push({
      code: "E-IMP-49",
      severity: "info",
      message: `${unmatched} Personenkonten aus dem DATEV-Export passen zu keinem Kontakt und werden nicht übernommen.`,
    });
  }
  return out;
}
