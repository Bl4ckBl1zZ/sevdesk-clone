import { describe, expect, test } from "vitest";
import { parseIban } from "./iban";

describe("IBAN validation (wraps ibantools)", () => {
  test("CON-093 valid IBANs are normalised to the electronic format with a grouped display form", () => {
    const r = parseIban(" de89 3704 0044 0532 0130 00 ");
    expect(r.ok && r.value).toEqual({
      iban: "DE89370400440532013000",
      display: "DE89 3704 0044 0532 0130 00",
      countryCode: "DE",
    });
    const at = parseIban("AT611904300234573201");
    expect(at.ok && at.value.countryCode).toBe("AT");
  });

  test("CON-093 invalid IBANs return iban_invalid with the German message", () => {
    for (const bad of [
      "",
      "DE89370400440532013001",
      "DE8937040044053201300",
      "XX89370400440532013000",
      "not an iban",
    ]) {
      const r = parseIban(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("iban_invalid");
        expect(r.error.message).toMatch(/^Die IBAN .* ist ungültig\.$/);
      }
    }
  });
});
