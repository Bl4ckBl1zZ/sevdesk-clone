/**
 * F09 EXP-019 / GOBD-23 / E-EXP-30: migration adapters from internal records (any internal schema version) to the
 * `gdpdu-v1` columns. Each adapter takes the stored record shape structurally — fields that older internal schema
 * versions did not have are optional here and derived the same way — so unchanged data exports byte-identically
 * before and after an internal migration (TST-EXP-17).
 */
import { berlinCalendarDate } from "../time/berlin";
import type { GdpduRow } from "./schema-v1";

const iso = (ms: number | undefined | null) => (ms === undefined || ms === null ? null : new Date(ms).toISOString());
const yesNo = (b: boolean | undefined) => (b ? "ja" : "nein");
const rate = (bp: number | undefined | null) =>
  bp === undefined || bp === null ? null : (bp / 100).toFixed(2).replace(".", ",");

export interface AddressLike {
  street?: string | undefined;
  street2?: string | undefined;
  postalCode?: string | undefined;
  zip?: string | undefined;
  city?: string | undefined;
  countryCode?: string | undefined;
  country?: string | undefined;
  name?: string | undefined;
}

/** One-line address (v1 records used `zip`/`country`, later `postalCode`/`countryCode` — both map the same). */
export function addressLine(a: AddressLike | undefined | null): string | null {
  if (!a) return null;
  const zip = a.postalCode ?? a.zip;
  const country = a.countryCode ?? a.country;
  const parts = [a.street, a.street2, [zip, a.city].filter(Boolean).join(" "), country].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  return parts.length ? parts.join(", ") : null;
}

export interface JournalEntryLike {
  _id: string;
  seq: number;
  date: string;
  period: string;
  originalDate?: string | undefined;
  text: string;
  source: { kind: string; id: string };
  reversalOfId?: string | undefined;
  recordedAt: number;
  lockedAt?: number | undefined;
  actor: string;
  lines: readonly {
    account: string;
    debitCents: number;
    creditCents: number;
    taxKey?: string | undefined;
    taxPeriod?: string | undefined;
    costCenterId?: string | undefined;
    contactId?: string | undefined;
  }[];
}

export function buchungRow(e: JournalEntryLike, seqOf: (id: string) => number | undefined): GdpduRow {
  return {
    seq: e.seq,
    datum: e.date,
    belegdatum: e.originalDate ?? null,
    periode: e.period,
    text: e.text,
    quelle_art: e.source.kind,
    quelle_id: e.source.id,
    storno_von: e.reversalOfId ? (seqOf(e.reversalOfId) ?? null) : null,
    erfasst_am: iso(e.recordedAt),
    festgeschrieben_am: iso(e.lockedAt),
    akteur: e.actor,
  };
}

export function buchungszeilenRows(e: JournalEntryLike): GdpduRow[] {
  return e.lines.map((l, i) => ({
    seq: e.seq,
    zeile: i + 1,
    konto: l.account,
    soll: l.debitCents,
    haben: l.creditCents,
    steuerschluessel: l.taxKey ?? null,
    steuerperiode: l.taxPeriod ?? null,
    kostenstelle: l.costCenterId ?? null,
    kontakt_id: l.contactId ?? null,
  }));
}

/** Kassenbewegungen: lines on the cash account(s) in journal order with a running balance (CSH-020/030). */
export function kassenRows(
  entries: readonly JournalEntryLike[],
  cashAccounts: readonly string[],
  openingCents = 0,
): GdpduRow[] {
  let saldo = openingCents;
  const out: GdpduRow[] = [];
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    e.lines.forEach((l, i) => {
      if (!cashAccounts.includes(l.account)) return;
      const betrag = l.debitCents - l.creditCents;
      saldo += betrag;
      out.push({
        seq: e.seq,
        zeile: i + 1,
        datum: e.date,
        text: e.text,
        quelle_art: e.source.kind,
        quelle_id: e.source.id,
        betrag,
        saldo,
      });
    });
  }
  return out;
}

export interface ContactLike {
  _id: string;
  number: string;
  kind: string;
  displayName: string;
  vatId?: string | undefined;
  taxNumber?: string | undefined;
  debtorAccount?: string | undefined;
  creditorAccount?: string | undefined;
  dsgvo?: { restrictedAt?: number | undefined } | undefined;
}

