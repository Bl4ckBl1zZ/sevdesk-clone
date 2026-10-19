/**
 * F09 EXP-005…007 / §4.1.4 / DATEV-01/02: journal entries → DATEV Buchungsstapel rows. Pure.
 *
 * Per entry:
 * 1. Lines with a VAT tax key (USt19/USt7/VSt19/VSt7, rate + BU from the versioned table src/domain/rules/datev-bu.ts)
 *    absorb their VAT lines (roles `vat.output.*` / `vat.input.*` of the same rate and side): DATEV books the gross
 *    and recomputes the VAT. Automatic accounts get no BU key, other accounts the table's key (E-EXP-14 by
 *    construction). VAT is allocated across several accounts of the same rate by largest remainder and cents are
 *    shifted until DATEV's per-row recomputation equals our VAT; a residual difference becomes a correction row on
 *    the VAT account with BU 40 (E-EXP-17, warning).
 * 2. VAT lines left over that cancel each other (Ist-Versteuerung „nicht fällig → fällig“ reclassifications, the
 *    self-assessed §13b/igE pairs on automatic accounts) are not exported: DATEV derives them from the client set-up
 *    and the automatic accounts. LEGAL-OPEN (F09 open item 5): to be confirmed with the first Steuerberater import.
 *    Non-cancelling leftovers are exported as direct postings on the VAT account (warning).
 * 3. Every item is posted against one anchor item of the entry (the largest receivable/payable/money line): Konto =
 *    anchor (personal account where applicable), Gegenkonto = item, so a tax-bearing account is always the
 *    Gegenkonto and no tax group is ever split. Reversals keep the original's Soll/Haben with Generalumkehr = 1.
 */
import type { Issue } from "../result";
import { DATEV_BU_CORRECTION, datevBuRow } from "../rules/datev-bu";
import { type ExtfRow, extfAmount, raw, ttmm, ttmmjj, ttmmjjjj, txt } from "./extf";

export interface DatevJournalLine {
  account: string;
  role?: string | undefined;
  debitCents: number;
  creditCents: number;
  taxKey?: string | undefined;
  costCenterId?: string | undefined;
  contactId?: string | undefined;
  taxPeriod?: string | undefined;
  currency?: string | undefined;
  amountFx?: number | undefined;
  fxRate?: { rate: string } | undefined;
}

export interface DatevJournalEntry {
  id: string;
  seq: number;
  date: string;
  originalDate?: string | undefined;
  text: string;
  source: { kind: string; id: string };
  reversalOfId?: string | undefined;
  lines: readonly DatevJournalLine[];
}

export interface DatevBeleg {
  belegfeld1?: string;
  /** Sales: due date (Belegfeld 2 `TTMMJJ`, OPOS). */
  dueDate?: string;
  /** Supply date (Leistungsdatum). */
  supplyDate?: string;
  /** EU VAT ID of the partner (igL, §13b, EU services). */
  euVatId?: string;
  /** GUID of the document file in document.xml (Beleglink `BEDI "<GUID>"`). */
  guid?: string;
  /** Internal document id (Beleginfo „Beleg-ID“). */
  internalId?: string;
  /** Vouchers: the supplier's invoice number (Zusatzinformation „Lieferanten-Rechnungsnr.“, EXP-005 decided default ⚠). */
  supplierNumber?: string;
}

export interface DatevMapContext {
  accountLength: number;
  festschreibung: 0 | 1;
  from: string;
  to: string;
  isAutomatic: (account: string) => boolean;
  accountExists: (account: string) => boolean;
  /** Personal account for a receivable/payable line (null → the collective account stays, EXP-006 „Sammelkonten“). */
  personalAccount: (contactId: string, kind: "debtor" | "creditor") => string | null;
  beleg: (entry: DatevJournalEntry) => DatevBeleg;
  costCenterCode?: (id: string) => string | undefined;
}

export interface DatevIssue extends Issue {
  level: "error" | "warning" | "info";
}

export interface DatevMapResult {
  rows: ExtfRow[];
  /** `<entryId>:<lineIndex>` of every journal line represented (EXP-009). */
  lineIds: string[];
  issues: DatevIssue[];
  /** Σ Umsatz of the rows (history). */
  umsatzCents: number;
}

