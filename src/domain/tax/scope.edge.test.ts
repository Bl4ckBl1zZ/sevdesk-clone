import { describe, expect, test } from "vitest";
import { AO07_NOTICE, taxScope } from "./scope";

/** 01-compliance AO-07: Bilanz/E-Bilanz is out of scope; the app states it and hands over via journal/DATEV. */

describe("AO-07 Bilanz/E-Bilanz out of scope", () => {
  test("AO-07 every Bilanz company (by legal form or by choice) gets the out-of-scope notice pointing to an external tool or advisor, never an EÜR", () => {
    const bilanz = [
      ...["gmbh", "ug", "ag", "ohg", "kg", "gmbh_co_kg"].map((legalForm) => ({ legalForm })),
      { legalForm: "einzelunternehmen", profitMethod: "bilanz" as const },
    ];
    for (const input of bilanz) {
      const s = taxScope(input);
      expect(s.notice, input.legalForm).toBe(AO07_NOTICE);
      expect(s.euerAvailable, input.legalForm).toBe(false);
      // The VAT filings stay available: only the Jahresabschluss/E-Bilanz is handed over.
      expect(s.vatFilingsAvailable, input.legalForm).toBe(true);
    }
    expect(AO07_NOTICE).toMatch(/Jahresabschluss und E-Bilanz sind nicht Teil dieser Software/);
    expect(AO07_NOTICE).toMatch(/externes Programm oder einen Steuerberater/);
  });

  test("AO-07 EÜR companies see no Bilanz notice", () => {
    expect(taxScope({ legalForm: "freiberufler", profitMethod: "euer" }).notice).toBeNull();
  });
});
