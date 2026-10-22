/**
 * USt-Verprobung (F08 RPT-009, GOBD-03): booked output/input VAT per rate against the revenue/expense bases × rate,
 * with the differences listed per document (journal `source`). Pure.
 *
 * Bases: lines with the tax key `USt19`/`USt7` (output, credit − debit) or `VSt19`/`VSt7` (input, debit − credit) and
 * the write-off base roles `writeoff.19`/`writeoff.7`; a base without a rate (`writeoff.recovery`) takes the single
 * output rate of its entry's VAT lines. VAT: roles `vat.output.<r>` and `vat.output.notdue.<r>` (Ist: the transfer
 * between them nets to zero) and `vat.input.<r>`. Everything is summed per document across its entries (invoice,
 * Storno and corrections net out), the expected VAT is `base × rate` half-up per document (EN 16931 computes VAT per
 * rate total) and per rate over the range. Up to 1 cent per base line counts as rounding (`withinRounding`).
 */
import { roundHalfAway } from "../money";

export interface VerprobungLine {
  account: string;
  role?: string;
  taxKey?: string;
  debitCents: number;
  creditCents: number;
}

export interface VerprobungEntry {
  id: string;
  seq: number;
  date: string;
  source: { kind: string; id: string };
  text: string;
  lines: readonly VerprobungLine[];
}

export type VerprobungSide = "output" | "input";

export interface VerprobungRow {
  side: VerprobungSide;
  rateBp: number;
  baseCents: number;
  bookedVatCents: number;
  expectedVatCents: number;
  differenceCents: number;
}

export interface VerprobungDocument extends VerprobungRow {
  source: { kind: string; id: string };
  withinRounding: boolean;
  entries: { entryId: string; seq: number; date: string; text: string }[];
}

export interface Verprobung {
  rows: VerprobungRow[];
  documents: VerprobungDocument[];
  totals: { differences: number; outsideRounding: number };
}

const RATE: Readonly<Record<string, number>> = { "19": 1900, "7": 700 };

const expected = (baseCents: number, rateBp: number) =>
  Number(roundHalfAway(BigInt(baseCents) * BigInt(rateBp), 10000n));

function baseOf(l: VerprobungLine): { side: VerprobungSide; rate: number | null } | null {
  const key = /^(USt|VSt)(19|7)$/.exec(l.taxKey ?? "");
  if (key) return { side: key[1] === "USt" ? "output" : "input", rate: RATE[key[2] as string] ?? null };
  const wo = /^writeoff\.(19|7)$/.exec(l.role ?? "");
  if (wo) return { side: "output", rate: RATE[wo[1] as string] ?? null };
  if (l.role === "writeoff.recovery") return { side: "output", rate: null };
  return null;
}

function vatOf(l: VerprobungLine): { side: VerprobungSide; rate: number } | null {
  const out = /^vat\.output\.(?:notdue\.)?(19|7)$/.exec(l.role ?? "");
  if (out) return { side: "output", rate: RATE[out[1] as string] as number };
  const inp = /^vat\.input\.(19|7)$/.exec(l.role ?? "");
  if (inp) return { side: "input", rate: RATE[inp[1] as string] as number };
  return null;
}

interface Acc {
  side: VerprobungSide;
  rateBp: number;
  baseCents: number;
  bookedVatCents: number;
  baseLines: number;
}

export function computeVerprobung(
  entries: readonly VerprobungEntry[],
  range: { from: string; to: string },
): Verprobung {
  const docs = new Map<
    string,
    { source: VerprobungEntry["source"]; acc: Map<string, Acc>; entries: Set<VerprobungEntry> }
  >();
  for (const e of entries) {
    if (e.date < range.from || e.date > range.to) continue;
    const docKey = `${e.source.kind}:${e.source.id}`;
    const doc = docs.get(docKey) ?? {
      source: e.source,
      acc: new Map<string, Acc>(),
      entries: new Set<VerprobungEntry>(),
    };
    const outputRates = new Set(
      e.lines
        .map(vatOf)
        .filter((v) => v?.side === "output")
        .map((v) => v?.rate),
    );
    let touched = false;
    const bucket = (side: VerprobungSide, rateBp: number) => {
      const k = `${side}:${rateBp}`;
      const a = doc.acc.get(k) ?? { side, rateBp, baseCents: 0, bookedVatCents: 0, baseLines: 0 };
      doc.acc.set(k, a);
      touched = true;
      return a;
    };
    for (const l of e.lines) {
      const b = baseOf(l);
      if (b) {
        const rate = b.rate ?? (outputRates.size === 1 ? ([...outputRates][0] as number) : null);
        if (rate === null) continue;
        const a = bucket(b.side, rate);
        a.baseCents += b.side === "output" ? l.creditCents - l.debitCents : l.debitCents - l.creditCents;
        a.baseLines += 1;
        continue;
      }
      const v = vatOf(l);
      if (v) {
        const a = bucket(v.side, v.rate);
        a.bookedVatCents += v.side === "output" ? l.creditCents - l.debitCents : l.debitCents - l.creditCents;
      }
    }
    if (touched) {
      doc.entries.add(e);
      docs.set(docKey, doc);
    }
  }
  const totals = new Map<string, VerprobungRow>();
  const documents: VerprobungDocument[] = [];
  for (const doc of docs.values()) {
    for (const a of doc.acc.values()) {
      const k = `${a.side}:${a.rateBp}`;
      const row = totals.get(k) ?? {
        side: a.side,
        rateBp: a.rateBp,
        baseCents: 0,
        bookedVatCents: 0,
        expectedVatCents: 0,
        differenceCents: 0,
      };
      row.baseCents += a.baseCents;
      row.bookedVatCents += a.bookedVatCents;
      totals.set(k, row);
      const exp = expected(a.baseCents, a.rateBp);
      const diff = a.bookedVatCents - exp;
      if (diff === 0) continue;
      documents.push({
        source: doc.source,
        side: a.side,
        rateBp: a.rateBp,
        baseCents: a.baseCents,
        bookedVatCents: a.bookedVatCents,
        expectedVatCents: exp,
        differenceCents: diff,
        withinRounding: a.baseLines > 0 && Math.abs(diff) <= a.baseLines,
        entries: [...doc.entries]
          .sort((x, y) => x.seq - y.seq)
          .map((e) => ({ entryId: e.id, seq: e.seq, date: e.date, text: e.text })),
      });
    }
  }
  const order = (r: { side: VerprobungSide; rateBp: number }) => (r.side === "output" ? 0 : 1) * 100000 - r.rateBp;
  const rows = [...totals.values()]
    .filter((r) => r.baseCents !== 0 || r.bookedVatCents !== 0)
    .map((r) => {
      const exp = expected(r.baseCents, r.rateBp);
      return { ...r, expectedVatCents: exp, differenceCents: r.bookedVatCents - exp };
    })
    .sort((a, b) => order(a) - order(b));
  documents.sort((a, b) => (a.entries[0]?.seq ?? 0) - (b.entries[0]?.seq ?? 0) || order(a) - order(b));
  return {
    rows,
    documents,
    totals: { differences: documents.length, outsideRounding: documents.filter((d) => !d.withinRounding).length },
  };
}
