import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decodeXml, parseKositReport, parseMustangReport } from "../src/reports.ts";

// Real reports captured from KoSIT validator 1.6.3 (config 2026-08-31) and Mustang CLI 2.26.0 (see fixtures/NOTICE.md).
const report = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/reports", name), "utf8");

test("all captured validator reports are present (committed fixtures, no Java needed)", () => {
  const expected = [
    "kosit-422.xml",
    "kosit-accept.xml",
    "kosit-no-scenario.xml",
    "kosit-reject.xml",
    "mustang-hybrid-valid.xml",
    "mustang-pdf-without-xml.xml",
    "mustang-xml-invalid.xml",
  ];
  const present = readdirSync(join(import.meta.dirname, "fixtures/reports")).sort();
  expect(
    expected.filter((f) => !present.includes(f)),
    "missing fixture reports — check .gitignore",
  ).toEqual([]);
});

describe("KoSIT report", () => {
  test("ER-12 an accepted XRechnung has no errors and names the matched scenario", () => {
    const r = parseKositReport(report("kosit-accept.xml"));
    expect(r.accepted).toBe(true);
    expect(r.valid).toBe(true);
    expect(r.scenario).toBe("EN16931 XRechnung (UBL Invoice)");
    expect(r.errors).toEqual([]);
    expect(r.infos.map((m) => m.code)).toEqual(["BR-DE-TMP-32"]);
  });

  test("ER-12 a rejected XRechnung lists the violated business rules as errors", () => {
    const r = parseKositReport(report("kosit-reject.xml"));
    expect(r.accepted).toBe(false);
    expect(r.valid).toBe(false);
    expect(r.errors.map((m) => m.code).sort()).toEqual(["BR-CO-16", "BR-DE-15"]);
    const de15 = r.errors.find((m) => m.code === "BR-DE-15");
    expect(de15?.level).toBe("error");
    expect(de15?.text).toContain("BR-DE-15");
    expect(de15?.location).toMatch(/^\/Q\{urn:oasis:names:specification:ubl:schema:xsd:Invoice-2\}Invoice/);
  });

  test("ER-12 a document without a matching scenario is not acceptable", () => {
    const r = parseKositReport(report("kosit-no-scenario.xml"));
    expect(r.accepted).toBe(false);
    expect(r.scenario).toBeNull();
  });

  test("ER-12 a processing error (not well-formed) surfaces the parser message", () => {
    const r = parseKositReport(report("kosit-422.xml"));
    expect(r.accepted).toBe(false);
    expect(r.errors[0]?.code).toBe("generic-error");
    expect(r.errors[0]?.text).toContain("SXXP0003");
  });
});

describe("Mustang report", () => {
  test("ER-12 a valid hybrid ZUGFeRD/XRechnung PDF is valid in the PDF and XML sections", () => {
    const r = parseMustangReport(report("mustang-hybrid-valid.xml"));
    expect(r.valid).toBe(true);
    expect(r.pdf).toEqual({ present: true, valid: true, pdfaCompliant: true, flavour: "3u" });
    expect(r.xml.valid).toBe(true);
    expect(r.xml.profile).toBe("urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0");
    expect(r.errors).toEqual([]);
    expect(r.notices.map((m) => m.code)).toEqual(["BR-DE-TMP-32"]);
  });

  test("ER-12 a PDF without embedded XML is invalid although PDF/A-compliant", () => {
    const r = parseMustangReport(report("mustang-pdf-without-xml.xml"));
    expect(r.valid).toBe(false);
    expect(r.pdf.pdfaCompliant).toBe(true);
    expect(r.pdf.valid).toBe(false);
    expect(r.xml.present).toBe(false);
    expect(r.errors.some((m) => m.code === "mustang-17" && m.text === "XML could not be extracted")).toBe(true);
  });

  test("ER-12 invalid XML reports rule IDs extracted from the message text", () => {
    const r = parseMustangReport(report("mustang-xml-invalid.xml"));
    expect(r.valid).toBe(false);
    expect(r.xml.valid).toBe(false);
    expect(r.errors.map((m) => m.code)).toEqual(expect.arrayContaining(["BR-CO-16", "BR-DE-15"]));
  });

  test("throws on output that is not a validation report", () => {
    expect(() => parseMustangReport("Exception in thread main")).toThrow(/not a Mustang validation report/);
  });
});

test("decodeXml decodes predefined and numeric entities", () => {
  expect(decodeXml("&lt;a&gt; &amp; &quot;x&quot; &apos;y&apos; &#228;&#xFC;")).toBe(`<a> & "x" 'y' äü`);
});