export const DATEV_MESSAGES = {
  negative: (seq: number) => `Ungültige Buchung ${seq}: negativer Betrag.`,
  unbalanced: (seq: number) => `Buchung ${seq} ist nicht ausgeglichen.`,
  belegfeld: (nr: string) =>
    `Belegnummer ${nr} enthält Zeichen, die DATEV nicht akzeptiert. Bitte DATEV-Belegnummer festlegen.`,
  textCut: (beleg: string) => `Buchungstext für ${beleg} auf 60 Zeichen gekürzt.`,
  length: (nr: string, n: number) => `Konto ${nr} passt nicht zur Sachkontenlänge ${n}.`,
  unknownAccount: (nr: string) => `Konto ${nr} ist im Kontenrahmen nicht vorhanden.`,
  amount: (seq: number) => `Betrag in Buchung ${seq} ist für DATEV zu groß (höchstens 9.999.999.999,99).`,
  outOfRange: (seq: number) => `Buchung ${seq} liegt außerhalb des Exportzeitraums.`,
  correction: (beleg: string) => `Rundungsausgleich für ${beleg} als separate Steuerzeile exportiert.`,
  directVat: (seq: number, account: string) =>
    `Buchung ${seq}: direkte Buchung auf Steuerkonto ${account} (keine Bemessungsgrundlage in derselben Buchung).`,
  vatDerived: (seq: number) =>
    `Buchung ${seq}: Umbuchung der Umsatzsteuer (Ist-Versteuerung bzw. § 13b/innergemeinschaftlicher Erwerb) übernimmt DATEV über die Automatikkonten.`,
  personalRange: (nr: string) => `Personenkonto ${nr} liegt außerhalb des Debitoren-/Kreditorenbereichs.`,
  keysMissing: "Für den DATEV-Export fehlen Berater- und/oder Mandantennummer (Einstellungen › Unternehmen › DATEV).",
  twoYears: "Der Zeitraum umfasst zwei Wirtschaftsjahre – es werden zwei Dateien erzeugt.",
  transliterated: (n: number, a: string, b: string) =>
    `${n} Zeichen wurden für DATEV umgeschrieben (z. B. „${a}“ → „${b}“).`,
  missingFiles: (n: number) => `Für ${n} Buchungen fehlt die Belegdatei.`,
  accountsAssigned: (n: number) => `${n} Kontakten wurden Debitoren-/Kreditorennummern zugewiesen.`,
  accountsToAssign: (n: number) => `${n} Kontakten werden beim Export Debitoren-/Kreditorennummern zugewiesen.`,
  running: "Für diesen Zeitraum läuft bereits ein Export.",
  notAccepted:
    "DATEV-Import noch nicht von einem Steuerberater bestätigt. Die Datei ist als Testexport gekennzeichnet.",
  rangeInvalid: "Bitte einen gültigen Zeitraum wählen (Beginn vor Ende, höchstens zwei Wirtschaftsjahre).",
  nothingSelected: "Bitte mindestens einen Umfang auswählen.",
  diff: (added: number, removed: number) =>
    `Gegenüber dem letzten Export: ${added} neue und ${removed} entfallene Buchungszeilen.`,
} as const;

const BELEGFELD_RE = /^[A-Za-z0-9$%&*+\-/]{0,36}$/;
const MAX_CENTS = 999_999_999_999;

/** EN 16931 / DIN 1333 half-up on non-negative integers: round(a / b). */
const divHalfUp = (a: number, b: number) => Math.floor((2 * a + b) / (2 * b));
/** DATEV recomputes the VAT contained in a gross amount: gross · r / (1 + r), half-up. */
export const datevVatOfGross = (grossCents: number, rateBp: number) => divHalfUp(grossCents * rateBp, 10_000 + rateBp);

type Side = "S" | "H";
const flip = (s: Side): Side => (s === "S" ? "H" : "S");

interface Item {
  account: string;
  side: Side;
  cents: number;
  bu?: string;
  rateBp?: number;
  taxKey?: string;
  line: DatevJournalLine;
  lineIdx: number[];
  plain: boolean;
  personal: boolean;
}

const isVatRole = (role: string | undefined) =>
  !!role && (role.startsWith("vat.output.") || role.startsWith("vat.input."));
