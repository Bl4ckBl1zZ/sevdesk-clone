import { describe, expect, test } from "vitest";
import { taxDefaults, taxSchema } from "../schemas/settings";
import { calendarDate } from "../time/calendar-date";
import { CREDITOR_ID_INVALID_MESSAGE, normalizeCreditorId, validateCreditorId } from "./creditor-id";
import { newCompanyProfile, type ProfileData, taxFormFromProfile, taxPatchFromForm } from "./profile";

describe("SET-045 SEPA creditor ID (Gläubiger-ID)", () => {
  test("SET-045 accepts the Bundesbank sample ID; the business code does not enter the check digits", () => {
    expect(validateCreditorId("DE98ZZZ09999999999")).toEqual({ ok: true, value: "DE98ZZZ09999999999" });
    expect(validateCreditorId("DE98ABC09999999999").ok).toBe(true);
  });

  test("SET-045 normalises spaces and lower case before checking", () => {
    expect(normalizeCreditorId(" de98 zzz 0999 9999 999 ")).toBe("DE98ZZZ09999999999");
    expect(validateCreditorId("de98 zzz 09999999999")).toEqual({ ok: true, value: "DE98ZZZ09999999999" });
  });

  test("SET-045 rejects a wrong check digit with CREDITOR_ID_INVALID", () => {
    expect(validateCreditorId("DE97ZZZ09999999999")).toEqual({
      ok: false,
      error: { code: "CREDITOR_ID_INVALID", message: "Die Gläubiger-Identifikationsnummer ist ungültig." },
    });
    expect(validateCreditorId("DE98ZZZ09999999998").ok).toBe(false);
    expect(CREDITOR_ID_INVALID_MESSAGE).toBe("Die Gläubiger-Identifikationsnummer ist ungültig.");
  });

  test("SET-045 rejects a malformed ID (length, country, letters in the national part)", () => {
    for (const bad of [
      "DE98ZZZ0999999999",
      "DE98ZZZ099999999990",
      "AT98ZZZ09999999999",
      "DE98ZZZ0999999999X",
      "DE9XZZZ09999999999",
      "",
    ]) {
      expect(validateCreditorId(bad).ok, bad).toBe(false);
    }
  });
});

describe("SET-045 creditorId in the tax settings form", () => {
  const base = { ...taxDefaults("gmbh"), taxNumberState: "BY", taxNumber: "181/815/08155" };
  const today = calendarDate("2026-10-12");

  test("SET-045 the form rejects an invalid Gläubiger-ID on the field with the F01 §5 message", () => {
    const r = taxSchema.safeParse({ ...base, creditorId: "DE97ZZZ09999999999" });
    expect(r.success).toBe(false);
    expect(r.error?.issues).toEqual([
      expect.objectContaining({ path: ["creditorId"], message: "Die Gläubiger-Identifikationsnummer ist ungültig." }),
    ]);
    expect(taxSchema.safeParse({ ...base, creditorId: "" }).success).toBe(true);
  });

  test("SET-045 a valid ID is stored normalised on the profile and read back into the form", () => {
    const form = taxSchema.parse({ ...base, creditorId: "de98 zzz 09999999999" });
    const r = taxPatchFromForm(form, newCompanyProfile() as unknown as ProfileData, { today, now: 1 });
    expect(r.ok && r.patch.creditorId).toBe("DE98ZZZ09999999999");
    if (!r.ok) return;
    const back = taxFormFromProfile(
      { ...(newCompanyProfile() as unknown as ProfileData), ...r.patch, legalForm: "gmbh" },
      today,
    );
    expect(back?.creditorId).toBe("DE98ZZZ09999999999");
  });
});
