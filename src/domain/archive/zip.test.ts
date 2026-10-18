import { craftZip } from "@test/factories/zip";
import { zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { crc32, extractZipEntry, readZipDirectory } from "./zip";

const enc = new TextEncoder();
const dec = new TextDecoder();

function entries(zip: Uint8Array) {
  const r = readZipDirectory(zip);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("IMP-016 ZIP reader (central directory, bounded inflate)", () => {
  test("IMP-016 crc32 matches the reference value", () => {
    expect(crc32(enc.encode("hello"))).toBe(0x3610a686);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  test("IMP-016 reads deflated and stored entries written by a standard zip tool", () => {
    const zip = zipSync({
      "a.csv": [enc.encode("Kunden-Nr.;Name\n1;Ä GmbH\n".repeat(50)), { level: 9 }],
      "belege/RE-1.pdf": [enc.encode("%PDF-1.4 x"), { level: 0 }],
    });
    const list = entries(zip);
    expect(list.map((e) => [e.path, e.method, e.isDirectory])).toEqual([
      ["a.csv", 8, false],
      ["belege/RE-1.pdf", 0, false],
    ]);
    const a = extractZipEntry(zip, list[0] as (typeof list)[number]);
    expect(a.ok && dec.decode(a.value).startsWith("Kunden-Nr.;Name\n1;Ä GmbH")).toBe(true);
    const b = extractZipEntry(zip, list[1] as (typeof list)[number]);
    expect(b.ok && dec.decode(b.value)).toBe("%PDF-1.4 x");
  });

  test("IMP-016 flags directories, symlinks and encrypted entries from the central directory", () => {
    const zip = craftZip([
      { name: "ordner/", data: "", method: 0 },
      { name: "link.pdf", data: "/etc/passwd", method: 0, madeBy: 3, externalAttrs: (0o120777 << 16) >>> 0 },
      { name: "geheim.pdf", data: "x", flags: 0x0001 },
      { name: "normal.pdf", data: "%PDF", madeBy: 3, externalAttrs: (0o100644 << 16) >>> 0 },
    ]);
    const list = entries(zip);
    expect(list.map((e) => [e.path, e.isDirectory, e.isSymlink, e.encrypted])).toEqual([
      ["ordner/", true, false, false],
      ["link.pdf", false, true, false],
      ["geheim.pdf", false, false, true],
      ["normal.pdf", false, false, false],
    ]);
  });

  test("IMP-016 decodes names: UTF-8 flag, unflagged UTF-8 (macOS) and CP437 (Windows)", () => {
    const zip = craftZip([
      { name: "Grüße.csv", data: "a" },
      { name: enc.encode("Lösung.pdf"), data: "b" },
      { name: new Uint8Array([0x52, 0x84, 0x94, 0x81, 0xe1, 0x2e, 0x70, 0x64, 0x66]), data: "c" }, // Räöüß.pdf
    ]);
    expect(entries(zip).map((e) => e.path)).toEqual(["Grüße.csv", "Lösung.pdf", "Räöüß.pdf"]);
  });

  test("IMP-016 reads ZIP64 extra fields and the ZIP64 end record", () => {
    const zip = craftZip([{ name: "gross.csv", data: "a;b\n1;2\n", zip64: true }], { zip64Eocd: true });
    const list = entries(zip);
    expect(list.map((e) => [e.path, e.size])).toEqual([["gross.csv", 8]]);
    const r = extractZipEntry(zip, list[0] as (typeof list)[number]);
    expect(r.ok && dec.decode(r.value)).toBe("a;b\n1;2\n");
  });

  test("E-IMP-29 a truncated or non-ZIP file is rejected with a German reason", () => {
    const r = readZipDirectory(enc.encode("kein Archiv"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/Inhaltsverzeichnis/);
    const zip = zipSync({ "a.txt": enc.encode("abc") });
    const cut = readZipDirectory(zip.subarray(0, zip.length - 30));
    expect(cut.ok).toBe(false);
  });

  test("E-IMP-29 inflate never writes more than the declared size (zip bomb with a lying header)", () => {
    const zip = craftZip([{ name: "bombe.csv", data: "0".repeat(2_000_000), declaredSize: 1000 }]);
    const list = entries(zip);
    const r = extractZipEntry(zip, list[0] as (typeof list)[number]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("zip_size_mismatch");
  });

  test("E-IMP-29 a CRC mismatch and unsupported compression methods are rejected", () => {
    const bad = craftZip([{ name: "a.csv", data: "abc", crc: 1 }]);
    const r = extractZipEntry(bad, entries(bad)[0] as ReturnType<typeof entries>[number]);
    expect(!r.ok && r.error.code).toBe("zip_crc");
    const lzma = craftZip([{ name: "a.csv", data: "abc", method: 14 }]);
    const l = extractZipEntry(lzma, entries(lzma)[0] as ReturnType<typeof entries>[number]);
    expect(!l.ok && l.error.code).toBe("zip_method");
    if (!l.ok) expect(l.error.message).toMatch(/Komprimierungsverfahren/);
  });
});
