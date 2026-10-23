/** 10-edge-cases §3.3 EC-045: VAT-ID check valid, qualified name/city check B (mismatch). */
import { BUYERS, goodLine, makeContact, makeContext, makeDraft } from "@test/factories/documents";
import { describe, expect, test } from "vitest";
import { validateDocument } from "../documents/validate";
import { calendarDate } from "../time/calendar-date";
import { type GateCheck, vatBadge, vatCheckGate } from "./vat-check";

const TODAY = calendarDate("2026-10-12");
const mismatch: GateCheck = {
  id: "chk-1",
  vatId: "ATU12345675",
  provider: "bzst_evatr",
  status: "valid",
  qualified: { name: "B", street: "A", postalCode: "A", city: "A" },
  checkedOn: TODAY,
};
const gate = (taxCase: "eu_b2b_service" | "intra_community_supply", check: GateCheck = mismatch) =>
  vatCheckGate({ taxCase, vatId: check.vatId, isEuPrefixOnSupplyDate: true, checks: [check], today: TODAY });

describe("VAT-ID check mismatch (MISC-04)", () => {
  test("EC-045 valid VAT ID but name/city B: a warning for AE, an override with reason required for K", () => {
    // EU B2B service (AE): finalisation continues with the warning
    expect(gate("eu_b2b_service")).toEqual({
      kind: "ok_with_warning",
      checkId: "chk-1",
      warning: "Die USt-IdNr ist gültig, Name oder Ort weichen bei der qualifizierten Prüfung ab.",
    });
    // intra-Community supply (K): good-faith protection needs name „A“ → blocked, released only with a reason
    expect(gate("intra_community_supply")).toMatchObject({
      kind: "blocked",
      code: "VAT_CHECK_NOT_QUALIFIED",
      overridable: true,
    });
    // a city mismatch is a warning for AE as well
    const city = { ...mismatch, qualified: { name: "A", street: "A", postalCode: "A", city: "B" } } as GateCheck;
    expect(gate("eu_b2b_service", city).kind).toBe("ok_with_warning");
    // the contact badge shows the mismatch
    expect(
      vatBadge({ status: "valid", qualified: false, checkedAt: 0 }, mismatch.qualified, () => "12.10.2026"),
    ).toEqual({ kind: "mismatch", text: "⚠ gültig, Name/Ort weicht ab" });
    // fully qualified (A/A) passes without warning for both
    const qualified = { ...mismatch, qualified: { name: "A", street: "A", postalCode: "A", city: "A" } } as GateCheck;
    expect(gate("eu_b2b_service", qualified)).toEqual({ kind: "ok", checkId: "chk-1" });
    expect(gate("intra_community_supply", qualified)).toEqual({ kind: "ok", checkId: "chk-1" });
  });

  test("EC-045 on the document: the K mismatch blocks with buyer_vat_id_qualified_mismatch until released with a reason; AE only warns", () => {
    const contact = makeContact({
      buyer: BUYERS.at,
      countryCode: "AT",
      vatId: mismatch.vatId,
      vatIdStatus: { status: "valid", qualified: false },
      vatChecks: [mismatch],
    });
    const delivery = { name: BUYERS.at.name, ...BUYERS.at.address };
    const igl = makeDraft({ lines: [goodLine()], deliveryAddress: delivery });
    const v = validateDocument(igl, makeContext({ contact }));
    expect(v.resolved.taxCase).toBe("intra_community_supply");
    const f = v.findings.find((x) => x.code === "buyer_vat_id_qualified_mismatch");
    expect(f).toMatchObject({ severity: "E", overridable: true });
    expect(f?.message).toContain("Freigabe nur mit Begründung");
    const released = validateDocument(igl, makeContext({ contact }), { vatCheckOverride: true });
    expect(released.findings.some((x) => x.code === "buyer_vat_id_qualified_mismatch")).toBe(false);
    expect(released.overriddenVatCheck).toEqual({ vatId: mismatch.vatId, qualifiedRequired: true });
    // EU B2B service: warning only
    const service = validateDocument(makeDraft(), makeContext({ contact }));
    expect(service.resolved.taxCase).toBe("eu_b2b_service");
    expect(service.findings.filter((x) => x.severity === "E").map((x) => x.code)).not.toContain(
      "buyer_vat_id_qualified_mismatch",
    );
    expect(service.findings.find((x) => x.message.includes("Name oder Ort weichen"))?.severity).toBe("W");
  });
});
