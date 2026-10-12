import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { FONT_FILES } from "../../scripts/generate-pdf-fonts";
import { qrMatrix, qrPath } from "./epc-qr";
import { fontStack, registerPdfFonts } from "./fonts";
import { FONT_DATA } from "./fonts/data.generated";

describe("embedded PDF fonts (PDF/A-3b)", () => {
  test("DOC-58 the bundled fonts match the pinned sha256 (Inter, Noto Sans fallback, Source Serif 4)", () => {
    expect(Object.keys(FONT_DATA).sort()).toEqual(Object.keys(FONT_FILES).sort());
    for (const [name, entry] of Object.entries(FONT_DATA)) {
      const actual = createHash("sha256").update(Buffer.from(entry.base64, "base64")).digest("hex");
      expect(actual, name).toBe(FONT_FILES[name as keyof typeof FONT_FILES]);
      expect(entry.sha256).toBe(actual);
    }
  });

  test("DOC-58 font stacks per layout font always end in a fallback; registration is idempotent", () => {
    expect(fontStack("inter")).toEqual(["Inter", "NotoSans"]);
    expect(fontStack("noto")).toEqual(["NotoSans", "Inter"]);
    expect(fontStack("source-serif")).toEqual(["SourceSerif", "NotoSans"]);
    registerPdfFonts();
    expect(() => registerPdfFonts()).not.toThrow();
  });
});

describe("EPC QR rendering", () => {
  test("DOC-51 the QR is drawn as vector modules with a 4-module quiet zone (ECC level M)", () => {
    const payload = [
      "BCD",
      "002",
      "1",
      "SCT",
      "COBADEFFXXX",
      "Muster Design GmbH",
      "DE89370400440532013000",
      "EUR1190.00",
      "",
      "",
      "RE-2026-0042",
    ].join("\n");
    const m = qrMatrix(payload);
    expect(m.length).toBeGreaterThanOrEqual(25);
    expect(m.every((row) => row.length === m.length)).toBe(true);
    // finder pattern in the top-left corner
    expect(m[0]?.slice(0, 7)).toEqual([true, true, true, true, true, true, true]);
    const path = qrPath(m);
    const dark = m.flat().filter(Boolean).length;
    expect(path.match(/M/g)?.length).toBe(dark);
    expect(path.startsWith("M4 4h1v1h-1z")).toBe(true);
  });
});
