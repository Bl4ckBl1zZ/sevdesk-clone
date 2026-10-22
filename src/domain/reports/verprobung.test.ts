import { describe, expect, test } from "vitest";
import { computeVerprobung, type VerprobungEntry } from "./verprobung";

let seq = 0;
const entry = (
  date: string,
  source: VerprobungEntry["source"],
  lines: [account: string, role: string | undefined, taxKey: string | undefined, debit: number, credit: number][],
): VerprobungEntry => ({
  id: `e${++seq}`,
  seq,
  date,
  source,
  text: `${source.kind} ${source.id}`,
  lines: lines.map(([account, role, taxKey, debitCents, creditCents]) => ({
    account,
    ...(role ? { role } : {}),
    ...(taxKey ? { taxKey } : {}),
    debitCents,
    creditCents,
  })),
});

type L = [account: string, role: string | undefined, taxKey: string | undefined, debit: number, credit: number];
const inv = (id: string, date: string, net19: number, vat19: number, net7 = 0, vat7 = 0) => {
  const lines: L[] = [
    ["1400", "receivable", undefined, net19 + vat19 + net7 + vat7, 0],
    ["8400", "revenue.domestic.19", "USt19", 0, net19],
    ["1776", "vat.output.19", undefined, 0, vat19],
  ];
  if (net7) lines.push(["8300", "revenue.domestic.7", "USt7", 0, net7], ["1771", "vat.output.7", undefined, 0, vat7]);
  return entry(date, { kind: "salesDocument", id }, lines);
};

const voucher = (id: string, date: string, net: number, vat: number) =>
  entry(date, { kind: "voucher", id }, [
    ["4930", undefined, "VSt19", net, 0],
    ["1576", "vat.input.19", undefined, vat, 0],
    ["1600", "payable", undefined, 0, net + vat],
  ]);

const range = { from: "2026-01-01", to: "2026-12-31" };

describe("USt-Verprobung (RPT-009, GOBD-03)", () => {
  test("RPT-009 booked output/input VAT per rate vs. base × rate; consistent books show no differences", () => {
    const r = computeVerprobung(
      [
        inv("a", "2026-03-01", 100000, 19000, 50000, 3500),
        inv("b", "2026-04-01", 20000, 3800),
        voucher("v", "2026-04-02", 10000, 1900),
      ],
      range,
    );
    expect(r.rows).toEqual([
      {
        side: "output",
        rateBp: 1900,
        baseCents: 120000,
        bookedVatCents: 22800,
        expectedVatCents: 22800,
        differenceCents: 0,
      },
      {
        side: "output",
        rateBp: 700,
        baseCents: 50000,
        bookedVatCents: 3500,
        expectedVatCents: 3500,
        differenceCents: 0,
      },
      {
        side: "input",
        rateBp: 1900,
        baseCents: 10000,
        bookedVatCents: 1900,
        expectedVatCents: 1900,
        differenceCents: 0,
      },
    ]);
    expect(r.documents).toEqual([]);
  });

  test("RPT-009 differences are listed per document with the contributing entries; ±1 ct per base line counts as rounding", () => {
    const wrong = inv("bad", "2026-05-01", 10000, 1700); // 17 € instead of 19 €
    const cent = voucher("v1", "2026-05-02", 10001, 1901); // 19.0019 € → 19.00 € expected, 1 ct off
    const r = computeVerprobung([wrong, cent, inv("ok", "2026-05-03", 10000, 1900)], range);
    expect(r.rows.find((x) => x.side === "output" && x.rateBp === 1900)).toMatchObject({
      baseCents: 20000,
      bookedVatCents: 3600,
      expectedVatCents: 3800,
      differenceCents: -200,
    });
    expect(r.documents).toEqual([
      {
        source: { kind: "salesDocument", id: "bad" },
        side: "output",
        rateBp: 1900,
        baseCents: 10000,
        bookedVatCents: 1700,
        expectedVatCents: 1900,
        differenceCents: -200,
        withinRounding: false,
        entries: [{ entryId: wrong.id, seq: wrong.seq, date: "2026-05-01", text: "salesDocument bad" }],
      },
      {
        source: { kind: "voucher", id: "v1" },
        side: "input",
        rateBp: 1900,
        baseCents: 10001,
        bookedVatCents: 1901,
        expectedVatCents: 1900,
        differenceCents: 1,
        withinRounding: true,
        entries: [{ entryId: cent.id, seq: cent.seq, date: "2026-05-02", text: "voucher v1" }],
      },
    ]);
    expect(r.totals).toEqual({ differences: 2, outsideRounding: 1 });
  });

  test("RPT-009 Storno nets per document; Ist transfers (notdue → output) are neutral; a VAT line without base is a difference", () => {
    const a = inv("a", "2026-06-01", 10000, 1900);
    const storno = entry("2026-06-05", { kind: "salesDocument", id: "a" }, [
      ["1400", "receivable", undefined, 0, 11900],
      ["8400", "revenue.domestic.19", "USt19", 10000, 0],
      ["1776", "vat.output.19", undefined, 1900, 0],
    ]);
    const ist = entry("2026-06-10", { kind: "payment", id: "p1" }, [
      ["1766", "vat.output.notdue.19", undefined, 1900, 0],
      ["1776", "vat.output.19", undefined, 0, 1900],
    ]);
    const manual = entry("2026-06-20", { kind: "manual", id: "m1" }, [
      ["1776", "vat.output.19", undefined, 0, 500],
      ["1800", "bank.x", undefined, 500, 0],
    ]);
    const r = computeVerprobung([a, storno, ist, manual], range);
    expect(r.documents.map((d) => [d.source.id, d.differenceCents])).toEqual([["m1", 500]]);
    expect(r.rows).toEqual([
      { side: "output", rateBp: 1900, baseCents: 0, bookedVatCents: 500, expectedVatCents: 0, differenceCents: 500 },
    ]);
  });

  test("RPT-009 entries outside the range are ignored; write-off bases (role writeoff.19) carry their rate", () => {
    const writeoff = entry("2026-07-01", { kind: "salesDocument", id: "w" }, [
      ["2400", "writeoff.19", undefined, 10000, 0],
      ["1776", "vat.output.19", undefined, 1900, 0],
      ["1400", "receivable", undefined, 0, 11900],
    ]);
    const r = computeVerprobung([inv("old", "2025-12-31", 10000, 1000), writeoff], range);
    expect(r.rows).toEqual([
      {
        side: "output",
        rateBp: 1900,
        baseCents: -10000,
        bookedVatCents: -1900,
        expectedVatCents: -1900,
        differenceCents: 0,
      },
    ]);
    expect(r.documents).toEqual([]);
  });
});
