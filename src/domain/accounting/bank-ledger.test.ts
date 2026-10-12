import { describe, expect, test } from "vitest";
import { defaultBankLedgerAccount } from "./bank-ledger";

describe("bank ledger account (F01 SET-053)", () => {
  test("SET-053 SKR03 starts at 1200, SKR04 at 1800, then the next free account; a full range yields null", () => {
    expect(defaultBankLedgerAccount("SKR03", [])).toBe("1200");
    expect(defaultBankLedgerAccount("SKR04", [])).toBe("1800");
    expect(defaultBankLedgerAccount("SKR03", ["1200", "1201"])).toBe("1202");
    const all = Array.from({ length: 100 }, (_, i) => String(1800 + i));
    expect(defaultBankLedgerAccount("SKR04", all)).toBeNull();
  });
});
