/**
 * Einnahmenüberschussrechnung (F08 TAX-015, TAX-016, TAX-022, §4.4, §4.6; AO-02, RI-28). Pure.
 *
 * The journal is kept on the accrual principle (receivables/payables); the EÜR follows § 11 EStG (Zufluss/Abfluss).
 * `cashBasisItems` derives the cash-basis view from the journal — the „allocation view“ of F08 §4.4, computed on
 * demand instead of stored:
 *
 *  - Origination entries (a sales document or voucher posted against a receivable/payable) are deferred: their
 *    non-open-item lines form the document's **composition** (revenue/expense per account, VAT per rate).
 *  - A payment clears the open item; the cleared amount is split over the composition with the cumulative pro-rata
 *    rule of `accounting/pro-rata.ts` (largest remainder; Σ over all payments of a fully paid document = the
 *    document exactly). Write-offs are not cash: their gross is taken out of the cleared amount (Forderungsverlust =
 *    income never received, §4.6).
 *  - Every other line is recognised on its entry date by the account's EÜR key: AfA (by asset class/method from the
 *    asset register), RBW, withdrawals, private postings, Skonto/fee lines of a payment, direct bank/cash postings.
 *  - Self-assessed VAT (§ 13b, igE) is excluded from compositions: it is paid with the UStVA, not to the supplier.
 *  - § 11 Abs. 1 Satz 2 / Abs. 2 Satz 2 EStG (10-day rule, TAX-016): payments of UStVA liabilities and of vouchers
 *    flagged „regelmäßig wiederkehrend“ around the turn of the year move to the year they economically belong to.
 *
 * `computeEuer` maps the items to the Anlage EÜR lines of the year (`src/domain/rules/euer`), `buildEuerGuide` turns
 * the sheet into Mein ELSTER instructions (TAX-020).
 */
import { cumulativeShares } from "../accounting/pro-rata";
import { formatDecimal } from "../money/format";
import type { EuerKey } from "../rules/accounting/types";
import type { AveuerGroup, AveuerMapping, EuerLine, EuerMapping } from "../rules/euer";
import { addDays, calendarDate } from "../time/calendar-date";

// ── inputs ────────────────────────────────────────────────────────────────────────────────────────────

export interface EuerJournalLine {
  account: string;
  role?: string;
  debitCents: number;
  creditCents: number;
}

export interface EuerJournalEntry {
  id: string;
  seq: number;
  date: string;
  source: { kind: string; id: string };
  text: string;
  recordedAt: number;
  lines: EuerJournalLine[];
}

export interface EuerPaymentInfo {
  target: { kind: "salesDocument" | "opening_item" | "contactCredit" | "voucher"; id: string };
  /** Settled from the customer's credit balance (P12): the cleared amount is the payment amount (signed). */
  creditClearedCents?: number;
  /** Write-off part of the payment (signed like the clearing): not cash, never income. */
  writeOff?: { grossCents: number; vatCents: number };
}

export interface TenDayInfo {
  /** Statutory due date (no § 108 Abs. 3 AO shift, BFH VIII R 25/20). */
  dueDate: string;
  /** Year the payment economically belongs to (UStVA: year of the period; recurring voucher: supply year). */
  economicYear: number;
  /** Shown in the drill-down, e.g. „UStVA 12/2026“. */
  reason: string;
}

export interface EuerContext {
  euerKeyOf: (account: string) => EuerKey;
  /** Receivable/payable (and personal) accounts — the open items payments clear. */
  openItemAccounts: ReadonlySet<string>;
  payments: Readonly<Record<string, EuerPaymentInfo>>;
  /** Opening-balance receivables (ACC-013): composition in income direction, Σ = open gross. */
  openingItems: Readonly<Record<string, { grossCents: number; parts: { key: EuerKey; cents: number }[] }>>;
  /** Asset register: class and method of every asset (AfA lines by class, F08 §4.6). */
  assets: Readonly<Record<string, { assetClass: "movable" | "immovable" | "intangible"; method: string }>>;
  /** 10-day rule data per voucher id (tax payments, recurring vouchers). */
  tenDay: Readonly<Record<string, TenDayInfo>>;
  /** Kleinunternehmer on a date (routes Betriebseinnahmen to Zeile 12/13). */
  kuOn: (date: string) => boolean;
}

