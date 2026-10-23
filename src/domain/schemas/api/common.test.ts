import { describe, expect, test } from "vitest";
import { decimalToScaled, parseInstant, scaledToDecimal, snakeKeys, toOptionalInstant } from "./common";

/** 05 §3 wire conventions: decimal strings with a dot (never floats), RFC 3339 instants, snake_case keys. */

describe("decimal strings (API-011)", () => {
  test("API-011 negative values, scale 0 and unsafe integers convert exactly or are refused", () => {
    expect(decimalToScaled("-12.5", 2)).toBe(-1_250);
    expect(decimalToScaled(" 7 ", 0)).toBe(7);
    expect(decimalToScaled("1.234", 2)).toBeNull(); // more decimals than the scale: refused, never rounded
    expect(decimalToScaled("1,5", 2)).toBeNull();
    expect(decimalToScaled("9999999999999.9999", 4)).toBeNull(); // beyond Number.MAX_SAFE_INTEGER
    expect(scaledToDecimal(-1_250, 2)).toBe("-12.50");
    expect(scaledToDecimal(5, 3)).toBe("0.005");
    expect(scaledToDecimal(42, 0)).toBe("42");
  });
});

describe("instants (API-011)", () => {
  test("API-011 RFC 3339 instants with Z or an offset parse; dates, garbage and impossible days are null", () => {
    expect(parseInstant("2026-10-12T08:30:00.000Z")).toBe(Date.UTC(2026, 9, 12, 8, 30));
    expect(parseInstant("2026-10-12T10:30+02:00")).toBe(Date.UTC(2026, 9, 12, 8, 30));
    expect(parseInstant("2026-10-12")).toBeNull();
    expect(parseInstant("gestern")).toBeNull();
    expect(parseInstant("2026-13-45T99:99:00Z")).toBeNull();
    expect(toOptionalInstant(null)).toBeNull();
    expect(toOptionalInstant(undefined)).toBeNull();
    expect(toOptionalInstant(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("snake_case views (API-011)", () => {
  test("API-011 nested objects and arrays become snake_case; undefined is dropped; kept keys stay verbatim", () => {
    expect(
      snakeKeys(
        {
          companyName: "Muster GmbH",
          bankAccounts: [{ accountHolder: "Max", ibanMasked: null }],
          skipped: undefined,
          customFields: { kundenGruppe: "A" },
          count: 3,
        },
        new Set(["customFields"]),
      ),
    ).toEqual({
      company_name: "Muster GmbH",
      bank_accounts: [{ account_holder: "Max", iban_masked: null }],
      custom_fields: { kundenGruppe: "A" },
      count: 3,
    });
    expect(snakeKeys("text")).toBe("text");
    expect(snakeKeys(null)).toBeNull();
  });
});
