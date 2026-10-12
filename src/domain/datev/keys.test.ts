import { describe, expect, test } from "vitest";
import { checkDatevKeyChange, personalAccountRanges, validateDatevKeys } from "./keys";

describe("SET-044 DATEV keys", () => {
  test("SET-044 DATEV-01 consultant 1001–9999999, client 1–99999, account length 4–9", () => {
    expect(validateDatevKeys({ consultantNumber: 1001, clientNumber: 1, accountLength: 4 })).toEqual([]);
    expect(validateDatevKeys({ consultantNumber: 9_999_999, clientNumber: 99_999, accountLength: 9 })).toEqual([]);
    expect(validateDatevKeys({ accountLength: 4 })).toEqual([]);
    expect(
      validateDatevKeys({ consultantNumber: 1000, clientNumber: 100_000, accountLength: 10 }).map((e) => e.code),
    ).toEqual(["DATEV_CONSULTANT_INVALID", "DATEV_CLIENT_INVALID", "DATEV_ACCOUNT_LENGTH_INVALID"]);
    expect(validateDatevKeys({ consultantNumber: 1500.5, accountLength: 4 })[0]).toMatchObject({
      code: "DATEV_CONSULTANT_INVALID",
      message: "Beraternummer: 1001 bis 9999999.",
    });
  });

  test("SET-044 DATEV-02 debtor/creditor ranges derive from the account length (§5.3)", () => {
    expect(personalAccountRanges(4)).toEqual({
      debtors: { from: 10_000, to: 69_999 },
      creditors: { from: 70_000, to: 99_999 },
    });
    expect(personalAccountRanges(5)).toEqual({
      debtors: { from: 100_000, to: 699_999 },
      creditors: { from: 700_000, to: 999_999 },
    });
  });

  test("SET-044 T-SET-088 after an export: new consultant number warns, a new account length is locked", () => {
    const before = { consultantNumber: 12345, clientNumber: 1, accountLength: 4 };
    expect(checkDatevKeyChange(before, { ...before, consultantNumber: 54321 }, 0)).toEqual({
      ok: true,
      value: { warnings: [] },
    });
    expect(checkDatevKeyChange(before, { ...before, consultantNumber: 54321 }, 2)).toEqual({
      ok: true,
      value: { warnings: ["Frühere Exporte enthalten die alte Berater-/Mandantennummer."] },
    });
    expect(checkDatevKeyChange(before, { ...before, accountLength: 5 }, 2)).toMatchObject({
      ok: false,
      error: { code: "DATEV_ACCOUNT_LENGTH_LOCKED" },
    });
    expect(checkDatevKeyChange(before, { ...before, accountLength: 5 }, 0).ok).toBe(true);
  });
});