export interface EuerItem {
  key: EuerKey;
  /** Positive = increases the line (income for BE keys, expense for BA keys, the amount for PRIVAT keys). */
  cents: number;
  /** Payment / posting date. */
  date: string;
  /** EÜR year after the 10-day rule. */
  year: number;
  entryId: string;
  seq: number;
  source: { kind: string; id: string };
  /** The document a payment settled (drill-down: payment → document). */
  via?: { kind: string; id: string };
  account?: string;
  /** Reason when the 10-day rule moved the item to another year. */
  tenDayRule?: string;
  /** KU on the item date. */
  ku?: boolean;
}

// ── 10-day rule ───────────────────────────────────────────────────────────────────────────────────────

/** The turn of the year whose 10-day window (22.12.–10.01.) contains `date`, or null. */
function windowOf(date: string): number | null {
  const y = Number(date.slice(0, 4));
  const md = date.slice(5);
  if (md >= "12-22") return y + 1;
  if (md <= "01-10") return y;
  return null;
}

/**
 * TAX-016: the EÜR year of a regularly recurring payment. Paid **and** due within the same window around the turn of
 * the year, it belongs to the year it economically belongs to (if that is one of the two adjacent years).
 */
export function tenDayYear(paymentDate: string, dueDate: string, economicYear: number): number {
  const paidYear = Number(paymentDate.slice(0, 4));
  const w = windowOf(paymentDate);
  if (w === null || windowOf(dueDate) !== w) return paidYear;
  if (economicYear !== w && economicYear !== w - 1) return paidYear;
  return economicYear;
}

// ── cash-basis items ──────────────────────────────────────────────────────────────────────────────────

/** Self-assessed VAT and its non-deductible KU counterpart: owed to the Finanzamt, not part of the payable. */
const EXCLUDED_FROM_COMPOSITION = /^(vat\.(output|input)\.(13b|ige)\.|expense\.vat_nondeductible$)/;
const WRITEOFF_ROLE = /^writeoff\.(19|7|0)$/;

const isBe = (k: EuerKey) => k.startsWith("BE.") || k === "PRIVAT.EINLAGE";

/** Income-direction amount (credit − debit) → item cents for the key. */
function toItemCents(key: EuerKey, incomeDirCents: number): number {
  return isBe(key) ? incomeDirCents : -incomeDirCents;
}

interface Component {
  key: EuerKey;
  account?: string;
  /** Income direction (credit − debit). */
  cents: number;
}

interface Composition {
  /** Gross of the open item in clearing direction (receivable: debit − credit; payable: credit − debit). */
  payableCents: number;
  /** +1 receivable (income direction), −1 payable (expense direction). */
  direction: 1 | -1;
  components: Component[];
}

function afaKeyOf(asset: { assetClass: string; method: string } | undefined, key: EuerKey): EuerKey {
  if (!asset) return key;
  if (
    !["BA.AFA_BEWEGLICH", "BA.AFA_IMMATERIELL", "BA.AFA_UNBEWEGLICH", "BA.GWG", "BA.SAMMELPOSTEN_AUFLOESUNG"].includes(
      key,
    )
  )
    return key;
  if (asset.method === "gwg") return "BA.GWG";
  if (asset.method === "pool") return "BA.SAMMELPOSTEN_AUFLOESUNG";
  if (asset.assetClass === "intangible") return "BA.AFA_IMMATERIELL";
  if (asset.assetClass === "immovable") return "BA.AFA_UNBEWEGLICH";
  return "BA.AFA_BEWEGLICH";
}

