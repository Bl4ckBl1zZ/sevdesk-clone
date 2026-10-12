import { describe, expect, test } from "vitest";
import { BUYER_REFERENCE_PLACEHOLDER, resolveBuyerReference } from "./buyer-reference";

describe("resolveBuyerReference (App. A.3, BT-10)", () => {
  const all = { orderReference: "PO-1", contactNumber: "K-10023" };

  test("INV-22 a real reference always wins: document before contact", () => {
    expect(
      resolveBuyerReference({
        format: "zugferd_en16931",
        isPublicAuthority: false,
        sources: { document: " D-1 ", contact: "C-1" },
      }),
    ).toEqual({
      value: "D-1",
      source: "document",
    });
    expect(
      resolveBuyerReference({
        format: "xrechnung_ubl",
        isPublicAuthority: true,
        sources: { contact: "04011000-1234512345-06" },
      }),
    ).toEqual({
      value: "04011000-1234512345-06",
      source: "contact",
    });
  });

  test('EC-093 XRechnung B2B without a reference: order reference → customer number → "nicht angegeben"', () => {
    for (const format of ["xrechnung_ubl", "xrechnung_cii", "zugferd_xrechnung"] as const) {
      expect(resolveBuyerReference({ format, isPublicAuthority: false, sources: all })).toEqual({
        value: "PO-1",
        source: "order_reference",
      });
      expect(
        resolveBuyerReference({ format, isPublicAuthority: false, sources: { contactNumber: "K-10023" } }),
      ).toEqual({
        value: "K-10023",
        source: "contact_number",
      });
      expect(resolveBuyerReference({ format, isPublicAuthority: false, sources: { document: "  " } })).toEqual({
        value: BUYER_REFERENCE_PLACEHOLDER,
        source: "placeholder",
      });
    }
  });

  test("EC-DOC-77 ZUGFeRD EN 16931, no XML and B2G never invent a reference (B2G is blocked by leitweg_id_missing)", () => {
    for (const [format, isPublicAuthority] of [
      ["zugferd_en16931", false],
      ["none", false],
      ["xrechnung_ubl", true],
    ] as const) {
      expect(resolveBuyerReference({ format, isPublicAuthority, sources: all })).toEqual({
        value: undefined,
        source: "none",
      });
    }
  });
});
