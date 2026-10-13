import { describe, expect, test } from "vitest";
import { crc32, sha256Sums, zipStore } from "./zip";

/** Minimal reader for the test: central directory → { name, data }. */
function readZip(zip: Uint8Array): { name: string; data: Uint8Array; crc: number }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out: { name: string; data: Uint8Array; crc: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(p, true)).toBe(0x02014b50);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const lNameLen = view.getUint16(local + 26, true);
    const lExtraLen = view.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    out.push({ name, data: zip.subarray(start, start + size), crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("SND-16 DOC-38 „Alles als ZIP“ with SHA256SUMS.txt", () => {
  test("SND-16 crc32 matches the reference value", () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  test("SND-16 the archive stores the files byte-identical (no compression) with UTF-8 names", () => {
    const pdf = new Uint8Array([37, 80, 68, 70, 0, 255, 1]);
    const xml = new TextEncoder().encode("<Invoice>Grüße</Invoice>");
    const zip = zipStore(
      [
        { name: "RE-2026-0001.pdf", data: pdf },
        { name: "RE-2026-0001.xml", data: xml },
        { name: "Prüfsummen/ä.txt", data: new Uint8Array([1]) },
      ],
      new Date("2026-10-12T10:00:00Z"),
    );
    const files = readZip(zip);
    expect(files.map((f) => f.name)).toEqual(["RE-2026-0001.pdf", "RE-2026-0001.xml", "Prüfsummen/ä.txt"]);
    expect(Array.from(files[0]?.data ?? [])).toEqual(Array.from(pdf));
    expect(new TextDecoder().decode(files[1]?.data)).toBe("<Invoice>Grüße</Invoice>");
    expect(files[1]?.crc).toBe(crc32(xml));
  });

  test("DOC-38 SHA256SUMS.txt lists `sha256  name` per file (sha256sum -c format)", () => {
    expect(
      sha256Sums([
        { name: "RE-2026-0001.pdf", sha256: "a".repeat(64) },
        { name: "RE-2026-0001.xml", sha256: "b".repeat(64) },
      ]),
    ).toBe(`${"a".repeat(64)}  RE-2026-0001.pdf\n${"b".repeat(64)}  RE-2026-0001.xml\n`);
  });
});
