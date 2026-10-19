import { makeSnapshot } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import { serializeEinvoice } from "./serialize";
import { enabledTransmissionChannels, TRANSMISSION_CHANNELS, transmissionPlan } from "./transmission";

describe("ER-30 format-agnostic model and pluggable transmission", () => {
  test("ER-30 one EN 16931 model serialises to every syntax; only profile and customization differ", () => {
    const snapshot = makeSnapshot();
    const out = (["zugferd_en16931", "zugferd_xrechnung", "xrechnung_cii", "xrechnung_ubl"] as const).map((f) =>
      serializeEinvoice(snapshot, f),
    );
    const [zugferd, ...xrechnung] = out.map((o) => o.model);
    // The three XRechnung variants (CII, UBL, hybrid) carry the identical model.
    for (const m of xrechnung) expect(m).toEqual(xrechnung[0]);
    // EN 16931 vs XRechnung differ only in the profile fields (BT-24, BT-23, default BT-10).
    const core = (m: typeof zugferd) => {
      const {
        profile: _p,
        customizationId: _c,
        businessProcessId: _b,
        buyerReference: _r,
        ...rest
      } = m as typeof m & {
        businessProcessId?: string;
        buyerReference?: string;
      };
      return rest;
    };
    expect(core(zugferd)).toEqual(core(xrechnung[0] as typeof zugferd));
    expect(out.map((o) => o.syntax)).toEqual(["CII", "CII", "CII", "UBL"]);
  });

  test("ER-30 v1 transmits manually (export + sent mark); Peppol is reserved and disabled", () => {
    expect(enabledTransmissionChannels().map((c) => c.id)).toEqual(["manual"]);
    expect(transmissionPlan("manual", "xrechnung_ubl")).toEqual({
      kind: "manual_export",
      files: [{ kind: "xrechnung_xml", variant: "original" }],
      markRequired: true,
    });
    expect(transmissionPlan("manual", "zugferd_en16931")).toMatchObject({
      files: [{ kind: "zugferd_pdf", variant: "original" }],
    });
    expect(TRANSMISSION_CHANNELS.peppol.enabled).toBe(false);
    expect(transmissionPlan("peppol", "xrechnung_ubl")).toEqual({
      kind: "unavailable",
      reason: "Peppol ist noch nicht angebunden (geplant für P4).",
    });
  });
});