const rateOfRole = (role: string) =>
  /\.(19|7)$/.exec(role)?.[1] === "19" ? 1900 : /\.(19|7)$/.exec(role) ? 700 : null;
const familyOfKey = (taxKey: string) =>
  taxKey.startsWith("USt") ? "vat.output." : taxKey.startsWith("VSt") ? "vat.input." : null;
const derivedRole = (role: string) => role.includes(".notdue.") || role.includes(".13b.") || role.includes(".ige.");

function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map((x) => Math.floor(x));
  let rest = total - out.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    out[i] = (out[i] as number) + 1;
    rest--;
  }
  return out;
}

/** Formats a GL account to the Sachkontenlänge (LEGAL-OPEN: right-padded with zeros when L > 4) or reports. */
function glAccount(nr: string, length: number, issues: DatevIssue[]): string {
  if (nr.length === length) return nr;
  if (nr.length < length && nr.length === 4) return nr.padEnd(length, "0");
  issues.push({ level: "error", code: "DATEV_ACCOUNT_LENGTH", message: DATEV_MESSAGES.length(nr, length) });
  return nr;
}

export function mapEntries(entries: readonly DatevJournalEntry[], ctx: DatevMapContext): DatevMapResult {
  const rows: ExtfRow[] = [];
  const lineIds: string[] = [];
  const issues: DatevIssue[] = [];
  let umsatz = 0;
  const once = new Set<string>();
  const issue = (i: DatevIssue) => {
    const k = `${i.code}|${i.message}`;
    if (!once.has(k)) {
      once.add(k);
      issues.push(i);
    }
  };
  const range = {
    debtor: { from: 10 ** ctx.accountLength, to: 7 * 10 ** ctx.accountLength - 1 },
    creditor: { from: 7 * 10 ** ctx.accountLength, to: 10 ** (ctx.accountLength + 1) - 1 },
  };

  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const beleg = ctx.beleg(e);
    if (e.date < ctx.from || e.date > ctx.to)
      issue({ level: "error", code: "DATEV_RANGE", message: DATEV_MESSAGES.outOfRange(e.seq) });
    if (e.lines.some((l) => l.debitCents < 0 || l.creditCents < 0)) {
      issue({ level: "error", code: "DATEV_NEGATIVE", message: DATEV_MESSAGES.negative(e.seq) });
      continue;
    }
    const d = e.lines.reduce((s, l) => s + l.debitCents, 0);
    const c = e.lines.reduce((s, l) => s + l.creditCents, 0);
    if (d !== c) {
      issue({ level: "error", code: "DATEV_UNBALANCED", message: DATEV_MESSAGES.unbalanced(e.seq) });
      continue;
    }
    if (beleg.belegfeld1 && !BELEGFELD_RE.test(beleg.belegfeld1)) {
      issue({ level: "error", code: "DATEV_BELEGFELD", message: DATEV_MESSAGES.belegfeld(beleg.belegfeld1) });
    }
    const bu = datevBuRow(e.date);
    const vatLeft = e.lines.map((l, i) => ({ l, i, left: isVatRole(l.role) ? l.debitCents + l.creditCents : 0 }));
    const items: Item[] = [];
    const corrections: { item: Item; vatAccount: string; diff: number }[] = [];

    // 1. base lines with a VAT tax key, grouped per (taxKey, side) for the allocation
    const groups = new Map<string, Item[]>();
    e.lines.forEach((l, i) => {
      if (isVatRole(l.role)) return;
      const side: Side = l.debitCents > 0 ? "S" : "H";
      const cents = l.debitCents + l.creditCents;
      if (cents === 0) return;
      const rateBp = l.taxKey ? bu?.rates[l.taxKey] : undefined;
      const item: Item = {
        account: l.account,
        side,
        cents,
        line: l,
        lineIdx: [i],
        plain: !rateBp,
        personal: l.role === "receivable" || l.role === "payable",
        ...(l.taxKey ? { taxKey: l.taxKey } : {}),
        ...(rateBp ? { rateBp } : {}),
      };
      if (rateBp && l.taxKey) {
        const k = `${l.taxKey}|${side}`;
        groups.set(k, [...(groups.get(k) ?? []), item]);
      }
      items.push(item);
    });

    for (const [k, group] of groups) {
      const [taxKey, side] = k.split("|") as [string, Side];
      const rate = group[0]?.rateBp as number;
      const family = familyOfKey(taxKey);
      const candidates = vatLeft.filter(
        (v) =>
          v.left > 0 &&
          family &&
          v.l.role?.startsWith(family) &&
          !v.l.role.includes(".13b.") &&
          !v.l.role.includes(".ige.") &&
          rateOfRole(v.l.role) === rate &&
          (v.l.debitCents > 0 ? "S" : "H") === side,
      );
      const available = candidates.reduce((s, v) => s + v.left, 0);
      const expected = divHalfUp(group.reduce((s, g) => s + g.cents, 0) * rate, 10_000);
      const take = Math.min(available, expected);
      const shares = allocate(
        take,
        group.map((g) => g.cents),
      );
      // consume the VAT lines
      let rest = take;
      for (const v of candidates) {
        if (rest === 0) break;
        const used = Math.min(v.left, rest);
        v.left -= used;
        rest -= used;
        for (const g of group) if (!g.lineIdx.includes(v.i)) g.lineIdx.push(v.i);
      }
      // §4.1.4: shift cents between the accounts until DATEV's recomputation matches
      const vatOf = (i: number) => datevVatOfGross((group[i] as Item).cents + (shares[i] as number), rate);
      for (let guard = 0; guard < 50; guard++) {
        const off = group.map((_, i) => (shares[i] as number) - vatOf(i));
        const plus = off.findIndex((o) => o > 0);
        const minus = off.findIndex((o) => o < 0);
        if (plus === -1 || minus === -1) break;
        shares[plus] = (shares[plus] as number) - 1;
        shares[minus] = (shares[minus] as number) + 1;
      }
      group.forEach((g, i) => {
        const share = shares[i] as number;
        g.cents += share;
        const isAuto = ctx.isAutomatic(g.account);
        if (!isAuto) {
          const key = bu?.keys[taxKey];
          if (key) g.bu = key;
        }
        const recomputed = datevVatOfGross(g.cents, rate);
        if (recomputed !== share) {
          const vatAccount = candidates[0]?.l.account;
          if (vatAccount) corrections.push({ item: g, vatAccount, diff: share - recomputed });
        }
      });
    }

    // 2. leftover VAT lines: cancelling ones are derived by DATEV, others are direct postings
    const leftover = vatLeft.filter((v) => v.left > 0);
    const signed = leftover.reduce((s, v) => s + (v.l.debitCents > 0 ? v.left : -v.left), 0);
    if (leftover.length > 0 && signed === 0) {
      if (leftover.some((v) => derivedRole(v.l.role as string) || ctx.isAutomatic(v.l.account))) {
        issue({ level: "info", code: "DATEV_VAT_DERIVED", message: DATEV_MESSAGES.vatDerived(e.seq) });
      }
      for (const v of leftover) items[0]?.lineIdx.push(v.i);
    } else {
      // The self-assessed pair does not cancel (e.g. § 13b for a Kleinunternehmer: no input VAT): the automatic
      // account must not derive the pair — BU 40 — and the booked VAT lines are exported as they are.
      for (const it of items) {
        if (it.taxKey && !it.rateBp && ctx.isAutomatic(it.account)) it.bu = DATEV_BU_CORRECTION;
      }
      for (const v of leftover) {
        issue({ level: "warning", code: "DATEV_DIRECT_VAT", message: DATEV_MESSAGES.directVat(e.seq, v.l.account) });
        items.push({
          account: v.l.account,
          side: v.l.debitCents > 0 ? "S" : "H",
          cents: v.left,
          line: v.l,
          lineIdx: [v.i],
          plain: true,
          personal: false,
        });
      }
    }
    // personal accounts (EXP-006)
    for (const it of items) {
      if (!it.personal || !it.line.contactId) continue;
      const kind = it.line.role === "receivable" ? "debtor" : "creditor";
      const nr = ctx.personalAccount(it.line.contactId, kind);
      if (nr) {
        const n = Number(nr);
        if (!(n >= range[kind].from && n <= range[kind].to)) {
          issue({ level: "error", code: "DATEV_PERSONAL_RANGE", message: DATEV_MESSAGES.personalRange(nr) });
        }
        it.account = nr;
      }
    }

    // plain lines on the same (final) account are netted — DATEV rows never post an account against itself
    const merged = new Map<string, Item>();
    for (const it of items.filter((x) => x.plain && !x.rateBp)) {
      const key = `${it.account}|${it.taxKey ?? ""}`;
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, it);
        continue;
      }
      const net = (prev.side === "S" ? prev.cents : -prev.cents) + (it.side === "S" ? it.cents : -it.cents);
      prev.side = net >= 0 ? "S" : "H";
      prev.cents = Math.abs(net);
      prev.lineIdx.push(...it.lineIdx);
      items.splice(items.indexOf(it), 1);
    }
    for (let i = items.length - 1; i >= 0; i--)
      if ((items[i] as Item).cents === 0 && items.length > 1) items.splice(i, 1);
    if (items.length === 0) continue;

    // 3. anchor: the largest personal/money line, else the largest item
    const plainItems = items.filter((i) => i.plain && i.bu === undefined && !i.rateBp);
    const anchor = [...(plainItems.length ? plainItems : items)].sort(
      (a, b) => Number(b.personal) - Number(a.personal) || b.cents - a.cents,
    )[0] as Item;
    const reversal = e.reversalOfId !== undefined;
    const text = e.text.length > 60 ? e.text.slice(0, 60) : e.text;
    if (e.text.length > 60) {
      issue({
        level: "warning",
        code: "DATEV_TEXT",
        message: DATEV_MESSAGES.textCut(beleg.belegfeld1 ?? `Buchung ${e.seq}`),
      });
    }
    const accountOf = (it: Item) =>
      it.personal && it.account !== it.line.account ? it.account : glAccount(it.account, ctx.accountLength, issues);
    for (const it of [anchor, ...items]) {
      if (it.personal && it.account !== it.line.account) continue;
      if (!ctx.accountExists(it.account)) {
        issue({ level: "error", code: "DATEV_ACCOUNT", message: DATEV_MESSAGES.unknownAccount(it.account) });
      }
    }

    const push = (
      it: Item,
      cents: number,
      sideOfKonto: Side,
      buKey: string | undefined,
      rateBp: number | undefined,
    ) => {
      if (cents === 0) return;
      if (cents > MAX_CENTS) issue({ level: "error", code: "DATEV_AMOUNT", message: DATEV_MESSAGES.amount(e.seq) });
      const sh = reversal ? flip(sideOfKonto) : sideOfKonto;
      const fx = it.line.currency && it.line.currency !== "EUR" && it.line.amountFx !== undefined ? it.line : null;
      const euCase = it.taxKey && /^(igL|EU-RC|13b|igE)/.test(it.taxKey);
      const supply = beleg.supplyDate ?? e.originalDate;
      const taxPeriod = it.line.taxPeriod;
      umsatz += cents;
      rows.push({
        "Umsatz (ohne Soll/Haben-Kz)": raw(extfAmount(cents)),
        "Soll/Haben-Kennzeichen": txt(sh),
        "WKZ Umsatz": txt("EUR"),
        ...(fx
          ? {
              Kurs: raw(fx.fxRate?.rate.replace(".", ",")),
              "Basis-Umsatz": raw(extfAmount(Math.abs(fx.amountFx as number))),
              "WKZ Basis-Umsatz": txt(fx.currency),
            }
          : {}),
        Konto: raw(accountOf(anchor)),
        "Gegenkonto (ohne BU-Schlüssel)": raw(accountOf(it)),
        "BU-Schlüssel": txt(buKey),
        Belegdatum: raw(ttmm(e.date)),
        "Belegfeld 1": txt(beleg.belegfeld1),
        "Belegfeld 2": txt(beleg.dueDate ? ttmmjj(beleg.dueDate) : undefined),
        Buchungstext: txt(text),
        Beleglink: txt(beleg.guid ? `BEDI "${beleg.guid}"` : undefined),
        "Beleginfo - Art 1": txt(beleg.internalId ? "Beleg-ID" : undefined),
        "Beleginfo - Inhalt 1": txt(beleg.internalId),
        "Zusatzinformation - Art 1": txt(beleg.supplierNumber ? "Lieferanten-Rechnungsnr." : undefined),
        "Zusatzinformation - Inhalt 1": txt(beleg.supplierNumber?.slice(0, 210)),
        "KOST1 - Kostenstelle": txt(
          it.line.costCenterId ? (ctx.costCenterCode?.(it.line.costCenterId) ?? it.line.costCenterId) : undefined,
        ),
        "EU-Land u. UStID": txt(euCase ? beleg.euVatId : undefined),
        Festschreibung: raw(ctx.festschreibung),
        Leistungsdatum: raw(supply ? ttmmjjjj(supply) : undefined),
        "Datum Zuord. Steuerperiode": raw(
          taxPeriod && taxPeriod !== e.date.slice(0, 7) ? ttmmjjjj(`${taxPeriod}-01`) : undefined,
        ),
        Generalumkehr: raw(reversal ? "1" : undefined),
        Steuersatz: raw(rateBp ? extfAmount(rateBp) : undefined),
      });
    };

    for (const it of items) {
      if (it === anchor) continue;
      // An amount without VAT on an automatic account (e.g. Skonto of a Kleinunternehmer, a customs line on 3400)
      // gets BU 40 „Aufhebung der Automatik“ so DATEV does not extract VAT that was never booked.
      const lift = !it.bu && !it.rateBp && !it.taxKey && ctx.isAutomatic(it.account) ? DATEV_BU_CORRECTION : undefined;
      push(it, it.cents, flip(it.side), it.bu ?? lift, it.bu || ctx.isAutomatic(it.account) ? it.rateBp : undefined);
    }
    for (const corr of corrections) {
      // VAT account gets +diff on the base side, the base account −diff (BU 40 lifts the automatic)
      const vatItem: Item = { ...corr.item, account: corr.vatAccount, plain: true, personal: false };
      const side = corr.diff > 0 ? corr.item.side : flip(corr.item.side);
      const baseItem: Item = { ...corr.item, plain: true };
      // posted as: Konto = base account, Gegenkonto = VAT account
      rows.push({
        "Umsatz (ohne Soll/Haben-Kz)": raw(extfAmount(Math.abs(corr.diff))),
        "Soll/Haben-Kennzeichen": txt(reversal ? side : flip(side)),
        "WKZ Umsatz": txt("EUR"),
        Konto: raw(glAccount(baseItem.account, ctx.accountLength, issues)),
        "Gegenkonto (ohne BU-Schlüssel)": raw(glAccount(vatItem.account, ctx.accountLength, issues)),
        "BU-Schlüssel": txt(DATEV_BU_CORRECTION),
        Belegdatum: raw(ttmm(e.date)),
        "Belegfeld 1": txt(beleg.belegfeld1),
        Buchungstext: txt(`Rundungsausgleich USt ${text}`.slice(0, 60)),
        Festschreibung: raw(ctx.festschreibung),
        Generalumkehr: raw(reversal ? "1" : undefined),
      });
      umsatz += Math.abs(corr.diff);
      issue({
        level: "warning",
        code: "DATEV_CORRECTION",
        message: DATEV_MESSAGES.correction(beleg.belegfeld1 ?? `Buchung ${e.seq}`),
      });
    }
    for (let i = 0; i < e.lines.length; i++) lineIds.push(`${e.id}:${i}`);
  }
  return { rows, lineIds, issues, umsatzCents: umsatz };
}

/**
 * The VAT DATEV will derive from the rows (Σ over rows with a rate) — for the §4.1.4 property test: it must equal the
 * booked VAT of the absorbed VAT lines plus the correction rows.
 */
export function datevDerivedVat(rows: readonly ExtfRow[]): number {
  let total = 0;
  for (const r of rows) {
    const rate = r.Steuersatz && "r" in r.Steuersatz ? parseExtfAmount(r.Steuersatz.r) : 0;
    const amount = r["Umsatz (ohne Soll/Haben-Kz)"];
    if (!rate || !amount || !("r" in amount)) continue;
    total += datevVatOfGross(parseExtfAmount(amount.r), rate);
  }
  return total;
}

/** "1234,56" → 123456 (integer arithmetic only). */
export function parseExtfAmount(s: string): number {
  const m = /^(-?)(\d+),(\d{2})$/.exec(s);
  if (!m) throw new Error(`invalid DATEV amount ${s}`);
  return (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3]));
}
