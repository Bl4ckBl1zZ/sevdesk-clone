import { describe, expect, test } from "vitest";
import {
  planShareholderAccounts,
  SHAREHOLDER_MESSAGES,
  shareholderAccountName,
  shareholderClearingApplies,
} from "./shareholder-clearing";

describe("shareholder clearing account (F01 SET-045a, F08 ACC-028)", () => {
  test("SET-045a only corporations (GmbH, UG, AG, GmbH & Co. KG) get a Verrechnungskonto Gesellschafter", () => {
    for (const lf of ["gmbh", "ug", "ag", "gmbh_co_kg"] as const) expect(shareholderClearingApplies(lf)).toBe(true);
    for (const lf of ["einzelunternehmen", "freiberufler", "gbr", "ohg", "kg", "ek"] as const) {
      expect(shareholderClearingApplies(lf)).toBe(false);
    }
  });

  test("SET-045a the account name is „Verrechnungskonto Gesellschafter {Name}“, shortened to 40 characters (DATEV)", () => {
    expect(shareholderAccountName("Max Muster")).toBe("Verrechnungskonto Gesellschafter Muster");
    expect(shareholderAccountName("Li")).toBe("Verrechnungskonto Gesellschafter Li");
    const long = shareholderAccountName("Maximiliane von und zu Habsburg-Lothringen");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.startsWith("Verr.-Kto. Ges. ")).toBe(true);
  });

  test("SET-045a proposes one liability account per shareholder in the chart's range, skipping taken numbers", () => {
    const r = planShareholderAccounts({
      legalForm: "gmbh",
      chart: "SKR03",
      shareholders: [{ name: "Max Muster" }, { name: "Erika Beispiel" }],
      taken: new Set(["0755"]),
    });
    expect(r.ok && r.value).toEqual([
      { shareholder: "Max Muster", number: "0756", name: "Verrechnungskonto Gesellschafter Muster" },
      { shareholder: "Erika Beispiel", number: "0757", name: "Verr.-Kto. Ges. Erika Beispiel" },
    ]);
    const skr04 = planShareholderAccounts({
      legalForm: "ug",
      chart: "SKR04",
      shareholders: [{ name: "Max Muster", number: "3519" }],
      taken: new Set(),
    });
    expect(skr04.ok && skr04.value[0]?.number).toBe("3519");
  });

  test("SET-045a a sole proprietor has no shareholder step — the plan is refused; empty or out-of-range input too", () => {
    const sole = planShareholderAccounts({
      legalForm: "einzelunternehmen",
      chart: "SKR03",
      shareholders: [{ name: "Max Muster" }],
      taken: new Set(),
    });
    expect(!sole.ok && sole.error).toMatchObject({
      code: "not_corporation",
      message: SHAREHOLDER_MESSAGES.notCorporation,
    });
    const none = planShareholderAccounts({ legalForm: "gmbh", chart: "SKR03", shareholders: [], taken: new Set() });
    expect(!none.ok && none.error.code).toBe("shareholders_missing");
    const range = planShareholderAccounts({
      legalForm: "gmbh",
      chart: "SKR03",
      shareholders: [{ name: "Max Muster", number: "4100" }],
      taken: new Set(),
    });
    expect(!range.ok && range.error.code).toBe("E-ACC-07");
  });
});