export function kontaktRow(c: ContactLike, billing: AddressLike | null): GdpduRow {
  return {
    kontakt_id: c._id,
    kontaktnummer: c.number,
    art: c.kind === "organization" ? "Organisation" : "Person",
    name: c.displayName,
    anschrift: addressLine(billing),
    ust_idnr: c.vatId ?? null,
    steuernummer: c.taxNumber ?? null,
    debitorenkonto: c.debtorAccount ?? null,
    kreditorenkonto: c.creditorAccount ?? null,
    gesperrt: yesNo(c.dsgvo?.restrictedAt !== undefined),
  };
}

export type SupplyDateLike =
  | { kind: "date"; date: string }
  | { kind: "period"; from: string; to: string }
  | { kind: "month"; month: string };

export function supplyText(s: SupplyDateLike | undefined | null, documentDate: string | undefined): string | null {
  if (!s) return documentDate ?? null;
  if (s.kind === "date") return s.date;
  if (s.kind === "period") return `${s.from} bis ${s.to}`;
  return s.month;
}

export interface SalesDocumentLike {
  _id: string;
  type: string;
  status: string;
  number?: string | undefined;
  documentDate?: string | undefined;
  supplyDate?: SupplyDateLike | undefined;
  dueDate?: string | undefined;
  contactId?: string | undefined;
  contactName?: string | undefined;
  billingAddress?: AddressLike | undefined;
  taxCase: string;
  currency: string;
  totals: { netCents: number; vatCents: number; grossCents: number };
  /** Storno/correction → the original. */
  correctsId?: string | undefined;
  /** Storno of this document (byDocumentId) or withdrawal. */
  cancellation?: { byDocumentId?: string | undefined } | undefined;
}

export function rechnungRow(
  d: SalesDocumentLike,
  buyerName: string | null,
  fileSha256: string | null,
  numberOf: (id: string) => string | undefined,
): GdpduRow {
  return {
    beleg_id: d._id,
    art: d.type,
    nummer: d.number ?? null,
    belegdatum: d.documentDate ?? null,
    leistungsdatum: supplyText(d.supplyDate, d.documentDate),
    faellig_am: d.dueDate ?? null,
    kontakt_id: d.contactId ?? null,
    empfaenger: buyerName ?? d.billingAddress?.name ?? d.contactName ?? null,
    steuerfall: d.taxCase,
    waehrung: d.currency,
    netto: d.totals.netCents,
    umsatzsteuer: d.totals.vatCents,
    brutto: d.totals.grossCents,
    status: d.status,
    storniert_durch: d.cancellation?.byDocumentId
      ? (numberOf(d.cancellation.byDocumentId) ?? d.cancellation.byDocumentId)
      : null,
    korrigiert: d.correctsId ? (numberOf(d.correctsId) ?? d.correctsId) : null,
    datei_sha256: fileSha256,
  };
}

export interface DocumentLineLike {
  documentId: string;
  position: number;
  kind: string;
  name?: string | undefined;
  quantityMilli?: number | undefined;
  unitCode?: string | undefined;
  unitPriceMicros?: number | undefined;
  lineNetCents?: number | undefined;
  vatCategory?: string | undefined;
  vatRateBp?: number | undefined;
}

/** Fixed-point text without float arithmetic: 1234500 milli → "1234,5". */
export function fixed(value: number, scale: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const div = 10 ** scale;
  const frac = String(abs % div)
    .padStart(scale, "0")
    .replace(/0+$/, "");
  return `${sign}${Math.trunc(abs / div)}${frac ? `,${frac}` : ""}`;
}

export function positionRows(lines: readonly DocumentLineLike[]): GdpduRow[] {
  return lines
    .filter((l) => l.kind === "item")
    .sort((a, b) => a.position - b.position)
    .map((l) => ({
      beleg_id: l.documentId,
      pos: l.position,
      bezeichnung: l.name ?? null,
      menge: l.quantityMilli === undefined ? null : fixed(l.quantityMilli, 3),
      einheit: l.unitCode ?? null,
      einzelpreis: l.unitPriceMicros === undefined ? null : fixed(l.unitPriceMicros, 4),
      netto: l.lineNetCents ?? null,
      ust_kategorie: l.vatCategory ?? null,
      ust_satz: rate(l.vatRateBp),
    }));
}

