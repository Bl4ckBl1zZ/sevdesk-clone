import { describe, expect, test } from "vitest";
import { bankFixture, SYNTH } from "../../../test/fixtures/bank/load";
import { checkContinuity, checkRunningBalances, checkStatementArithmetic } from "./continuity";
import { parseStatement } from "./statement";

function st(file: string) {
  const r = parseStatement(bankFixture(`${SYNTH}/${file}`), { fileName: file });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("balance continuity (BNK-035, RI-27)", () => {
  test("BNK-035 opening + Σ entries = closing for CAMT, MT940 and the CSV's row balances", () => {
    for (const f of [
      "eur-2026-10.camt053.xml",
      "eur-2026-10.mt940.txt",
      "eur-2026-10.csv",
      "usd-2026-10.camt053.xml",
    ]) {
      expect(checkStatementArithmetic(st(f)), f).toEqual({ status: "ok" });
    }
  });

  test("BNK-035 a statement whose entries do not add up to the closing balance is reported with the difference", () => {
    const s = st("eur-2026-10.camt053.xml");
    const broken = { ...s, transactions: s.transactions.slice(1) };
    expect(checkStatementArithmetic(broken)).toEqual({
      status: "mismatch",
      diffCents: -1000,
      message: "Anfangssaldo + Umsätze (13.017,23 €) ≠ Endsaldo (13.007,23 €): Differenz −10,00 €.",
    });
  });

  test("EC-BNK-44 BNK-035 a CSV without balances is „Saldo nicht prüfbar“", () => {
    const s = st("eur-2026-10.csv");
    const noBalances = {
      ...s,
      balanceSource: "none" as const,
      transactions: s.transactions.map(({ balanceAfterCents: _b, ...t }) => t),
    };
    delete (noBalances as { openingBalanceCents?: number }).openingBalanceCents;
    delete (noBalances as { closingBalanceCents?: number }).closingBalanceCents;
    expect(checkStatementArithmetic(noBalances)).toEqual({ status: "unverifiable", message: "Saldo nicht prüfbar" });
  });

  test("EC-BNK-17 RI-27 a break in the per-row running balance names the range and the difference", () => {
    const s = st("eur-2026-10.csv");
    const txs = s.transactions.map((t, i) =>
      i === 5 ? { ...t, balanceAfterCents: (t.balanceAfterCents ?? 0) + 100 } : t,
    );
    expect(checkRunningBalances(txs, "EUR")[0]).toEqual({
      line: 7,
      diffCents: 100,
      message: "Saldenlücke zwischen 07.10.2026 und 09.10.2026: 1,00 €",
    });
  });

  test("T07-050 GOBD-02 EC-BNK-47 two statements with a missing range → „Saldenlücke“ with both dates", () => {
    const overlap = st("eur-2026-10-23_2026-11-05.overlap.camt053.xml");
    const gap = st("eur-2026-11-10_2026-11-30.gap.camt053.xml");
    expect(checkContinuity(overlap, gap, "EUR")).toEqual({
      status: "gap",
      from: "2026-11-05",
      to: "2026-11-10",
      diffCents: 5275,
      message:
        "Anfangssaldo (13.349,98 €) passt nicht zum letzten Endsaldo (13.297,23 €) – fehlen Umsätze zwischen 05.11.2026 und 10.11.2026?",
    });
  });

  test("BNK-035 consecutive statements: adjacent and matching → ok; overlapping periods are reported as overlap", () => {
    const oct = st("eur-2026-10.camt053.xml");
    const next = {
      periodFrom: "2026-11-01",
      periodTo: "2026-11-30",
      openingBalanceCents: 1_300_723,
      closingBalanceCents: 1_300_723,
    };
    expect(checkContinuity(oct, next, "EUR")).toEqual({ status: "ok" });
    expect(checkContinuity(undefined, next, "EUR")).toEqual({ status: "first" });
    const overlap = st("eur-2026-10-23_2026-11-05.overlap.camt053.xml");
    expect(checkContinuity(oct, overlap, "EUR")).toMatchObject({
      status: "overlap",
      from: "2026-10-23",
      to: "2026-10-31",
    });
  });
});
