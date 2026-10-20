/**
 * Anlagenspiegel, GWG-Verzeichnis and Sammelposten overview (F08 AST-007, AST-008, AST-012; AO-03). Pure.
 *
 * Values come from the **posted** movements (AfA and RBW entries on the asset account, read from the journal) so the
 * book value at year end equals the journal balance of the asset accounts (TST-AST-11). Conventions:
 *  - GWG: Zugang and (fiktiver) Abgang in the acquisition year (fully written off).
 *  - Sammelposten items: leave after the 5th pool year (fully written off); a sale/scrap of a pool item is no Abgang.
 *  - Other assets leave in the year of their disposal date.
 */
import { roundHalfAway } from "../money";
import type { AssetMethod } from "./methods";

export interface ReportAsset {
  id: string;
  inventoryNumber: string;
  name: string;
  account: string;
  acquisitionDate: string;
  costCents: number;
  method: AssetMethod;
  poolYear?: number;
  disposal?: { date: string; kind: string };
}

export interface Movement {
  date: string;
  kind: "afa" | "rbw";
  amountCents: number;
}

export interface YearRange {
  from: string;
  to: string;
}

export interface SpiegelValues {
  akStartCents: number;
  additionsCents: number;
  disposalsCents: number;
  akEndCents: number;
  accumulatedStartCents: number;
  afaYearCents: number;
  rbwYearCents: number;
  accumulatedEndCents: number;
  bookValueStartCents: number;
  bookValueEndCents: number;
}

export interface SpiegelRow extends SpiegelValues {
  id: string;
  inventoryNumber: string;
  name: string;
  account: string;
  acquisitionDate: string;
  method: AssetMethod;
}

export interface Anlagenspiegel {
  assets: SpiegelRow[];
  groups: (SpiegelValues & { account: string; count: number })[];
  total: SpiegelValues;
}

const ZERO: SpiegelValues = {
  akStartCents: 0,
  additionsCents: 0,
  disposalsCents: 0,
  akEndCents: 0,
  accumulatedStartCents: 0,
  afaYearCents: 0,
  rbwYearCents: 0,
  accumulatedEndCents: 0,
  bookValueStartCents: 0,
  bookValueEndCents: 0,
};

function add(a: SpiegelValues, b: SpiegelValues): SpiegelValues {
  const out = { ...a };
  for (const k of Object.keys(ZERO) as (keyof SpiegelValues)[]) out[k] = a[k] + b[k];
  return out;
}

/** Date the asset leaves the register (Abgang), or null while held. */
function exitDate(a: ReportAsset): string | null {
  if (a.method === "gwg") return a.acquisitionDate;
  if (a.method === "pool") {
    const year = a.poolYear ?? Number(a.acquisitionDate.slice(0, 4));
    return `${year + 4}-12-31`;
  }
  return a.disposal?.date ?? null;
}

const sum = (list: readonly Movement[], pred: (m: Movement) => boolean) =>
  list.filter(pred).reduce((s, m) => s + m.amountCents, 0);