export interface VoucherLike {
  _id: string;
  internalNumber?: string | undefined;
  documentNumber?: string | undefined;
  supplierName?: string | undefined;
  supplierContactId?: string | undefined;
  documentDate?: string | undefined;
  receivedAt: number;
  taxRule: string;
  currency: string;
  totals: { netCents: number; vatCents: number; grossCents: number };
  status: string;
  originalFiles: readonly { sha256: string; role: string }[];
}

export function eingangsbelegRow(v: VoucherLike): GdpduRow {
  const original = v.originalFiles.find((f) => f.role === "original") ?? v.originalFiles[0];
  return {
    voucher_id: v._id,
    interne_nummer: v.internalNumber ?? null,
    lieferanten_nummer: v.documentNumber ?? null,
    lieferant: v.supplierName ?? null,
    kontakt_id: v.supplierContactId ?? null,
    belegdatum: v.documentDate ?? null,
    eingang: iso(v.receivedAt),
    steuerregel: v.taxRule,
    waehrung: v.currency,
    netto: v.totals.netCents,
    vorsteuer: v.totals.vatCents,
    brutto: v.totals.grossCents,
    status: v.status,
    datei_sha256: original?.sha256 ?? null,
  };
}

export interface VoucherLineLike {
  voucherId: string;
  position: number;
  account: string;
  netCents: number;
  vatRateBp: number;
  vatCents: number;
  nonDeductibleShareBp?: number | undefined;
}

export function eingangsPositionRow(l: VoucherLineLike): GdpduRow {
  return {
    voucher_id: l.voucherId,
    pos: l.position,
    konto: l.account,
    netto: l.netCents,
    ust_satz: rate(l.vatRateBp),
    umsatzsteuer: l.vatCents,
    nicht_abziehbar: rate(l.nonDeductibleShareBp ?? 0),
  };
}

export interface PaymentLike {
  _id: string;
  target: { kind: string; id?: string | undefined };
  number?: string | undefined;
  date: string;
  amountCents: number;
  currency: string;
  source: { kind: string };
  differences: readonly { kind?: string | undefined; reason?: string | undefined; amountCents: number }[];
  reversedById?: string | undefined;
  reversalOfId?: string | undefined;
}

export function zahlungRow(p: PaymentLike): GdpduRow {
  return {
    zahlung_id: p._id,
    ziel_art: p.target.kind,
    ziel_id: p.target.id ?? null,
    belegnummer: p.number ?? null,
    datum: p.date,
    betrag: p.amountCents,
    waehrung: p.currency,
    quelle: p.source.kind,
    differenzen: p.differences.length
      ? p.differences.map((d) => `${d.kind ?? d.reason ?? "Differenz"} ${fixed(d.amountCents, 2)}`).join("; ")
      : null,
    storniert_durch: p.reversedById ?? null,
    storno_von: p.reversalOfId ?? null,
  };
}

export interface BankTransactionLike {
  _id: string;
  bookingDate: string;
  valueDate?: string | undefined;
  amountCents: number;
  currency: string;
  counterpartyName?: string | undefined;
  counterpartyIban?: string | undefined;
  purpose: string;
  status: string;
  source: { kind: string };
}

export function bankRow(t: BankTransactionLike, accountLabel: string): GdpduRow {
  return {
    umsatz_id: t._id,
    konto: accountLabel,
    buchungsdatum: t.bookingDate,
    wertstellung: t.valueDate ?? null,
    betrag: t.amountCents,
    waehrung: t.currency,
    gegenseite: t.counterpartyName ?? null,
    gegenseite_iban: t.counterpartyIban ?? null,
    verwendungszweck: t.purpose,
    status: t.status,
    quelle: t.source.kind,
  };
}

export interface NumberRegisterLike {
  number: string;
  docType: string;
  documentId?: string | undefined;
  periodKey?: string | undefined;
  counter?: number | undefined;
  assignedAt: number;
  status: string;
}

export function nummerRow(n: NumberRegisterLike): GdpduRow {
  return {
    nummer: n.number,
    belegart: n.docType,
    beleg_id: n.documentId ?? null,
    periode: n.periodKey ?? null,
    zaehler: n.counter ?? null,
    vergeben_am: iso(n.assignedAt),
    status: n.status,
  };
}

export interface FileLike {
  id: string;
  table: string;
  entityId: string;
  kind: string;
  fileName: string | null;
  sha256: string;
  bytes: number;
  mime: string;
  createdAt: number;
}

