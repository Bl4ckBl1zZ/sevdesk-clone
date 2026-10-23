import { describe, expect, test } from "vitest";
import { SELLERS } from "../../../test/factories/snapshot";
import { checkGeschaeftsbriefFooter } from "./invariants";

describe("RI-26 Geschäftsbrief footer in the snapshot", () => {
  test("RI-26 a complete GmbH and e.K. seller block passes; unregistered forms are not checked", () => {
    expect(checkGeschaeftsbriefFooter("RE-1", SELLERS.gmbh)).toEqual([]);
    expect(checkGeschaeftsbriefFooter("RE-2", SELLERS.ek)).toEqual([]);
    expect(checkGeschaeftsbriefFooter("RE-3", SELLERS.ku)).toEqual([]);
  });

  test("RI-26 a GmbH document without register, managing director or Rechtsformzusatz is an ERROR", () => {
    const f = checkGeschaeftsbriefFooter("RE-4", {
      ...SELLERS.gmbh,
      name: "Muster Design",
      register: { court: "", type: "HRB", number: "" },
      representatives: [],
    });
    expect(f).toEqual([
      {
        id: "RI-26",
        severity: "ERROR",
        message: expect.stringContaining("Rechtsformzusatz, Registergericht und -nummer, Vertretungsberechtigte"),
      },
    ]);
  });

  test("RI-26 OHG/KG/e.K. need the register; a GmbH & Co. KG also its general partner", () => {
    for (const legalForm of ["ohg", "kg", "ek"] as const) {
      const name = { ohg: "Bauer OHG", kg: "Bauer KG", ek: "Bauer e.K." }[legalForm];
      const f = checkGeschaeftsbriefFooter("RE-5", { ...SELLERS.ek, legalForm, name, register: undefined });
      expect(f[0]?.message).toContain("Registergericht");
    }
    const f = checkGeschaeftsbriefFooter("RE-6", {
      ...SELLERS.ek,
      legalForm: "gmbh_co_kg",
      name: "Bauer GmbH & Co. KG",
    });
    expect(f[0]?.message).toContain("persönlich haftende Gesellschafterin");
  });
});
