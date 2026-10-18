import { craftZip, tinyPdf } from "@test/factories/zip";
import { zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../../time/calendar-date";
import { IMPORT_ZIP_LIMITS, isZipBytes, unpackImportZip } from "./archive";
import { inspectFile } from "./files";
import { parseImportFiles } from "./preview";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function unpack(name: string, zip: Uint8Array, limits = IMPORT_ZIP_LIMITS) {
  const seen: { path: string; text: string; bytes: number }[] = [];
  const r = await unpackImportZip(
    name,
    zip,
    async (e) => {
      seen.push({ path: e.path, text: dec.decode(e.bytes.subarray(0, 40)), bytes: e.bytes.length });
    },
    { limits },
  );
  return { r, seen };
}

describe("IMP-016 sevdesk ZIP uploads are unpacked safely (§4.3.1 container row, E-IMP-29)", () => {
  test("IMP-016 the verified sevdesk invoice ZIP (flat, one PDF per document) yields every PDF", async () => {
    const zip = zipSync({
      "2026-06-10_Rechnung_RE-5000_0123456789abcdef0123456789abcd00.pdf": tinyPdf("5000"),
      "2026-08-12_Stornorechnung_RE-5003_0123456789abcdef0123456789abcd03.pdf": tinyPdf("5003"),
    });
    const { r, seen } = await unpack("Rechnungen_18.10.26.zip", zip);
    expect(r.ok).toBe(true);
    expect(seen.map((s) => s.path)).toEqual([
      "2026-06-10_Rechnung_RE-5000_0123456789abcdef0123456789abcd00.pdf",
      "2026-08-12_Stornorechnung_RE-5003_0123456789abcdef0123456789abcd03.pdf",
    ]);
    expect(seen.every((s) => s.text.startsWith("%PDF-1.4"))).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ files: 2, ignored: [] });
  });

  test("IMP-016 a GoBD/Datenexport ZIP: CSVs and PDFs in folders, directories and OS junk are skipped", async () => {
    const zip = zipSync({
      "export/": new Uint8Array(),
      "export/contacts.csv": enc.encode("\uFEFFKunden-Nr.;Nachname\n1000;Muster\n"),
      "export/belege/RE-1.pdf": tinyPdf("1"),
      "__MACOSX/export/._contacts.csv": new Uint8Array([0, 5, 22, 7]),
      "export/.DS_Store": new Uint8Array([0, 0, 0, 1]),
      "export/Thumbs.db": new Uint8Array([1]),
    });
    const { r, seen } = await unpack("datenexport.zip", zip);
    expect(seen.map((s) => s.path)).toEqual(["export/contacts.csv", "export/belege/RE-1.pdf"]);
    if (r.ok) {
      expect(r.value.files).toBe(2);
      expect(r.value.ignored).toEqual(["__MACOSX/export/._contacts.csv", "export/.DS_Store", "export/Thumbs.db"]);
    }
  });

  test("IMP-016 nested ZIPs are unpacked up to 3 levels; inner paths carry the archive name", async () => {
    const level3 = zipSync({ "c.pdf": tinyPdf("c") });
    const level2 = zipSync({ "b.pdf": tinyPdf("b"), "tief.zip": level3 });
    const outer = zipSync({ "a.pdf": tinyPdf("a"), "innen.zip": level2 });
    const { r, seen } = await unpack("aussen.zip", outer);
    expect(r.ok).toBe(true);
    expect(seen.map((s) => s.path)).toEqual(["a.pdf", "innen.zip/b.pdf", "innen.zip/tief.zip/c.pdf"]);
  });

  test("TST-IMP-23 E-IMP-29 a fourth nesting level rejects the archive", async () => {
    const l4 = zipSync({ "d.pdf": tinyPdf("d") });
    const l3 = zipSync({ "l4.zip": l4 });
    const l2 = zipSync({ "l3.zip": l3 });
    const outer = zipSync({ "l2.zip": l2 });
    const { r } = await unpack("aussen.zip", outer);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("E-IMP-29");
      expect(r.error.message).toBe(
        "Die ZIP-Datei aussen.zip ist ungültig oder zu groß: Archive sind tiefer als 3 Ebenen verschachtelt.",
      );
    }
  });

  test.each([
    ["../../etc/passwd", "„../../etc/passwd“ zeigt aus dem Archiv heraus."],
    ["belege/../../x.pdf", "„belege/../../x.pdf“ zeigt aus dem Archiv heraus."],
    ["..\\x.pdf", "„..\\x.pdf“ zeigt aus dem Archiv heraus."],
    ["/etc/passwd", "„/etc/passwd“ ist ein absoluter Pfad."],
    ["C:\\Windows\\x.pdf", "„C:\\Windows\\x.pdf“ ist ein absoluter Pfad."],
  ])("TST-IMP-23 E-IMP-29 unsafe path %s rejects the archive before anything is extracted", async (path, reason) => {
    const zip = craftZip([
      { name: "ok.pdf", data: tinyPdf("ok") },
      { name: path, data: "x" },
    ]);
    const { r, seen } = await unpack("boese.zip", zip);
    expect(seen).toEqual([]);
    expect(!r.ok && r.error.message).toBe(`Die ZIP-Datei boese.zip ist ungültig oder zu groß: ${reason}`);
  });

  test("TST-IMP-23 E-IMP-29 symbolic links are rejected", async () => {
    const zip = craftZip([
      { name: "link.pdf", data: "/etc/passwd", method: 0, madeBy: 3, externalAttrs: (0o120777 << 16) >>> 0 },
    ]);
    const { r } = await unpack("link.zip", zip);
    expect(!r.ok && r.error.message).toBe(
      "Die ZIP-Datei link.zip ist ungültig oder zu groß: „link.pdf“ ist eine symbolische Verknüpfung.",
    );
  });

  test("TST-IMP-23 E-IMP-29 a compression ratio above 100:1 (entries ≥ 1 MB) rejects the archive (zip bomb)", async () => {
    const zip = zipSync({ "bombe.csv": [new Uint8Array(5 * 1024 * 1024), { level: 9 }] });
    const { r, seen } = await unpack("bombe.zip", zip);
    expect(seen).toEqual([]);
    expect(!r.ok && r.error.message).toBe(
      "Die ZIP-Datei bombe.zip ist ungültig oder zu groß: „bombe.csv“ ist ungewöhnlich stark komprimiert (über 100:1).",
    );
    // A small, highly repetitive CSV below the 1 MB floor is fine.
    const small = zipSync({ "liste.csv": [enc.encode("a;b\n".repeat(50_000)), { level: 9 }] });
    expect((await unpack("klein.zip", small)).r.ok).toBe(true);
  });

  test("E-IMP-29 a lying size header cannot expand beyond the declared size", async () => {
    const zip = craftZip([{ name: "a.csv", data: "0".repeat(500_000), declaredSize: 10_000 }]);
    const { r, seen } = await unpack("luege.zip", zip);
    expect(seen).toEqual([]);
    expect(!r.ok && r.error.code).toBe("E-IMP-29");
    if (!r.ok) expect(r.error.message).toMatch(/^Die ZIP-Datei luege\.zip ist ungültig oder zu groß: /);
  });

  test("E-IMP-29 expanded size above the import's remaining 2 GB budget rejects the archive", async () => {
    const zip = zipSync({ "a.pdf": tinyPdf("a"), "b.pdf": tinyPdf("b") });
    const { r } = await unpack("voll.zip", zip, { ...IMPORT_ZIP_LIMITS, maxTotalBytes: 100 });
    expect(!r.ok && r.error.message).toBe(
      "Die ZIP-Datei voll.zip ist ungültig oder zu groß: Entpackt wären die Dateien größer als 2 GB je Import.",
    );
  });

  test("E-IMP-39 encrypted entries reject the archive", async () => {
    const zip = craftZip([
      { name: "a.pdf", data: tinyPdf("a") },
      { name: "geheim.pdf", data: "x", flags: 0x0001 },
    ]);
    const { r, seen } = await unpack("passwort.zip", zip);
    expect(seen).toEqual([]);
    expect(!r.ok && r.error).toEqual({
      code: "E-IMP-39",
      message:
        "Die ZIP-Datei passwort.zip enthält verschlüsselte Dateien (geheim.pdf). Bitte das Archiv ohne Passwort erstellen und erneut hochladen.",
    });
  });

  test("E-IMP-40 more than 10.000 entries or an entry above 50 MB reject the archive", async () => {
    const many = zipSync({ "a.pdf": tinyPdf("a"), "b.pdf": tinyPdf("b"), "c.pdf": tinyPdf("c") });
    const { r } = await unpack("viele.zip", many, { ...IMPORT_ZIP_LIMITS, maxEntries: 2 });
    expect(!r.ok && r.error).toEqual({
      code: "E-IMP-40",
      message: "Die ZIP-Datei viele.zip enthält mehr als 2 Dateien. Bitte auf mehrere Archive aufteilen.",
    });
    const big = craftZip([{ name: "riesig.pdf", data: tinyPdf("x"), method: 0, declaredSize: 60 * 1024 * 1024 }]);
    const b = await unpack("gross.zip", big);
    expect(!b.r.ok && b.r.error).toEqual({
      code: "E-IMP-40",
      message: "riesig.pdf in gross.zip ist entpackt größer als 50 MB. Bitte die Datei einzeln hochladen.",
    });
  });

  test("E-IMP-29 a damaged archive is rejected with a German reason", async () => {
    const { r } = await unpack("kaputt.zip", enc.encode("PK\u0003\u0004 abgeschnitten"));
    expect(!r.ok && r.error.message).toBe(
      "Die ZIP-Datei kaputt.zip ist ungültig oder zu groß: Das Inhaltsverzeichnis des Archivs fehlt oder ist beschädigt.",
    );
  });

  test("IMP-016 isZipBytes recognises local-header and empty archives only", () => {
    expect(isZipBytes(zipSync({ "a.txt": enc.encode("a") }))).toBe(true);
    expect(isZipBytes(zipSync({}))).toBe(true);
    expect(isZipBytes(tinyPdf("x"))).toBe(false);
    expect(isZipBytes(enc.encode("PK;Name\n"))).toBe(false);
  });

  test("IMP-016 the preview treats an unpacked ZIP as evidence only (no finding); its PDFs are document files", () => {
    const parsed = parseImportFiles(
      [
        { id: "f1", name: "Rechnungen_18.10.26.zip", sha256: "z", kind: "zip" },
        { id: "f2", name: "2026-06-10_Rechnung_RE-5000_x.pdf", sha256: "p", kind: "pdf" },
      ],
      {},
      "2026-10-18" as CalendarDate,
    );
    expect(parsed.findings).toEqual([]);
    expect(parsed.documentFiles.map((f) => f.id)).toEqual(["f2"]);
  });

  test("IMP-016 a contained CSV is classified like a single upload (inner path as file name)", async () => {
    const csv = '\uFEFF\uFEFF"Kunden-Nr.";"Nachname";"Organisation";\n"1000";"Muster";"";\n';
    const zip = zipSync({ "export/contacts.csv": enc.encode(csv) });
    const kinds: string[] = [];
    await unpackImportZip("x.zip", zip, async (e) => {
      kinds.push(inspectFile(e.path, e.bytes).kind);
    });
    expect(kinds).toEqual(["contacts"]);
  });
});
