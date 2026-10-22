/**
 * F08 §5.1 edge cases of the journal whose input comes from other domains (bank statement parsing, F07).
 */
import { describe, expect, test } from "vitest";
import { parseBankDateTime } from "../banking/dates";
import { taxPeriodOf } from "./period";
import { postEvent } from "./post";

describe("bank booking dates (E-ACC-29, ACC-024, EC-155)", () => {
  test("E-ACC-29 TST-ACC-26 a source timestamp 2026-09-30T22:30:00Z is booked on 01.10. (Europe/Berlin) and lands in Q4; a date-only source keeps its date", () => {
    // feed / CAMT DtTm instant and a UTC CSV export of the same transaction
    for (const raw of ["2026-09-30T22:30:00Z", "2026-09-30 22:30:00"]) {
      expect(parseBankDateTime(raw)).toEqual({ date: "2026-10-01", instant: "2026-09-30T22:30:00Z" });
    }
    // CAMT `BookgDt/Dt` without time: the delivered date stays
    expect(parseBankDateTime("2026-09-30")?.date).toBe("2026-09-30");
    const quarterly = [{ year: 2026, period: "quarterly" as const }];
    expect(taxPeriodOf("2026-10-01", quarterly)).toBe("2026-Q4");
    expect(taxPeriodOf("2026-09-30", quarterly)).toBe("2026-Q3");
    // the journal date of the bank posting is that booking date (period 2026-10)
    const marked = postEvent(
      {
        kind: "bank_transaction_marked",
        transactionId: "tx1",
        mark: "private",
        date: parseBankDateTime("2026-09-30T22:30:00Z")?.date ?? "",
        amountCents: -5000,
        bankAccountId: "bank1",
      },
      { taxationMethod: "soll", legalForm: "einzelunternehmen", ustvaPeriod: quarterly },
    );
    expect(marked.ok && marked.value.kind === "entry" && marked.value.posting.date).toBe("2026-10-01");
  });
});
