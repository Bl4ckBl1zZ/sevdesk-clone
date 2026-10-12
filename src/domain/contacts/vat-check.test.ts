import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import {
  evatrRequest,
  fingerprint,
  type GateCheck,
  isQualified,
  mapEvatrResponse,
  mapViesResponse,
  NO_OWN_VAT_ID_WARNING,
  needsNightlyRecheck,
  planCheck,
  reusableCheck,
  vatBadge,
  vatCheckGate,
  vatCheckRetentionUntil,
  viesRequest,
} from "./vat-check";

const today = calendarDate("2026-10-12");
const address = {
  name: "Société SA",
  street: "1 Rue de Rivoli",
  postalCode: "75001",
  city: "Paris",
  countryCode: "FR",
};

describe("CON-051 CON-052 provider choice and requests", () => {
  test("T-CON-038 CON-051 foreign ID with own USt-IdNr → eVatR; without → VIES + warning; DE → VIES", () => {
    expect(planCheck("FR12345678901", "DE123456788")).toEqual({ provider: "bzst_evatr" });
    expect(planCheck("FR12345678901", undefined)).toEqual({ provider: "eu_vies", warning: NO_OWN_VAT_ID_WARNING });
    expect(planCheck("DE123456788", "DE987654321")).toEqual({ provider: "eu_vies" });
  });

  test("T-CON-034 CON-051 eVatR body: our DE ID, the foreign ID, name, city, postcode, street", () => {
    expect(evatrRequest("DE123456788", "FR12345678901", "Société SA", address)).toEqual({
      anfragendeUstid: "DE123456788",
      angefragteUstid: "FR12345678901",
      firmenname: "Société SA",
      ort: "Paris",
      plz: "75001",
      strasse: "1 Rue de Rivoli",
    });
    expect(evatrRequest("DE123456788", "FR12345678901", "")).toEqual({
      anfragendeUstid: "DE123456788",
      angefragteUstid: "FR12345678901",
    });
  });

  test("T-CON-035 CON-052 VIES body carries the requester fields (requestIdentifier)", () => {
    expect(viesRequest("DE123456788", "DE987654321", "Müller GmbH")).toEqual({
      countryCode: "DE",
      vatNumber: "123456788",
      requesterMemberStateCode: "DE",
      requesterNumber: "987654321",
      traderName: "Müller GmbH",
    });
    expect(viesRequest("ATU12345678")).toEqual({ countryCode: "AT", vatNumber: "U12345678" });
  });
});

