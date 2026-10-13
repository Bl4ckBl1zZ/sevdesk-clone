/**
 * Golden parse results for bank statements (07 §4 case `statement-camt053-revolut`, F07 BNK-033/120, T07-023/151).
 *
 * Every directory below `test/fixtures/bank/revolut-statements/` is a case: each statement file (CAMT.053 `.xml`,
 * Revolut `.csv`, MT940 `.txt/.sta`) is parsed and its normalised result is compared with
 * `test/golden/bank-statements/<case>/<file>.json`. To add the owner's real, anonymised month (T07-151): create
 * `revolut-statements/owner-YYYY-MM/` with the four exports and a `case.json`, run `pnpm golden:update`, review the
 * JSON (it is the evidence for the UNSURE format assumptions, F07 Q-03) and commit with the reason.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkStatementArithmetic } from "@/domain/banking/continuity";
import { decodeStatement, parseStatement } from "@/domain/banking/statement";
import { BANK_FIXTURES, statementCases } from "../fixtures/bank/load";

interface CaseFile {
  synthetic: boolean;
  description: string;
}

describe("golden bank statements", () => {
  const cases = statementCases();

  test("07 §3.3 the synthetic Revolut month is present", () => {
    expect(cases.map((c) => c.dir)).toContain("synthetic-2026-10");
  });

  for (const c of cases) {
    const meta = JSON.parse(
      readFileSync(join(BANK_FIXTURES, "revolut-statements", c.dir, "case.json"), "utf8"),
    ) as CaseFile;
    for (const file of c.files) {
      test(`T07-023 BNK-120 ${c.dir}/${file}${meta.synthetic ? " (synthetic)" : ""}`, async () => {
        const bytes = new Uint8Array(readFileSync(join(BANK_FIXTURES, "revolut-statements", c.dir, file)));
        const text = decodeStatement(bytes);
        if (!text.ok) throw new Error(text.error.message);
        const r = parseStatement(text.value, { fileName: file });
        if (!r.ok) throw new Error(r.error.message);
        const { transactions, ...summary } = r.value;
        const golden = {
          ...summary,
          arithmetic: checkStatementArithmetic(r.value),
          transactions: transactions.map(({ raw: _raw, ...t }) => t),
        };
        await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(
          `./bank-statements/${c.dir}/${file}.json`,
        );
      });
    }
  }
});