/** AST-012 per asset and per account (asset accounts in number order). */
export function anlagenspiegel(
  assets: readonly ReportAsset[],
  movements: Readonly<Record<string, readonly Movement[]>>,
  range: YearRange,
): Anlagenspiegel {
  const rows: SpiegelRow[] = [];
  for (const a of assets) {
    const exit = exitDate(a);
    const heldAtStart = a.acquisitionDate < range.from && !(exit !== null && exit < range.from);
    const added = a.acquisitionDate >= range.from && a.acquisitionDate <= range.to;
    if (!heldAtStart && !added) continue;
    const leaves = exit !== null && exit >= range.from && exit <= range.to;
    const m = movements[a.id] ?? [];
    const afaBefore = sum(m, (x) => x.kind === "afa" && x.date < range.from);
    const afaYear = sum(m, (x) => x.kind === "afa" && x.date >= range.from && x.date <= range.to);
    const rbwYear = sum(m, (x) => x.kind === "rbw" && x.date >= range.from && x.date <= range.to);
    const akStart = heldAtStart ? a.costCents : 0;
    const additions = added ? a.costCents : 0;
    const disposals = leaves ? a.costCents : 0;
    const accumulatedStart = heldAtStart ? afaBefore : 0;
    const accumulatedEnd = leaves ? 0 : afaBefore + afaYear;
    const akEnd = akStart + additions - disposals;
    rows.push({
      id: a.id,
      inventoryNumber: a.inventoryNumber,
      name: a.name,
      account: a.account,
      acquisitionDate: a.acquisitionDate,
      method: a.method,
      akStartCents: akStart,
      additionsCents: additions,
      disposalsCents: disposals,
      akEndCents: akEnd,
      accumulatedStartCents: accumulatedStart,
      afaYearCents: afaYear,
      rbwYearCents: rbwYear,
      accumulatedEndCents: accumulatedEnd,
      bookValueStartCents: akStart - accumulatedStart,
      bookValueEndCents: akEnd - accumulatedEnd,
    });
  }
  rows.sort((x, y) =>
    x.account === y.account ? x.inventoryNumber.localeCompare(y.inventoryNumber) : x.account.localeCompare(y.account),
  );
  const groups = new Map<string, SpiegelValues & { account: string; count: number }>();
  for (const r of rows) {
    const g = groups.get(r.account) ?? { ...ZERO, account: r.account, count: 0 };
    groups.set(r.account, { ...add(g, r), account: r.account, count: g.count + 1 });
  }
  return {
    assets: rows,
    groups: [...groups.values()],
    total: rows.reduce<SpiegelValues>((t, r) => add(t, r), { ...ZERO }),
  };
}

export interface GwgListAsset {
  id: string;
  inventoryNumber: string;
  name: string;
  acquisitionDate: string;
  costCents: number;
  method: AssetMethod;
  voucherNumber?: string;
  voucherId?: string;
}

/** AST-007 GWG-Verzeichnis: GWG above the recording limit (250 € net, § 6 Abs. 2 S. 4 EStG) acquired in the year. */
export function gwgList(
  assets: readonly GwgListAsset[],
  range: YearRange,
  recordingLimitCents = 25_000,
): GwgListAsset[] {
  return assets
    .filter(
      (a) =>
        a.method === "gwg" &&
        a.costCents > recordingLimitCents &&
        a.acquisitionDate >= range.from &&
        a.acquisitionDate <= range.to,
    )
    .sort(
      (x, y) =>
        x.acquisitionDate.localeCompare(y.acquisitionDate) || x.inventoryNumber.localeCompare(y.inventoryNumber),
    );
}

export interface PoolItem {
  id: string;
  inventoryNumber: string;
  name: string;
  poolYear: number;
  costCents: number;
}

export interface PoolSummaryRow {
  poolYear: number;
  costCents: number;
  items: number;
  afaYearCents: number;
  bookValueEndCents: number;
  lastYear: number;
}

/** AST-008 Sammelposten per pool year: 20 % per year for 5 years (the 5th year absorbs the rounding). */
export function poolSummary(items: readonly PoolItem[], year: number): PoolSummaryRow[] {
  const pools = new Map<number, PoolItem[]>();
  for (const it of items) pools.set(it.poolYear, [...(pools.get(it.poolYear) ?? []), it]);
  const out: PoolSummaryRow[] = [];
  for (const [poolYear, list] of [...pools.entries()].sort((a, b) => a[0] - b[0])) {
    if (year < poolYear || year > poolYear + 4) continue;
    const cost = list.reduce((s, it) => s + it.costCents, 0);
    const elapsed = year - poolYear + 1;
    // Per item as posted (D3): 20 % rounded half-up, the 5th year absorbs the remainder.
    let afaYear = 0;
    let written = 0;
    for (const it of list) {
      const per = Number(roundHalfAway(BigInt(it.costCents) * 2000n, 10_000n));
      afaYear += elapsed === 5 ? it.costCents - per * 4 : per;
      written += elapsed === 5 ? it.costCents : per * elapsed;
    }
    out.push({
      poolYear,
      costCents: cost,
      items: list.length,
      afaYearCents: afaYear,
      bookValueEndCents: cost - written,
      lastYear: poolYear + 4,
    });
  }
  return out;
}