describe("CON-053 CON-054 response mapping", () => {
  test("CON-054 eVatR evatr-0000 + A/A → valid, qualified", () => {
    const o = mapEvatrResponse(200, {
      id: "req-1",
      status: "evatr-0000",
      ergFirmenname: "A",
      ergOrt: "A",
      ergPlz: "C",
      ergStrasse: "A",
    });
    expect(o).toMatchObject({ status: "valid", providerRequestId: "req-1" });
    expect(o.qualified).toEqual({ name: "A", city: "A", postalCode: "C", street: "A" });
    expect(isQualified("bzst_evatr", o.status, o.qualified)).toBe(true);
  });

  test("T-CON-008 CON-E08 name B → valid but not qualified", () => {
    const o = mapEvatrResponse(200, { status: "evatr-0000", ergFirmenname: "B", ergOrt: "A" });
    expect(o.status).toBe("valid");
    expect(isQualified("bzst_evatr", o.status, o.qualified)).toBe(false);
    expect(vatBadge({ status: "valid", qualified: false, checkedAt: 0 }, o.qualified, () => "12.10.2026").text).toBe(
      "⚠ gültig, Name/Ort weicht ab",
    );
    expect(isQualified("bzst_evatr", "valid", { name: "A", city: "A", street: "B", postalCode: "A" })).toBe(false);
    expect(isQualified("eu_vies", "valid", { name: "A", city: "A", street: "A", postalCode: "A" })).toBe(false);
  });

  test("CON-054 eVatR status codes: not assigned → invalid; service down → unavailable; garbage → unavailable", () => {
    expect(mapEvatrResponse(404, { status: "evatr-2001" }).status).toBe("invalid");
    expect(mapEvatrResponse(503, { status: "evatr-0011" }).status).toBe("unavailable");
    expect(mapEvatrResponse(500, "<html>").status).toBe("unavailable");
    expect(mapEvatrResponse(200, { status: "evatr-0000" }).qualified).toBeUndefined();
    expect(mapEvatrResponse(200, { status: "evatr-0000", ergFirmenname: "X" }).qualified?.name).toBe("C");
  });

  test("CON-052 VIES valid/invalid, match codes and requestIdentifier; errors → unavailable or invalid", () => {
    const v = mapViesResponse(200, { valid: true, requestIdentifier: "WAPI123", traderNameMatch: "VALID" });
    expect(v).toMatchObject({ status: "valid", providerRequestId: "WAPI123" });
    expect(v.qualified).toEqual({ name: "A", street: "C", postalCode: "C", city: "C" });
    expect(mapViesResponse(200, { valid: false }).status).toBe("invalid");
    expect(mapViesResponse(200, { valid: true, traderCityMatch: "INVALID" }).qualified?.city).toBe("B");
    expect(
      mapViesResponse(500, { actionSucceed: false, errorWrappers: [{ error: "MS_UNAVAILABLE" }] }).message,
    ).toContain("MS_UNAVAILABLE");
    expect(mapViesResponse(400, { errorWrappers: [{ error: "INVALID_INPUT" }] }).status).toBe("invalid");
    expect(mapViesResponse(200, null).status).toBe("unavailable");
  });

  test("T-CON-036 CON-053 retentionUntil = end of the check year + 10 years", () => {
    expect(vatCheckRetentionUntil(today)).toBe("2036-12-31");
  });
});

describe("CON-055 badges", () => {
  const fmt = () => "12.10.2026";
  test("CON-055 the six badge texts", () => {
    expect(vatBadge(undefined, undefined, fmt).text).toBe("? nicht geprüft");
    expect(vatBadge({ status: "valid", qualified: true, checkedAt: 1 }, undefined, fmt).text).toBe(
      "✓ qualifiziert bestätigt am 12.10.2026",
    );
    expect(vatBadge({ status: "valid", qualified: false, checkedAt: 1 }, undefined, fmt).text).toBe(
      "✓ gültig (einfache Prüfung) am 12.10.2026",
    );
    expect(vatBadge({ status: "invalid", qualified: false, checkedAt: 1 }, undefined, fmt).kind).toBe("invalid");
    expect(vatBadge({ status: "unavailable", qualified: false, checkedAt: 1 }, undefined, fmt).text).toBe(
      "⏳ Dienst nicht erreichbar",
    );
    expect(
      vatBadge(
        { status: "valid", qualified: false, checkedAt: 1 },
        { name: "D", city: "D", street: "D", postalCode: "D" },
        fmt,
      ).text,
    ).toBe("⚠ gültig, Mitgliedstaat liefert keine Daten");
  });
});

describe("CON-058 reuse within 24 hours", () => {
  test("T-CON-037 an identical check within 24 h is reused; force or a different address is not", () => {
    const fp = fingerprint({ vatId: "FR1", name: "A SA", city: "Paris" });
    const now = 1_000_000_000_000;
    const checks = [
      { checkedAt: now - 3_600_000, fingerprint: fp, status: "valid" as const, id: "c1" },
      { checkedAt: now - 2 * 86_400_000, fingerprint: fp, status: "valid" as const, id: "c0" },
    ];
    expect(reusableCheck(checks, fp, now, false)?.id).toBe("c1");
    expect(reusableCheck(checks, fp, now, true)).toBeNull();
    expect(reusableCheck(checks, fingerprint({ vatId: "FR1", name: "A SA", city: "Lyon" }), now, false)).toBeNull();
    expect(
      reusableCheck([{ ...(checks[0] as (typeof checks)[number]), status: "unavailable" as const }], fp, now, false),
    ).toBeNull();
  });
});