/** Signed pro-rata shares (the cumulative rule needs a positive payable). */
function shares(totals: number[], payable: number, before: number, now: number): number[] {
  const s = payable < 0 ? -1 : 1;
  const t = totals.map((x) => x * s);
  const p = payable * s;
  const after = cumulativeShares(t, p, (before + now) * s);
  const prev = cumulativeShares(t, p, before * s);
  return after.map((a, i) => (a - (prev[i] ?? 0)) * s);
}

/**
 * The cash-basis items of the whole journal (all years; partial payments need the history). Entries must be in
 * `seq` order.
 */
export function cashBasisItems(entries: readonly EuerJournalEntry[], c: EuerContext): EuerItem[] {
  const isOpenItem = (l: EuerJournalLine) =>
    l.role === "receivable" || l.role === "payable" || c.openItemAccounts.has(l.account);
  const compositions = new Map<string, Composition>();
  const origination = new Set<string>();

  // compositions from the origination entries (incl. their reversals/corrections under the same source)
  for (const e of entries) {
    if (e.source.kind !== "salesDocument" && e.source.kind !== "voucher") continue;
    const oi = e.lines.filter(isOpenItem);
    if (oi.length === 0) continue;
    origination.add(e.id);
    const key = `${e.source.kind}:${e.source.id}`;
    const payableRole = oi.some((l) => l.role === "payable") || oi.every((l) => l.creditCents > l.debitCents);
    const direction: 1 | -1 = payableRole && !oi.some((l) => l.role === "receivable") ? -1 : 1;
    const comp = compositions.get(key) ?? { payableCents: 0, direction, components: [] };
    for (const l of oi)
      comp.payableCents += direction === 1 ? l.debitCents - l.creditCents : l.creditCents - l.debitCents;
    for (const l of e.lines) {
      if (isOpenItem(l) || (l.role && EXCLUDED_FROM_COMPOSITION.test(l.role))) continue;
      comp.components.push({ key: c.euerKeyOf(l.account), account: l.account, cents: l.creditCents - l.debitCents });
    }
    compositions.set(key, comp);
  }
  for (const [k, o] of Object.entries(c.openingItems)) {
    compositions.set(`opening_item:${k}`, {
      payableCents: o.grossCents,
      direction: 1,
      components: o.parts.map((p) => ({ key: p.key, cents: p.cents })),
    });
  }

  const settled = new Map<string, number>();
  const out: EuerItem[] = [];
  const push = (e: EuerJournalEntry, key: EuerKey, cents: number, extra: Partial<EuerItem> = {}) => {
    if (key === "NONE" || cents === 0) return;
    let k = key;
    let v = cents;
    // a negative payment to the Finanzamt is a refund (Zeile 18), not a negative Zeile 58
    if (k === "BA.UST_GEZAHLT" && v < 0) {
      k = "BE.UST_ERSTATTET";
      v = -v;
    }
    const year = extra.year ?? Number(e.date.slice(0, 4));
    out.push({
      key: k,
      cents: v,
      date: e.date,
      year,
      entryId: e.id,
      seq: e.seq,
      source: e.source,
      ...(c.kuOn(e.date) ? { ku: true } : {}),
      ...extra,
    });
  };

  for (const e of entries) {
    if (origination.has(e.id)) continue;
    const payment = e.source.kind === "payment" ? c.payments[e.source.id] : undefined;
    const target = payment?.target;
    const comp =
      target && target.kind !== "contactCredit" ? compositions.get(`${target.kind}:${target.id}`) : undefined;
    const ten = target?.kind === "voucher" ? c.tenDay[target.id] : undefined;
    const tenYear = ten ? tenDayYear(e.date, ten.dueDate, ten.economicYear) : undefined;
    const tenExtra =
      ten && tenYear !== undefined && tenYear !== Number(e.date.slice(0, 4))
        ? { year: tenYear, tenDayRule: ten.reason }
        : {};
    let writeOffVat = 0;

    if (comp && target) {
      // cleared amount of the open item by this entry, in clearing direction
      let cleared = 0;
      if (payment?.creditClearedCents !== undefined) cleared = payment.creditClearedCents;
      else
        for (const l of e.lines.filter(isOpenItem))
          cleared += comp.direction === 1 ? l.creditCents - l.debitCents : l.debitCents - l.creditCents;
      if (payment?.writeOff) {
        cleared -= payment.writeOff.grossCents;
        writeOffVat = payment.writeOff.vatCents;
      }
      const key = `${target.kind}:${target.id}`;
      const before = settled.get(key) ?? 0;
      settled.set(key, before + cleared);
      if (cleared !== 0 && comp.payableCents !== 0) {
        const parts = shares(
          comp.components.map((x) => x.cents * comp.direction),
          comp.payableCents,
          before,
          cleared,
        );
        comp.components.forEach((x, i) => {
          const incomeDir = (parts[i] ?? 0) * comp.direction;
          push(e, x.key, toItemCents(x.key, incomeDir), {
            via: { kind: target.kind, id: target.id },
            ...(x.account ? { account: x.account } : {}),
            ...tenExtra,
          });
        });
      }
    }
    // every other line by its own key (open items of a cleared target were expanded above)
    const assetId = e.source.kind === "asset_depreciation" ? e.source.id.split(":")[0] : undefined;
    for (const l of e.lines) {
      if (isOpenItem(l)) continue;
      if (payment?.writeOff && l.role && WRITEOFF_ROLE.test(l.role)) continue;
      let key = c.euerKeyOf(l.account);
      if (assetId) key = afaKeyOf(c.assets[assetId], key);
      push(e, key, toItemCents(key, l.creditCents - l.debitCents), { account: l.account, ...tenExtra });
    }
    // the write-off's VAT correction cancels out: VAT that was never received
    if (writeOffVat !== 0) push(e, "BE.UST_VEREINNAHMT", writeOffVat, tenExtra);
  }
  return out;
}

