import { describe, expect, test } from "vitest";
import { CAPTURE_MESSAGES } from "@/domain/vouchers/capture";
import { collectEntryFiles, type EntryLike, filesFromDataTransfer, precheckFiles } from "./drop-files";

const file = (name: string, content: string | Uint8Array, type = "") =>
  new File([typeof content === "string" ? content : (content as Uint8Array<ArrayBuffer>)], name, { type });

const fileEntry = (f: File, path: string): EntryLike => ({
  isFile: true,
  isDirectory: false,
  name: f.name,
  fullPath: path,
  file: (ok) => ok(f),
});

/** A directory whose reader returns its children in batches of `batch` (Chrome: 100), then an empty batch. */
const dirEntry = (name: string, children: EntryLike[], batch = 2): EntryLike => ({
  isFile: false,
  isDirectory: true,
  name,
  fullPath: `/${name}`,
  createReader: () => {
    let at = 0;
    return {
      readEntries: (ok) => {
        const next = children.slice(at, at + batch);
        at += batch;
        ok(next);
      },
    };
  },
});

const PDF = "%PDF-1.7\n…";

describe("folder drop (INB-002)", () => {
  test("INB-002 T06-002 directory traversal yields one file per leaf, reading every batch, in path order", async () => {
    const a = file("a.pdf", PDF);
    const b = file("b.pdf", PDF);
    const c = file("c.xml", "<?xml version='1.0'?><Invoice/>");
    const d = file("notiz.txt", "hallo");
    const tree = [
      dirEntry("Belege", [
        fileEntry(b, "/Belege/b.pdf"),
        fileEntry(a, "/Belege/a.pdf"),
        dirEntry("2026", [fileEntry(c, "/Belege/2026/c.xml")]),
        fileEntry(d, "/Belege/notiz.txt"),
      ]),
    ];
    const out = await collectEntryFiles(tree);
    expect(out.map((x) => x.path)).toEqual(["Belege/2026/c.xml", "Belege/a.pdf", "Belege/b.pdf", "Belege/notiz.txt"]);
    expect(out[1]?.file).toBe(a);
  });

  test("INB-002 a DataTransfer without entry support falls back to its files", async () => {
    const a = file("a.pdf", PDF);
    const dt = { items: undefined, files: [a] } as unknown as DataTransfer;
    expect((await filesFromDataTransfer(dt)).map((x) => x.file)).toEqual([a]);
    const withEntries = {
      items: [{ kind: "file", webkitGetAsEntry: () => fileEntry(a, "/a.pdf") }],
      files: [a],
    } as unknown as DataTransfer;
    expect((await filesFromDataTransfer(withEntries)).map((x) => x.path)).toEqual(["a.pdf"]);
  });

  test("INB-001 INB-002 EC-INB-01 non-accepted files are listed by magic bytes, not by extension; > 20 MB rejected", async () => {
    const realPdf = file("scan.jpg", PDF); // wrong extension, real PDF → accepted
    const fake = file("rechnung.pdf", "not a pdf"); // extension lies → rejected
    const empty = file("leer.pdf", "");
    const big = file("gross.pdf", new Uint8Array(21 * 1024 * 1024));
    const r = await precheckFiles(
      [realPdf, fake, empty, big].map((f) => ({ file: f, path: f.name })),
      20 * 1024 * 1024,
    );
    expect(r.accepted.map((x) => x.file.name)).toEqual(["scan.jpg"]);
    expect(r.rejected).toEqual([
      { name: "rechnung.pdf", message: CAPTURE_MESSAGES.unsupported },
      { name: "leer.pdf", message: CAPTURE_MESSAGES.unsupported },
      { name: "gross.pdf", message: CAPTURE_MESSAGES.tooLarge(20) },
    ]);
  });
});