export function dokumentRow(f: FileLike): GdpduRow {
  return {
    datei_id: f.id,
    entitaet: f.table,
    entitaet_id: f.entityId,
    art: f.kind,
    dateiname: f.fileName,
    sha256: f.sha256,
    bytes: f.bytes,
    mime: f.mime,
    erstellt_am: iso(f.createdAt),
  };
}

export interface AuditEntryLike {
  seq: number;
  at: number;
  actor: string;
  actorRole?: string | undefined;
  channel: string;
  action: string;
  entity: { table: string; id: string; label?: string | undefined };
  reason?: string | undefined;
  diff?: unknown;
  hash: string;
  prevHash: string;
}

function berlinTime(ms: number): string {
  const time = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(ms);
  const [y, m, d] = berlinCalendarDate(ms).split("-");
  return `${d}.${m}.${y} ${time}`;
}

export function protokollRow(e: AuditEntryLike): GdpduRow {
  return {
    seq: e.seq,
    zeit_utc: iso(e.at),
    zeit_berlin: berlinTime(e.at),
    akteur: e.actor,
    rolle: e.actorRole ?? null,
    kanal: e.channel,
    aktion: e.action,
    tabelle: e.entity.table,
    entitaet_id: e.entity.id,
    bezeichnung: e.entity.label ?? null,
    grund: e.reason ?? null,
    aenderung: e.diff === undefined ? null : JSON.stringify(e.diff),
    hash: e.hash,
    vorheriger_hash: e.prevHash,
  };
}

/** The stored company profile JSON (companyProfileVersions.profile) — only the fields the export reads. */
export interface ProfileLike {
  name?: string;
  legalForm?: string;
  address?: AddressLike;
  taxNumber?: string;
  vatId?: string;
  fiscalYearStartMonth?: number;
  kleinunternehmer?: readonly { validFrom: string; isKU: boolean }[];
  taxationMethod?: readonly { validFrom: string; method: string }[];
  profitMethod?: readonly { validFromFiscalYear: number; method: string }[];
  chartOfAccounts?: readonly { validFromFiscalYear: number; chart: string }[];
}

const atDate = <T extends { validFrom: string }>(rows: readonly T[] | undefined, day: string): T | undefined =>
  [...(rows ?? [])].filter((r) => r.validFrom <= day).sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))[0];
const atYear = <T extends { validFromFiscalYear: number }>(
  rows: readonly T[] | undefined,
  year: number,
): T | undefined =>
  [...(rows ?? [])]
    .filter((r) => r.validFromFiscalYear <= year)
    .sort((a, b) => b.validFromFiscalYear - a.validFromFiscalYear)[0];

export function firmaRow(
  v: { version: number; validFrom: string; supersededOn: string | null; profile: ProfileLike },
  year: number,
  yearStart: string,
): GdpduRow {
  const p = v.profile;
  const ku = atDate(p.kleinunternehmer, yearStart);
  return {
    version: v.version,
    gueltig_ab: v.validFrom,
    gueltig_bis: v.supersededOn,
    name: p.name ?? null,
    rechtsform: p.legalForm ?? null,
    anschrift: addressLine(p.address),
    steuernummer: p.taxNumber ?? null,
    ust_idnr: p.vatId ?? null,
    kontenrahmen: atYear(p.chartOfAccounts, year)?.chart ?? null,
    gewinnermittlung:
      atYear(p.profitMethod, year)?.method === "bilanz" ? "Bilanz" : atYear(p.profitMethod, year) ? "EÜR" : null,
    versteuerung: (() => {
      const m = atDate(p.taxationMethod, yearStart)?.method;
      return m === "ist" ? "Ist" : m === "soll" ? "Soll" : null;
    })(),
    kleinunternehmer: ku ? yesNo(ku.isKU) : null,
    wirtschaftsjahr_beginn: p.fiscalYearStartMonth ?? null,
  };
}

export interface AccountLike {
  number: string;
  name: string;
  type: string;
  euerKey?: string | undefined;
  automaticVatAccount?: true | undefined;
}

export function kontoRow(a: AccountLike): GdpduRow {
  return {
    kontonummer: a.number,
    bezeichnung: a.name,
    kontoart: a.type,
    euer_zeile: a.euerKey ?? null,
    automatikkonto: yesNo(a.automaticVatAccount === true),
  };
}