// ── Anlage EÜR sheet ──────────────────────────────────────────────────────────────────────────────────

export interface EuerDrill {
  entryId: string;
  seq: number;
  date: string;
  cents: number;
  source: { kind: string; id: string };
  via?: { kind: string; id: string };
  tenDayRule?: string;
}

export interface EuerSheetLine extends EuerLine {
  valueCents: number;
  drillDown: EuerDrill[];
}

export interface EuerSheet {
  year: number;
  mappingVersion: string | null;
  formName: string;
  verified: boolean;
  lines: EuerSheetLine[];
  sums: {
    einnahmenCents: number;
    ausgabenCents: number;
    gewinnCents: number;
    nichtAbziehbarCents: number;
    entnahmenCents: number;
    einlagenCents: number;
  };
  /** Kz → cents: non-zero lines plus the sums (159, 199, 219) — the frozen filing values. */
  values: Record<string, number>;
  /** Items without a line of the form (shown, so nothing is dropped silently). */
  unmapped: { key: EuerKey; cents: number }[];
  notices: string[];
  /** Conditions that block the guide and the submission record. */
  blockers: string[];
  sumFields: EuerMapping["sums"] | null;
}

export const euerUnverifiedNotice = (year: number) =>
  `Zeilen gegen amtlichen Vordruck prüfen – die Zuordnung für ${year} ist noch nicht geprüft.`;
export const euerMappingMissingNotice = (year: number) =>
  `Die Zeilenzuordnung der Anlage EÜR für ${year} ist noch nicht hinterlegt. Bitte Update einspielen.`;

export interface EuerOptions {
  /** KU in the year (no Vorsteuer, Zeile 12). */
  ku: boolean;
  /** RI-28: manual entries on receivable/payable accounts in the year. */
  manualOpenItemEntries?: number;
  /** Opening items without a stored VAT split (assumed fully taxable). */
  openingItemsWithoutSplit?: number;
}

