import { describe, expect, test } from "vitest";
import { isReversalEvent } from "@/domain/accounting/events";
import {
  checkBalanced,
  type Posting,
  type PostingContext,
  postEvent,
  type RoleLine,
  reversalPosting,
} from "@/domain/accounting/post";
import { resolveLines } from "@/domain/accounting/resolve";
import { CHARTS_LIST, type Chart } from "@/domain/rules/accounting";
import { GOLDEN_CASES, type GoldenCase } from "./cases";

const BASE: PostingContext = { taxationMethod: "soll", legalForm: "einzelunternehmen", ustvaPeriod: [] };
const BANK_LEDGER: Record<Chart, string> = { SKR03: "1200", SKR04: "1800" };

type Run = { ok: true; posting: Posting | null; none?: string } | { ok: false; code: string; message: string };

function run(c: GoldenCase): Run {
  const ctx = { ...BASE, ...c.ctx };
  if (isReversalEvent(c.event)) {
    if (!c.original) throw new Error(`${c.id}: reversal case needs an original`);
    const orig = postEvent(c.original, ctx);
    if (!orig.ok || orig.value.kind !== "entry") throw new Error(`${c.id}: original not posted`);
    return { ok: true, posting: reversalPosting(c.event, orig.value.posting, ctx) };
  }
  const r = postEvent(c.event, ctx);
  if (!r.ok) return { ok: false, code: r.error.code, message: r.error.message };
  return r.value.kind === "entry"
    ? { ok: true, posting: r.value.posting }
    : { ok: true, posting: null, none: r.value.reason };
}

function resolve(c: GoldenCase, lines: readonly RoleLine[], chart: Chart) {
  return resolveLines(lines, {
    chart,
    date: (c.event as { date: string }).date as never,
    overrides: [],
    bankAccounts: [{ id: "bank1", ledgerAccount: BANK_LEDGER[chart] }],
  });
}

describe("TST-ACC-02 posting matrix golden cases (posting-2026.1 × SKR03/SKR04 × Soll/Ist)", () => {
  test.each(GOLDEN_CASES.map((c) => [c.id, c] as const))("ACC-002 ACC-008 DATEV-02 %s", async (_id, c) => {
    const r = run(c);
    const exp = c.expect;
    if ("error" in exp) {
      // Engine errors and resolution errors (UNSURE roles) both block the posting.
      if (!r.ok) expect(r.code).toBe(exp.error);
      else {
        expect(r.posting).not.toBeNull();
        for (const chart of CHARTS_LIST) {
          const res = resolve(c, r.posting?.lines ?? [], chart);
          expect(!res.ok && res.error.code, chart).toBe(exp.error);
        }
      }
      return;
    }
    if (!r.ok) throw new Error(`${c.id}: ${r.message}`);
    if ("none" in exp) {
      expect(r.posting).toBeNull();
      expect(r.none).toBe(exp.none);
      return;
    }
    const posting = r.posting as Posting;
    expect(posting.explanation).toBe(exp.explanation);
    expect(checkBalanced(posting.lines).ok).toBe(true);
    const golden: Record<string, unknown> = { case: c.id, covers: c.covers, ruleVersion: posting.ruleVersion };
    for (const chart of CHARTS_LIST) {
      const res = resolve(c, posting.lines, chart);
      if (!res.ok) throw new Error(`${c.id} ${chart}: ${res.error.message}`);
      const actual = res.value.lines.map((l) => [
        l.role ?? l.account,
        l.account,
        l.debitCents > 0 ? "S" : "H",
        l.debitCents || l.creditCents,
      ]);
      const expected = exp.lines.map(([role, skr03, skr04, side, cents]) => [
        role,
        chart === "SKR03" ? skr03 : skr04,
        side,
        cents,
      ]);
      expect(actual, chart).toEqual(expected);
      golden[chart] = {
        date: posting.date,
        text: posting.text,
        explanation: posting.explanation,
        roleMappingVersion: res.value.roleMappingVersion,
        source: posting.source,
        lines: res.value.lines,
      };
    }
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(`./expected/${c.id}.journal.json`);
  });

  test("ACC-024 ACC-026 the P1 bank-to-invoice matches (P1, P6, P11) and cash events (P3, T5, T8, T9, T10) have golden cases", () => {
    const ids = GOLDEN_CASES.map((c) => c.id);
    for (const row of ["P1-", "P6-", "P11-", "P3-", "T5-", "T8-", "T9-", "T10-"]) {
      expect(
        ids.some((id) => id.startsWith(row)),
        row,
      ).toBe(true);
    }
  });

  test("ACC-002 every event kind of the P1 matrix has at least one golden case", () => {
    const kinds = new Set(GOLDEN_CASES.map((c) => c.event.kind));
    expect([...kinds].sort()).toEqual(
      [
        "advance_payment_received",
        "cash_transfer",
        "cash_transfer_reversed",
        "customer_refund",
        "invoice_cancelled",
        "invoice_corrected",
        "invoice_finalised",
        "opening_balance",
        "payment_received",
        "payment_reversed",
        "writeoff_recovered",
      ].sort(),
    );
  });
});