describe("CON-056 CON-057 finalisation gate for K/AE (§4.3)", () => {
  const check = (over: Partial<GateCheck> = {}): GateCheck => ({
    id: "chk1",
    vatId: "FR12345678901",
    provider: "bzst_evatr",
    status: "valid",
    qualified: { name: "A", city: "A", street: "A", postalCode: "A" },
    checkedOn: calendarDate("2026-10-01"),
    ...over,
  });
  const gate = (over: Partial<Parameters<typeof vatCheckGate>[0]> = {}) =>
    vatCheckGate({
      taxCase: "intra_community_supply",
      vatId: "FR12345678901",
      isEuPrefixOnSupplyDate: true,
      checks: [check()],
      today,
      ...over,
    });

  test("CON-056 other tax cases need no check; a qualified fresh check passes and is referenced", () => {
    expect(gate({ taxCase: "domestic" }).kind).toBe("ok");
    expect(gate()).toEqual({ kind: "ok", checkId: "chk1" });
  });

  test("T-CON-005 CON-E05 VAT ID missing → blocked „USt-IdNr des Kunden fehlt“; DE ID → not foreign", () => {
    expect(gate({ vatId: undefined })).toMatchObject({ kind: "blocked", message: "USt-IdNr des Kunden fehlt" });
    expect(gate({ vatId: "DE123456788" })).toMatchObject({ kind: "blocked", code: "VAT_ID_NOT_FOREIGN_EU" });
    expect(gate({ isEuPrefixOnSupplyDate: false })).toMatchObject({ kind: "blocked", overridable: false });
  });

  test("T-CON-009 CON-E09 last valid check older than 90 days → recheck, then ok with the new check", () => {
    const old = check({ checkedOn: calendarDate("2026-07-13") });
    expect(gate({ checks: [old] }).kind).toBe("recheck");
    expect(gate({ checks: [check({ id: "chk2" }), old], recheckDone: true })).toEqual({ kind: "ok", checkId: "chk2" });
    expect(gate({ checks: [check({ checkedOn: calendarDate("2026-07-14") })] }).kind).toBe("ok");
  });

  test("T-CON-007 CON-E07 service unavailable → blocked with override", () => {
    expect(gate({ checks: [], recheckDone: true })).toMatchObject({ kind: "blocked", overridable: true });
    expect(gate({ checks: [check({ status: "unavailable" })] })).toMatchObject({
      kind: "blocked",
      code: "VAT_CHECK_UNAVAILABLE",
      overridable: true,
    });
  });

  test("T-CON-006 CON-E06 invalid → blocked without override", () => {
    const r = gate({ checks: [check({ status: "invalid" })] });
    expect(r).toMatchObject({ kind: "blocked", overridable: false });
    expect(r.kind === "blocked" && r.message).toBe(
      "Die USt-IdNr FR12345678901 ist laut BZSt (eVatR) am 01.10.2026 ungültig.",
    );
  });

  test("T-CON-008 CON-E08 K needs name A (override with reason); AE allowed with warning", () => {
    const b = check({ qualified: { name: "B", city: "A", street: "A", postalCode: "A" } });
    expect(gate({ checks: [b] })).toMatchObject({
      kind: "blocked",
      code: "VAT_CHECK_NOT_QUALIFIED",
      overridable: true,
    });
    expect(gate({ taxCase: "eu_b2b_service", checks: [b] }).kind).toBe("ok_with_warning");
    expect(
      gate({ taxCase: "eu_b2b_service", checks: [check({ provider: "eu_vies", qualified: undefined })] }).kind,
    ).toBe("ok");
    expect(gate({ checks: [check({ provider: "eu_vies", qualified: undefined })] }).kind).toBe("blocked");
  });

  test("T-CON-004 CON-E04 checks of an older VAT ID do not count for the new one", () => {
    expect(gate({ vatId: "FR98765432101", checks: [check()] }).kind).toBe("recheck");
  });

  test("CON-059 nightly recheck when the last valid check is older than 90 days", () => {
    expect(needsNightlyRecheck(undefined, today)).toBe(true);
    expect(needsNightlyRecheck(calendarDate("2026-07-13"), today)).toBe(true);
    expect(needsNightlyRecheck(calendarDate("2026-08-01"), today)).toBe(false);
  });
});