function lineFor(lines: readonly EuerLine[], item: EuerItem): EuerLine | undefined {
  const cands = lines.filter((l) => l.keys.includes(item.key) && !l.informational);
  if (cands.length <= 1) return cands[0];
  return cands.find((l) => (item.ku ? l.kuOnly : !l.kuOnly)) ?? cands[0];
}

export function computeEuer(
  year: number,
  items: readonly EuerItem[],
  mapping: EuerMapping | null,
  o: EuerOptions,
): EuerSheet {
  const notices: string[] = [];
  const blockers: string[] = [];
  const ofYear = items.filter((i) => i.year === year);
  if (!mapping) {
    notices.push(euerMappingMissingNotice(year));
    blockers.push(euerMappingMissingNotice(year));
  } else if (!mapping.verifiedAgainstForm) {
    notices.push(euerUnverifiedNotice(year));
    blockers.push(euerUnverifiedNotice(year));
  }
  const lines: EuerSheetLine[] = (mapping?.lines ?? []).map((l) => ({ ...l, valueCents: 0, drillDown: [] }));
  const unmapped = new Map<EuerKey, number>();
  const drill = (i: EuerItem): EuerDrill => ({
    entryId: i.entryId,
    seq: i.seq,
    date: i.date,
    cents: i.cents,
    source: i.source,
    ...(i.via ? { via: i.via } : {}),
    ...(i.tenDayRule ? { tenDayRule: i.tenDayRule } : {}),
  });
  for (const i of ofYear) {
    const def = mapping ? lineFor(mapping.lines, i) : undefined;
    const line = def ? lines.find((l) => l.kz === def.kz && l.zeile === def.zeile) : undefined;
    if (!line) {
      unmapped.set(i.key, (unmapped.get(i.key) ?? 0) + i.cents);
      continue;
    }
    line.valueCents += i.cents;
    line.drillDown.push(drill(i));
    // „davon“ lines (Zeile 13: non-taxable receipts of a KU)
    for (const info of lines.filter((l) => l.informational && l.keys.includes(i.key) && (!l.kuOnly || i.ku))) {
      info.valueCents += i.cents;
      info.drillDown.push(drill(i));
    }
  }
  const sumOf = (pred: (l: EuerSheetLine) => boolean) =>
    lines.filter((l) => pred(l) && !l.informational).reduce((s, l) => s + l.valueCents, 0);
  const einnahmenCents = sumOf((l) => l.section === "BE");
  const ausgabenCents = sumOf(
    (l) => l.section === "BA" || l.section === "KFZ" || (l.section === "BA_BESCHRAENKT" && l.column === "abziehbar"),
  );
  const nichtAbziehbarCents = sumOf((l) => l.section === "BA_BESCHRAENKT" && l.column === "nicht_abziehbar");
  const entnahmenCents = sumOf((l) => l.keys.includes("PRIVAT.ENTNAHME"));
  const einlagenCents = sumOf((l) => l.keys.includes("PRIVAT.EINLAGE"));
  const gewinnCents = einnahmenCents - ausgabenCents;

  const values: Record<string, number> = {};
  for (const l of lines) if (l.valueCents !== 0) values[l.kz] = (values[l.kz] ?? 0) + l.valueCents;
  if (mapping) {
    values[mapping.sums.einnahmen.kz] = einnahmenCents;
    values[mapping.sums.ausgaben.kz] = ausgabenCents;
    values[mapping.sums.gewinn.kz] = gewinnCents;
  }
  if (unmapped.size > 0) {
    blockers.push(
      `Beträge ohne Zeile der Anlage EÜR (${[...unmapped.keys()].join(", ")}). Bitte Kontenzuordnung prüfen.`,
    );
  }
  const interest = lines.filter((l) => l.keys.includes("BA.ZINSEN")).reduce((s, l) => s + l.valueCents, 0);
  if (mapping && interest > mapping.anlageSzThresholdCents) {
    blockers.push(
      `Schuldzinsen über ${formatDecimal(mapping.anlageSzThresholdCents, 2)} €: Die Anlage SZ (§ 4 Abs. 4a EStG) wird von der App nicht berechnet. Bitte Hinzurechnungsbetrag selbst ermitteln.`,
    );
  }
  if (o.manualOpenItemEntries) {
    notices.push(
      `${o.manualOpenItemEntries} manuelle Buchung(en) auf Forderungs- oder Verbindlichkeitskonten sind in der EÜR zum Buchungsdatum enthalten – bitte prüfen, ob der Zahlungszeitpunkt gemeint ist.`,
    );
  }
  if (o.openingItemsWithoutSplit) {
    notices.push(
      `${o.openingItemsWithoutSplit} Eröffnungsposten ohne Steueraufteilung wurden als umsatzsteuerpflichtige Einnahmen angesetzt.`,
    );
  }
  return {
    year,
    mappingVersion: mapping?.version ?? null,
    formName: mapping?.formName ?? `Anlage EÜR ${year}`,
    verified: mapping?.verifiedAgainstForm !== undefined,
    lines,
    sums: { einnahmenCents, ausgabenCents, gewinnCents, nichtAbziehbarCents, entnahmenCents, einlagenCents },
    values,
    unmapped: [...unmapped].map(([key, cents]) => ({ key, cents })),
    notices,
    blockers,
    sumFields: mapping?.sums ?? null,
  };
}

