import { describe, expect, test } from "vitest";
import { bankLedgerIncomplete, defaultBankLedgerAccount } from "./bank-ledger";

describe("bank ledger account (F01 SET-053)", () => {
  test("SET-053 SKR03 starts at 1200, SKR04 at 1800, then the next free account; a full range yields null", () => {
    expect(defaultBankLedgerAccount("SKR03", [])).toBe("1200");
    expect(defaultBankLedgerAccount("SKR04", [])).toBe("1800");
    expect(defaultBankLedgerAccount("SKR03", ["1200", "1201"])).toBe("1202");
    const all = Array.from({ length: 100 }, (_, i) => String(1800 + i));
    expect(defaultBankLedgerAccount("SKR04", all)).toBeNull();
  });
});

describe("P1 bank catch-up (ACC-027)", () => {
  test("ACC-027 a bank ledger account is incomplete while open or partially matched transactions exist", () => {
    expect(bankLedgerIncomplete(["matched", "transfer", "private", "ignored"])).toBe(false);
    expect(bankLedgerIncomplete(["matched", "open"])).toBe(true);
    expect(bankLedgerIncomplete(["partially_matched"])).toBe(true);
    expect(bankLedgerIncomplete([])).toBe(false);
  });
});
