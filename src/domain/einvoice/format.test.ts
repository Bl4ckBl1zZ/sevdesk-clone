import { describe, expect, test } from "vitest";
import { artifactKindFor, decideEinvoiceFormat } from "./format";

const base = {
  docType: "invoice",
  decision: "PDF_NEEDS_CONSENT",
  isPublicAuthority: false,
  isKleinunternehmer: false,
} as const;

describe("decideEinvoiceFormat (F04 §4.6.3)", () => {
  test("T-INV-014 preference pdf with MUST_E → zugferd_en16931 with the notice; with NOT_REQUIRED → none", () => {
    const must = decideEinvoiceFormat({ ...base, decision: "MUST_E", preferredFormat: "pdf" });
    expect(must.format).toBe("zugferd_en16931");
    expect(must.notice).toBe("E-Rechnung ist Pflicht – PDF-Wunsch des Kunden kann nicht erfüllt werden");
    expect(must.allowed).not.toContain("none");
    const free = decideEinvoiceFormat({ ...base, decision: "NOT_REQUIRED", preferredFormat: "pdf" });
    expect(free).toMatchObject({ format: "none" });
    expect(free.notice).toBeUndefined();
  });

  test("INV-17 default is the ZUGFeRD hybrid; none stays allowed only without MUST_E", () => {
    expect(decideEinvoiceFormat(base)).toMatchObject({ format: "zugferd_en16931" });
    expect(decideEinvoiceFormat(base).allowed).toContain("none");
    expect(decideEinvoiceFormat({ ...base, decision: "MUST_E" }).allowed).not.toContain("none");
  });

  test("INV-17 public authorities get XRechnung UBL regardless of the preference", () => {
    const d = decideEinvoiceFormat({ ...base, decision: "MUST_E", isPublicAuthority: true, preferredFormat: "pdf" });
    expect(d.format).toBe("xrechnung_ubl");
    expect(d.allowed).toEqual(["xrechnung_ubl", "xrechnung_cii", "zugferd_xrechnung"]);
  });

  test("INV-17 an XRechnung preference of the contact wins for B2B", () => {
    expect(decideEinvoiceFormat({ ...base, preferredFormat: "xrechnung_cii" }).format).toBe("xrechnung_cii");
    expect(decideEinvoiceFormat({ ...base, preferredFormat: "xrechnung_ubl" }).format).toBe("xrechnung_ubl");
    expect(decideEinvoiceFormat({ ...base, preferredFormat: "zugferd" }).format).toBe("zugferd_en16931");
  });

  test("INV-24 Kleinunternehmer without preference → plain PDF (LEGAL-OPEN 01 item 2), opt-in ZUGFeRD allowed", () => {
    const d = decideEinvoiceFormat({ ...base, decision: "MAY_PAPER_OR_PDF", isKleinunternehmer: true });
    expect(d).toEqual({ format: "none", allowed: ["none", "zugferd_en16931"] });
    expect(decideEinvoiceFormat({ ...base, isKleinunternehmer: true, preferredFormat: "zugferd" }).format).toBe(
      "zugferd_en16931",
    );
  });

  test("INV-17 cancellations and corrections keep the original format; a PDF original under MUST_E becomes ZUGFeRD", () => {
    expect(decideEinvoiceFormat({ ...base, docType: "cancellation", originalFormat: "xrechnung_ubl" })).toEqual({
      format: "xrechnung_ubl",
      allowed: ["xrechnung_ubl"],
    });
    expect(decideEinvoiceFormat({ ...base, docType: "correction", originalFormat: "none" }).format).toBe("none");
    expect(
      decideEinvoiceFormat({ ...base, docType: "correction", decision: "MUST_E", originalFormat: "none" }).format,
    ).toBe("zugferd_en16931");
  });

  test("INV-17 non-invoice types never carry XML", () => {
    for (const docType of ["quote", "order_confirmation", "delivery_note", "proforma", "reminder"] as const) {
      expect(decideEinvoiceFormat({ ...base, docType, decision: "MUST_E" })).toEqual({ format: "none", allowed: [] });
    }
  });

  test("SND-02 artifact kind per format (§4.10.2)", () => {
    expect(artifactKindFor("zugferd_en16931")).toBe("zugferd_pdf");
    expect(artifactKindFor("zugferd_xrechnung")).toBe("zugferd_pdf");
    expect(artifactKindFor("xrechnung_cii")).toBe("xrechnung_xml");
    expect(artifactKindFor("xrechnung_ubl")).toBe("xrechnung_xml");
    expect(artifactKindFor("none")).toBe("pdf");
  });
});