// ── Anlage AVEÜR (TAX-022, AST-012) ───────────────────────────────────────────────────────────────────

export interface AveuerGroupInput {
  group: AveuerGroup["key"];
  akCents: number;
  bookValueStartCents: number;
  additionsCents: number;
  afaCents: number;
  disposalsCents: number;
  bookValueEndCents: number;
}

export interface AveuerPoolInput {
  poolYear: number;
  akCents: number;
  bookValueStartCents: number;
  releaseCents: number;
  bookValueEndCents: number;
}

export interface AveuerField {
  zeile: number;
  kz: string;
  label: string;
  valueCents: number;
}

export interface Aveuer {
  groups: { key: string; title: string; fields: AveuerField[] }[];
  fields: AveuerField[];
}

const AVEUER_LABEL: Record<keyof AveuerGroup["fields"], string> = {
  akCents: "Summe Anschaffungs-/Herstellungskosten/Einlagewerte",
  bookValueStartCents: "Summe Buchwerte zu Beginn",
  additionsCents: "Summe Zugänge",
  afaCents: "Summe AfA",
  disposalsCents: "Summe Abgänge",
  bookValueEndCents: "Summe Buchwerte am Ende",
};

/** AVEÜR values per group of the year's mapping (null when there are no assets or no mapping). */
export function computeAveuer(
  mapping: AveuerMapping | null,
  year: number,
  groups: readonly AveuerGroupInput[],
  pools: readonly AveuerPoolInput[],
): Aveuer | null {
  if (!mapping || (groups.length === 0 && pools.length === 0)) return null;
  const out: Aveuer["groups"] = [];
  for (const g of mapping.groups) {
    const rows = groups.filter((x) => x.group === g.key);
    if (rows.length === 0) continue;
    const fields: AveuerField[] = [];
    for (const k of Object.keys(g.fields) as (keyof AveuerGroup["fields"])[]) {
      const f = g.fields[k];
      fields.push({ zeile: f.zeile, kz: f.kz, label: AVEUER_LABEL[k], valueCents: rows.reduce((s, r) => s + r[k], 0) });
    }
    out.push({ key: g.key, title: g.title, fields });
  }
  for (const p of mapping.pools) {
    const pool = pools.find((x) => x.poolYear === year - p.offset);
    if (!pool) continue;
    const fields: AveuerField[] = [
      {
        zeile: p.akZeile,
        kz: p.akKz,
        label: p.offset === 0 ? "Bildung" : "Anschaffungs-/Herstellungskosten",
        valueCents: pool.akCents,
      },
      ...(p.startKz
        ? [{ zeile: p.akZeile + 1, kz: p.startKz, label: "Buchwert zu Beginn", valueCents: pool.bookValueStartCents }]
        : []),
      { zeile: p.releaseZeile, kz: p.releaseKz, label: "Auflösungsbetrag", valueCents: pool.releaseCents },
      ...(p.endKz
        ? [{ zeile: p.releaseZeile + 1, kz: p.endKz, label: "Buchwert am Ende", valueCents: pool.bookValueEndCents }]
        : []),
    ];
    out.push({ key: `pool-${pool.poolYear}`, title: `Sammelposten aus ${pool.poolYear}`, fields });
  }
  return { groups: out, fields: out.flatMap((g) => g.fields) };
}

