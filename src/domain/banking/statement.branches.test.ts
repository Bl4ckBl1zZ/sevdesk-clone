import { describe, expect, test } from "vitest";
import { bankFixture, SYNTH } from "../../../test/fixtures/bank/load";
import { decodeStatement, detectStatementFormat, parseStatement } from "./statement";

const bytes = (...b: number[]) => new Uint8Array(b);
const decoded = (b: Uint8Array) => {
  const r = decodeStatement(b);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("statement file decoding (BNK-033: UTF-8 / Windows-1252 auto-detect)", () => {
  test("BNK-033 UTF-16 files (both byte orders) are refused with a hint to save as UTF-8", () => {
    for (const bom of [bytes(0xff, 0xfe, 0x3a, 0x00), bytes(0xfe, 0xff, 0x00, 0x3a)]) {
      const r = decodeStatement(bom);
      expect(r.ok ? null : r.error.message).toContain("UTF-16 wird nicht unterstützt, bitte als UTF-8 speichern");
    }
  });

  test("BNK-033 valid UTF-8 (2-, 3- and 4-byte sequences) is decoded and a BOM is dropped", () => {
    const text = "Müller € 𝄞";
    const utf8 = new TextEncoder().encode(text);
    expect(decoded(utf8)).toBe(text);
    expect(decoded(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))).toBe(text);
    expect(decoded(bytes())).toBe("");
  });

  test("BNK-033 bytes that are not UTF-8 are read as Windows-1252 (German bank exports)", () => {
    // „Müller“ in Latin-1, „€“ (0x80) and „„“ (0x84) from the Windows-1252 range.
    expect(decoded(bytes(0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72))).toBe("Müller");
    expect(decoded(bytes(0x80, 0x20, 0x84, 0x41, 0x93))).toBe("€ „A“");
    // Overlong 2-byte lead (0xC0/0xC1), an invalid lead byte and a truncated sequence are no UTF-8.
    expect(decoded(bytes(0xc1, 0x81))).toBe("Á\u0081");
    expect(decoded(bytes(0xf8, 0x41))).toBe("øA");
    expect(decoded(bytes(0x41, 0xe2, 0x82))).toBe("Aâ‚");
  });
});

describe("statement format detection (MISC-02, BNK-032/033)", () => {
  test("BNK-033 an XML declaration or a .xml name means CAMT.053; :20: with :25: means MT940", () => {
    expect(detectStatementFormat('<?xml version="1.0"?><Document/>')).toBe("camt053");
    expect(detectStatementFormat("<Document/>", "auszug.XML")).toBe("camt053");
    expect(detectStatementFormat("{1:F01}{2:O940}{4:\n:20:X\n:25:DE89\n")).toBe("mt940");
    expect(detectStatementFormat(":20:X\n")).toBeNull();
  });

  test("BNK-032 a Revolut CSV is recognised by its header or the .csv name; the currency option reaches the parser", () => {
    const csv = bankFixture(`${SYNTH}/eur-2026-10.csv`);
    expect(detectStatementFormat(csv)).toBe("revolut_csv");
    expect(detectStatementFormat("a;b\n1;2", "export.csv")).toBe("revolut_csv");
    const r = parseStatement(csv, { format: "revolut_csv", currency: "EUR" });
    expect(r.ok && r.value.format).toBe("revolut_csv");
    expect(r.ok && r.value.transactions.every((t) => t.currency === "EUR")).toBe(true);
  });
});
