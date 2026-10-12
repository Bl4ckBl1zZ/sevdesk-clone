import { describe, expect, test } from "vitest";
import { taxDefaults } from "../src/domain/schemas/settings";
import { api } from "./_generated/api";
import { getCompanyProfile } from "./model/companyProfile";
import { makeT } from "./test.setup";

const TAX = {
  ...taxDefaults("gmbh"),
  taxNumberState: "BE",
  taxNumber: "27/815/08155",
  priorYearTurnover: "120.000,00",
};
const issuesOf = (e: unknown) => (e as { data?: { issues?: { path: string }[] } }).data?.issues?.map((i) => i.path);

describe("SET-044 DATEV keys in the tax settings", () => {
  test("SET-044 DATEV-01 consultant/client number and account length are stored; out-of-range values are refused", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveTaxSettings, {
      values: { ...TAX, datevConsultantNumber: "1234567", datevClientNumber: "99999", datevAccountLength: 5 },
    });
    const profile = await t.run((ctx) => getCompanyProfile(ctx));
    expect(profile?.datev).toMatchObject({ consultantNumber: 1_234_567, clientNumber: 99_999, accountLength: 5 });
    const err = await owner
      .mutation(api.settings.saveTaxSettings, { values: { ...TAX, datevClientNumber: "100000" } })
      .catch((e: unknown) => e);
    expect(issuesOf(err)).toEqual(["datevClientNumber"]);
    const entry = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    expect(entry).toMatchObject({ action: "settings.tax.update" });
  });
});