// ── Mein ELSTER guide (TAX-020, TAX-022) ──────────────────────────────────────────────────────────────

/** Euro and cent, decimal comma, no thousands separator, leading minus; zero → „leer lassen“ except sums. */
export function euerCopyString(valueCents: number, always: boolean): string | null {
  if (valueCents === 0 && !always) return null;
  return formatDecimal(valueCents, 2).replace(/\./g, "");
}

export interface EuerGuideField {
  kz: string;
  zeile: number;
  label: string;
  valueCents: number;
  copy: string | null;
}

export interface EuerGuide {
  id: string;
  formName: string;
  formYear: number;
  formYearWarning?: string;
  prerequisites: string[];
  navigation: string[];
  steps: { title: string; fields: EuerGuideField[]; instruction?: string }[];
  checklist: string[];
  blocked: boolean;
  blockers: string[];
  sheetHash: string;
}

const PARTNERSHIPS = new Set(["gbr", "egbr", "ohg", "kg", "gmbh_co_kg", "partg"]);

const SECTION_TITLE: Record<EuerLine["section"], string> = {
  BE: "1. Betriebseinnahmen",
  BA: "2. Betriebsausgaben",
  BA_BESCHRAENKT: "Beschränkt abziehbare Betriebsausgaben",
  KFZ: "Kfz-Kosten und andere Fahrtkosten",
  ERGEBNIS: "3. Ermittlung des Gewinns",
  PRIVAT: "5. Zusätzliche Angaben bei Einzelunternehmen – Entnahmen und Einlagen",
};

/**
 * Mein ELSTER instructions for the Anlage EÜR (+ AVEÜR): path per legal form (sole proprietors within the
 * Einkommensteuererklärung, partnerships within the Feststellungserklärung), fields by Zeile with copy strings, the
 * sums, the final checklist. Blocked while the sheet has blockers (unverified mapping, Anlage SZ, unmapped amounts)
 * or the read model reports some (E-UVA-21, drafts …).
 * LEGAL-OPEN: F08-Q12 — Mein ELSTER navigation labels ⚠ verified per data release.
 */
