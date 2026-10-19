/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { explanationText } from "../../src/domain/accounting/post";
import cii from "./cases/intra-community-supply-fr/expected.cii.xml?raw";
import pdfText from "./cases/intra-community-supply-fr/expected.pdf.txt?raw";
import ubl from "./cases/intra-community-supply-fr/expected.ubl.xml?raw";

/**
 * 01 UST-21 (G, V): the intra-Community supply case T-GLD-12 carries the §4 Nr. 1b / §6a text, both VAT IDs and
 * VATEX-EU-IC; the posting reports it under Kz 41 and in the ZM („L“). The proof warning is INV-30.
 */
describe("intra-Community supply (UST-21)", () => {
  test("UST-21 PDF: exemption text with § 4 Nr. 1 Buchst. b / § 6a UStG and both USt-IdNrs", () => {
    expect(pdfText).toContain("Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1 Buchst. b, § 6a UStG)");
    expect(pdfText).toContain("USt-IdNr. Lieferer: DE123456788");
    expect(pdfText).toContain("USt-IdNr. Abnehmer: FR40303265045");
  });

  test("UST-21 XML: category K with VATEX-EU-IC, seller and buyer VAT IDs in UBL and CII", () => {
    expect(ubl).toContain("<cbc:TaxExemptionReasonCode>VATEX-EU-IC</cbc:TaxExemptionReasonCode>");
    expect(ubl).toContain("<cbc:CompanyID>DE123456788</cbc:CompanyID>");
    expect(ubl).toContain("<cbc:CompanyID>FR40303265045</cbc:CompanyID>");
    expect(cii).toContain("VATEX-EU-IC");
    expect(cii).toMatch(/<ram:CategoryCode>K<\/ram:CategoryCode>/);
    expect(cii).toContain("FR40303265045");
  });

  test("UST-21 the posting explanation names Kz 41 and the ZM („L“)", () => {
    expect(explanationText("S5")).toContain("Kz 41");
    expect(explanationText("S5")).toContain("ZM „L“");
  });
});
