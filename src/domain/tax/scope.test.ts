import { describe, expect, test } from "vitest";
import { AO07_NOTICE, taxScope } from "./scope";

describe("tax scope by legal form (TAX-014, AO-01, AO-07)", () => {
  test("TAX-014 GmbH, UG, AG, OHG, KG and GmbH & Co. KG get no EÜR and the AO-07 notice; UStVA/ZM stay", () => {
    for (const legalForm of ["gmbh", "ug", "ag", "ohg", "kg", "gmbh_co_kg"]) {
      expect(taxScope({ legalForm }), legalForm).toEqual({
        euerAvailable: false,
        vatFilingsAvailable: true,
        notice: AO07_NOTICE,
      });
    }
    expect(AO07_NOTICE).toBe(
      "Jahresabschluss und E-Bilanz sind nicht Teil dieser Software (AO-07). Dafür benötigen Sie ein externes Programm oder einen Steuerberater.",
    );
  });

  test("TAX-014 sole traders and freelancers keep the EÜR unless they chose the Bilanz", () => {
    expect(taxScope({ legalForm: "einzelunternehmen" })).toMatchObject({ euerAvailable: true, notice: null });
    expect(taxScope({ legalForm: "freiberufler", profitMethod: "euer" })).toMatchObject({ euerAvailable: true });
    expect(taxScope({ legalForm: "ek", profitMethod: "bilanz" })).toMatchObject({
      euerAvailable: false,
      notice: AO07_NOTICE,
    });
  });
});
