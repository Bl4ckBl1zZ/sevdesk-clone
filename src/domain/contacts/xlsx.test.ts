import { strFromU8, unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { rowsToXlsx, sheetXml } from "./xlsx";

describe("CON-144 XLSX export", () => {
  test("CON-144 builds a workbook with one sheet; all cells are text (leading zeros, no formulas), XML-escaped", () => {
    const rows = [
      ["Nr.", "Name", "PLZ", "Notiz"],
      ["01234", "Müller & Söhne <GmbH>", "01067", '=HYPERLINK("x")'],
    ];
    const files = unzipSync(rowsToXlsx(rows));
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"] as Uint8Array);
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">01234</t></is></c>');
    expect(sheet).toContain("Müller &amp; Söhne &lt;GmbH&gt;");
    expect(sheet).toContain("=HYPERLINK(&quot;x&quot;)");
    expect(sheet).not.toContain("<f>");
    expect(strFromU8(files["xl/workbook.xml"] as Uint8Array)).toContain('<sheet name="Kontakte"');
  });

  test("CON-144 columns beyond Z are named AA, AB …; the header row is bold", () => {
    const xml = sheetXml([Array.from({ length: 28 }, (_, i) => `H${i}`)]);
    expect(xml).toContain('<c r="AB1" t="inlineStr" s="1">');
  });
});
