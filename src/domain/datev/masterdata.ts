/**
 * F09 EXP-013 / §4.1.5 / DATEV-02: Debitoren/Kreditoren master data (Formatkategorie 16, version 5) — one row per
 * contact with a personal account; the key columns are filled, every other column of the version stays empty.
 * Personal-account assignment for contacts without a number (EXP-006, E-EXP-13).
 */
import { type ExtfRow, raw, txt } from "./extf";

export interface DatevContactInput {
  account: string;
  kind: "organization" | "person";
  number: string;
  displayName: string;
  organizationName?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
  salutation?: "herr" | "frau" | "divers" | "none" | undefined;
  academicTitle?: string | undefined;
  vatId?: string | undefined;
  taxNumber?: string | undefined;
  address?: { street?: string; postalCode?: string; city?: string; countryCode?: string; poBox?: string } | undefined;
  phone?: string | undefined;
  email?: string | undefined;
  web?: string | undefined;
  iban?: string | undefined;
  bic?: string | undefined;
  language?: "de" | "en" | undefined;
}

const ANREDE: Readonly<Record<string, string>> = { herr: "Herr", frau: "Frau" };

export function masterDataRow(c: DatevContactInput): ExtfRow {
  const person = c.kind === "person";
  const vat = c.vatId?.replace(/\s/g, "");
  return {
    Konto: raw(c.account),
    "Name (Adressatentyp Unternehmen)": txt(person ? undefined : (c.organizationName ?? c.displayName).slice(0, 50)),
    "Name (Adressatentyp natürl. Person)": txt(person ? (c.lastName ?? c.displayName).slice(0, 30) : undefined),
    "Vorname (Adressatentyp natürl. Person)": txt(person ? c.firstName?.slice(0, 30) : undefined),
    Adressatentyp: raw(person ? 1 : 2),
    Kurzbezeichnung: txt(c.displayName.slice(0, 15)),
    "EU-Mitgliedstaat": txt(vat && /^[A-Z]{2}/.test(vat) ? vat.slice(0, 2) : undefined),
    "EU-USt-IdNr.": txt(vat && /^[A-Z]{2}/.test(vat) ? vat.slice(2) : undefined),
    Anrede: txt(person && c.salutation ? ANREDE[c.salutation] : undefined),
    "Titel/Akad.Grad": txt(c.academicTitle?.slice(0, 25)),
    Adressart: txt(c.address ? "STR" : undefined),
    Straße: txt(c.address?.street?.slice(0, 36)),
    Postfach: txt(c.address?.poBox?.slice(0, 10)),
    Postleitzahl: txt(c.address?.postalCode?.slice(0, 10)),
    Ort: txt(c.address?.city?.slice(0, 30)),
    Land: txt(c.address?.countryCode),
    Telefon: txt(c.phone?.slice(0, 60)),
    "E-Mail": txt(c.email?.slice(0, 60)),
    Internet: txt(c.web?.slice(0, 60)),
    "IBAN-Nr. 1": txt(c.iban?.replace(/\s/g, "")),
    "SWIFT-Code 1": txt(c.bic),
    Kundennummer: txt(c.number.slice(0, 15)),
    Steuernummer: txt(c.taxNumber),
    // LEGAL-OPEN (§4.1.5): only „1 = Deutsch" is shipped; other languages stay empty.
    Sprache: raw(c.language === "de" ? 1 : undefined),
  };
}

/**
 * E-EXP-13: next free personal account numbers (debtors 10^L … 7·10^L − 1, creditors 7·10^L … 10^(L+1) − 1),
 * ascending after the highest used number of the range.
 */
export function assignPersonalAccounts(
  count: number,
  kind: "debtor" | "creditor",
  used: readonly string[],
  accountLength: number,
): string[] {
  const from = kind === "debtor" ? 10 ** accountLength : 7 * 10 ** accountLength;
  const to = kind === "debtor" ? 7 * 10 ** accountLength - 1 : 10 ** (accountLength + 1) - 1;
  const taken = new Set(used.map(Number).filter((n) => n >= from && n <= to));
  const out: string[] = [];
  let n = Math.max(from, ...[...taken].map((x) => x + 1));
  while (out.length < count) {
    if (n > to) throw new Error(`no free ${kind} account in ${from}…${to}`);
    if (!taken.has(n)) out.push(String(n));
    n++;
  }
  return out;
}

export interface PreviousExport {
  id: string;
  fileName: string;
  createdAt: number;
  festschreibung: 0 | 1;
  from: string;
  to: string;
  lineIds: readonly string[];
  sha256ByFile: Readonly<Record<string, string>>;
}

export type ReexportMode = "new" | "full";

export const REEXPORT_MESSAGES = {
  nothingNew: (date: string) => `Seit dem letzten Export (${date}) gibt es keine neuen Buchungen in diesem Zeitraum.`,
  lockedRepeat: (date: string) =>
    `Dieser Zeitraum wurde am ${date} festgeschrieben an DATEV übergeben. Die Datei ist identisch mit dem damaligen Export und darf nicht erneut importiert werden.`,
  lockedChanged:
    "Der festgeschriebene Zeitraum hat sich seit dem Export verändert – Integritätsfehler, Export abgebrochen.",
  confirmDelete: (file: string) =>
    `Der Steuerberater muss den vorherigen Stapel ${file} vor dem Import löschen. Fortfahren?`,
  forcedZero: (months: string) => `Nicht festgeschriebene Monate (${months}) werden ohne Festschreibung exportiert.`,
  lateIncluded: (n: number) => `${n} nachträgliche Buchungen zu bereits exportierten Zeiträumen enthalten.`,
} as const;

/** EXP-010 / EC-174: which lines go into a (re-)export and what the user must be told or confirm. */
export function planReexport(input: {
  mode: ReexportMode;
  lineIds: readonly string[];
  /** Exports whose range overlaps the requested one. */
  previous: readonly PreviousExport[];
  formatDate: (ms: number) => string;
}): {
  lineIds: string[];
  repeat: boolean;
  doNotReimport: boolean;
  needsConfirmation: string | null;
  info: string | null;
  /** Full re-export of a festgeschrieben range: the content must equal this export's (else integrity error). */
  mustEqual: PreviousExport | null;
} {
  const exported = new Set(input.previous.flatMap((p) => p.lineIds));
  const last = [...input.previous].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (input.mode === "new") {
    const fresh = input.lineIds.filter((id) => !exported.has(id));
    return {
      lineIds: fresh,
      repeat: input.previous.length > 0,
      doNotReimport: false,
      needsConfirmation: null,
      info: fresh.length === 0 && last ? REEXPORT_MESSAGES.nothingNew(input.formatDate(last.createdAt)) : null,
      mustEqual: null,
    };
  }
  const locked = input.previous.find((p) => p.festschreibung === 1);
  if (locked) {
    return {
      lineIds: [...input.lineIds],
      repeat: true,
      doNotReimport: true,
      needsConfirmation: null,
      info: REEXPORT_MESSAGES.lockedRepeat(input.formatDate(locked.createdAt)),
      mustEqual: locked,
    };
  }
  return {
    lineIds: [...input.lineIds],
    repeat: input.previous.length > 0,
    doNotReimport: false,
    needsConfirmation: last ? REEXPORT_MESSAGES.confirmDelete(last.fileName) : null,
    info: null,
    mustEqual: null,
  };
}
