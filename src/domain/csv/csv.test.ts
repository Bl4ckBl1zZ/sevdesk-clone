import { describe, expect, test } from "vitest";
import { decodeCsv, detectEncoding, detectSeparator, importRowKey, parseCsv, readCsv, writeCsv } from "./csv";

const latin1 = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe("CON-140 PRD-080 CSV reading", () => {
  test("T-CON-053 CON-140 encodings: UTF-8 with/without BOM, Windows-1252 (umlauts, „“), ISO-8859-15 (€)", () => {
    const utf8 = new TextEncoder().encode("Name;Ort\nMüller;Köln\n");
    expect(detectEncoding(utf8)).toEqual({ ok: true, value: "utf-8" });
    expect(decodeCsv(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])).ok && decodeCsv(utf8)).toMatchObject({
      ok: true,
      value: { text: "Name;Ort\nMüller;Köln\n" },
    });
    const bomText = decodeCsv(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]));
    expect(bomText.ok && bomText.value.text.startsWith("Name")).toBe(true);
    // Windows-1252: ü = 0xFC, „ = 0x84
    const cp1252 = new Uint8Array([...latin1("M"), 0xfc, ...latin1("ller "), 0x84, ...latin1("GmbH")]);
    const d1 = decodeCsv(cp1252);
    expect(d1.ok && d1.value).toEqual({ text: "Müller „GmbH", encoding: "windows-1252" });
    // ISO-8859-15: € = 0xA4, no 0x80–0x9F bytes
    const iso = new Uint8Array([...latin1("Preis "), 0xa4, ...latin1(" K"), 0xf6, ...latin1("ln")]);
    const d2 = decodeCsv(iso);
    expect(d2.ok && d2.value).toEqual({ text: "Preis € Köln", encoding: "iso-8859-15" });
  });

  test("§5.7 undetectable encodings (UTF-16, NUL bytes) → IMPORT_ENCODING", () => {
    const r = detectEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0x00]));
    expect(!r.ok && r.error.message).toBe(
      "Die Zeichenkodierung konnte nicht erkannt werden. Bitte als UTF-8 speichern.",
    );
    expect(detectEncoding(new Uint8Array([0x41, 0x00, 0x42])).ok).toBe(false);
  });

  test("CON-140 separator detection (; , tab), ignoring separators inside quotes", () => {
    expect(detectSeparator("a;b;c\n1,2;3")).toBe(";");
    expect(detectSeparator('"x;y",b,c\n')).toBe(",");
    expect(detectSeparator("a\tb\tc")).toBe("\t");
    expect(detectSeparator("single")).toBe(";");
  });

  test("CON-140 RFC 4180 parsing: quotes, doubled quotes, CRLF, newlines in quotes, empty lines", () => {
    expect(parseCsv('a;"b;c";"say ""hi"""\r\n1;"multi\nline";3\n\n', ";")).toEqual([
      ["a", "b;c", 'say "hi"'],
      ["1", "multi\nline", "3"],
    ]);
    expect(parseCsv("a,b\n1,2", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("§5.7 limits: > 10 MB or > 20,000 rows → IMPORT_TOO_LARGE; header-only works", () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1).fill(0x41);
    const r1 = readCsv(big);
    expect(!r1.ok && r1.error.code).toBe("IMPORT_TOO_LARGE");
    const rows = `h\n${"x\n".repeat(20_001)}`;
    const r2 = readCsv(new TextEncoder().encode(rows));
    expect(!r2.ok && r2.error.message).toBe("Die Datei ist zu groß (max. 10 MB bzw. 20.000 Zeilen).");
    const r3 = readCsv(new TextEncoder().encode(" Firma ; PLZ \n"));
    expect(r3.ok && r3.value).toMatchObject({ headers: ["Firma", "PLZ"], rows: [], separator: ";" });
    const r4 = readCsv(new Uint8Array());
    expect(!r4.ok && r4.error.code).toBe("IMPORT_EMPTY");
  });
});

describe("CON-143 PRD-085 CSV writing", () => {
  test("T-CON-055 CON-143 export as UTF-8 with BOM, ';', quoting and formula guard", () => {
    const csv = writeCsv(
      ["Name", "Notiz", "Betrag"],
      [
        ["Müller; GmbH", '=HYPERLINK("x")', -12.5],
        ["A", null, undefined],
      ],
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('Name;Notiz;Betrag\r\n"Müller; GmbH";"\'=HYPERLINK(""x"")";-12.5\r\nA;;\r\n');
    expect(importRowKey("abc", 7)).toBe("abc:7");
  });
});
