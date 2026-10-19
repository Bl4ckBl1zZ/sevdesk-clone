import { describe, expect, test } from "vitest";
import { statementRetentionUntil } from "../banking/statement";
import { vatCheckRetentionUntil } from "../contacts/vat-check";
import { retentionClassFor, retentionUntil } from "../documents/finalize";
import type { CalendarDate } from "../time/calendar-date";
import { isRetained, RECORD_RETENTION, RETENTION_RULE_VERSION, retentionMessage, retentionUntilFor } from "./retention";

describe("retention classes (F12 §4.7, PRV-001)", () => {
  test("PRV-001 TST-PRV-01 invoice 2018 → 2026-12-31, journal entry 2016 → 2026-12-31, quote 2020 → 2026-12-31", () => {
    expect(RETENTION_RULE_VERSION).toBe("retention-2026.1");
    expect(retentionUntilFor(RECORD_RETENTION.salesDocuments ?? "none", "2018-05-04", "2026-10-19")).toBe("2026-12-31");
    expect(retentionUntilFor(RECORD_RETENTION.journalEntries ?? "none", "2016-03-01", "2026-10-19")).toBe("2026-12-31");
    expect(retentionUntilFor(retentionClassFor("quote"), "2020-11-30", "2026-10-19")).toBe("2026-12-31");
  });

  test("PRV-001 every record type maps to its class; documents, statements and VAT checks use the rule table", () => {
    expect(RECORD_RETENTION).toMatchObject({
      auditLog: "books10",
      periods: "books10",
      verfahrensdokuVersions: "books10",
      integrityCheckpoints: "books10",
      vatIdChecks: "books10",
      payments: "vouchers8",
      bankTransactions: "vouchers8",
      cashEntries: "vouchers8",
      sendLog: "letters6",
      notifications: "none",
    });
    expect(retentionClassFor("invoice")).toBe("vouchers8");
    expect(retentionClassFor("cancellation")).toBe("vouchers8");
    expect(retentionClassFor("reminder")).toBe("letters6");
    expect(retentionClassFor("delivery_note")).toBe("letters6");
    expect(retentionUntil("invoice", "2026-10-12")).toBe("2034-12-31");
    expect(retentionUntil("order_confirmation", "2026-10-12")).toBe("2032-12-31");
    expect(statementRetentionUntil("2026-09-30")).toBe("2034-12-31");
    expect(vatCheckRetentionUntil("2026-10-12" as CalendarDate)).toBe("2036-12-31");
    expect(retentionUntilFor("none", "2026-01-01")).toBeNull();
    // before BEG IV (asOf < 2025) Buchungsbelege were kept 10 years
    expect(retentionUntilFor("vouchers8", "2018-05-04", "2024-06-30")).toBe("2028-12-31");
  });

  test("PRV-002 E-PRV-01 deletion is refused up to and including retentionUntil", () => {
    expect(isRetained("2026-12-31", "2026-12-31")).toBe(true);
    expect(isRetained("2026-12-31", "2027-01-01")).toBe(false);
    expect(isRetained(undefined, "2026-01-01")).toBe(false);
    expect(retentionMessage("RE-1001", "2034-12-31")).toBe(
      "RE-1001 ist bis 31.12.2034 aufbewahrungspflichtig und kann nicht gelöscht werden.",
    );
  });
});