export function buildEuerGuide(
  sheet: EuerSheet,
  aveuer: Aveuer | null,
  o: { legalForm: string; today: string; sheetHash: string; blockers?: readonly string[] },
): EuerGuide {
  const y = sheet.year;
  const partnership = PARTNERSHIPS.has(o.legalForm);
  const blockers = [...sheet.blockers, ...(o.blockers ?? [])];
  const steps: EuerGuide["steps"] = [];
  const sections: EuerLine["section"][] = ["BE", "BA", "BA_BESCHRAENKT", "KFZ"];
  const field = (l: { kz: string; zeile: number; label: string; valueCents: number }, always = false) => ({
    kz: l.kz,
    zeile: l.zeile,
    label: l.label,
    valueCents: l.valueCents,
    copy: euerCopyString(l.valueCents, always),
  });
  for (const s of sections) {
    const fields = sheet.lines
      .filter((l) => l.section === s && l.valueCents !== 0)
      .sort((a, b) => a.zeile - b.zeile)
      .map((l) => field(l));
    if (s === "BE" && sheet.sumFields) {
      fields.push(
        field(
          { ...sheet.sumFields.einnahmen, label: "Summe Betriebseinnahmen", valueCents: sheet.sums.einnahmenCents },
          true,
        ),
      );
    }
    if (fields.length > 0) steps.push({ title: SECTION_TITLE[s], fields });
  }
  if (sheet.sumFields) {
    steps.push({
      title: SECTION_TITLE.ERGEBNIS,
      fields: [
        field(
          { ...sheet.sumFields.ausgaben, label: "Summe Betriebsausgaben", valueCents: sheet.sums.ausgabenCents },
          true,
        ),
        field(
          { ...sheet.sumFields.gewinn, label: "Steuerpflichtiger Gewinn/Verlust", valueCents: sheet.sums.gewinnCents },
          true,
        ),
      ],
      instruction:
        "ELSTER berechnet die Zwischensummen selbst. Der Gewinn/Verlust in Zeile 97 muss mit dem Wert dieser Seite übereinstimmen.",
    });
  }
  if (!partnership) {
    const priv = sheet.lines.filter((l) => l.section === "PRIVAT" && l.valueCents !== 0).map((l) => field(l));
    if (priv.length > 0) steps.push({ title: SECTION_TITLE.PRIVAT, fields: priv });
  }
  if (aveuer) {
    steps.push({
      title: "Anlage AVEÜR",
      fields: aveuer.fields.filter((f) => f.valueCents !== 0).map((f) => field(f)),
      instruction: "Anlage AVEÜR (Anlageverzeichnis) im selben Formular öffnen; GWG werden dort nicht eingetragen.",
    });
  }
  const today = Number(o.today.slice(0, 4));
  return {
    id: `elster-euer-${y}`,
    formName: `Anlage EÜR ${y}${aveuer ? " mit Anlage AVEÜR" : ""}`,
    formYear: y,
    ...(today > y ? { formYearWarning: `Achtung: Formular ${y} wählen, nicht ${today}.` } : {}),
    prerequisites: [
      "ELSTER-Konto (Zertifikatsdatei, Sicherheitsstick oder ELSTER-Unternehmenskonto) einrichten – einmalig, der Aktivierungsbrief kommt per Post.",
      "Steuernummer des Betriebs in den Firmendaten hinterlegen.",
      "Mein ELSTER in einem zweiten Fenster neben dieser Seite öffnen und die Werte Zeile für Zeile kopieren.",
    ],
    navigation: partnership
      ? [
          "Formulare & Leistungen",
          "Alle Formulare",
          "Feststellung",
          `Erklärung zur gesonderten und einheitlichen Feststellung ${y}`,
          "Anlage EÜR",
        ]
      : ["Formulare & Leistungen", "Alle Formulare", "Einkommensteuer", `Einkommensteuererklärung ${y}`, "Anlage EÜR"],
    steps,
    checklist: [
      "Steuernummer und Kalenderjahr im ELSTER-Formular stimmen.",
      `Formularjahr stimmt (Anlage EÜR ${y}).`,
      "Alle Werte dieser Ausfüllhilfe sind eingetragen, leere Felder bleiben leer.",
      ...(aveuer ? ["Die Anlage AVEÜR ist ausgefüllt und passt zum Anlagenspiegel."] : []),
      "ELSTER-Funktion „Prüfen“ zeigt keine Fehler.",
      "Der Gewinn/Verlust in ELSTER entspricht dem Gewinn/Verlust auf dieser Seite.",
      "„Absenden“ wählen (zusammen mit der Erklärung), danach das Übermittlungsprotokoll (PDF) speichern und das Transferticket notieren.",
    ],
    blocked: blockers.length > 0,
    blockers,
    sheetHash: o.sheetHash,
  };
}

/** First and last day of a calendar year (EÜR = calendar year, TAX-015). */
export const euerYearRange = (year: number) => ({
  from: calendarDate(`${year}-01-01`),
  to: calendarDate(`${year}-12-31`),
  /** Last day a 10-day-rule payment of the year can be made. */
  tenDayEnd: addDays(calendarDate(`${year + 1}-01-01`), 9),
});
