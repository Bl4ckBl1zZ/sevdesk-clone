import { describe, expect, test } from "vitest";
import { matchFiles, normalizeForMatch } from "./pdf-match";

const rows = ["RE-1001", "RE-1002", "RE-1003", "RE-1005", "RE-1006", "RE-1007"].map((n) => ({
  key: `invoice:${n}`,
  number: n,
}));
const file = (id: string, name: string, sha = id) => ({ id, name, sha256: sha });

describe("F09 IMP-019 PDF matching by file name", () => {
  test("IMP-019 §4.3.5 step 1 normalisation (case, extension, leading words, separators)", () => {
    expect(normalizeForMatch("Rechnung_RE-1002.pdf")).toBe("re-1002");
    expect(normalizeForMatch("re 1003.PDF")).toBe("re-1003");
    expect(normalizeForMatch("RE-1003")).toBe("re-1003");
    expect(normalizeForMatch("Gutschrift GS.0001.pdf")).toBe("gs-0001");
    expect(normalizeForMatch("Rechnungen-2026.pdf")).toBe("rechnungen-2026");
  });

  test("TST-IMP-18 exact, prefixed and lower-case names match; one file for two rows is ambiguous; orphan and missing are listed", () => {
    const files = [
      file("a", "RE-1001.pdf"),
      file("b", "Rechnung_RE-1002.pdf"),
      file("c", "re 1003.PDF"),
      file("d", "RE-1005_RE-1006.pdf"),
      file("e", "RE-0999.pdf"),
    ];
    const r = matchFiles(rows, files);
    expect(r.matched).toEqual({ "invoice:RE-1001": "a", "invoice:RE-1002": "b", "invoice:RE-1003": "c" });
    expect(r.ambiguous).toEqual({ "invoice:RE-1005": ["d"], "invoice:RE-1006": ["d"] });
    expect(r.orphans).toEqual(["e"]);
    expect(r.missing).toEqual(["invoice:RE-1007"]);
  });

  test("IMP-019 several files for one row are ambiguous; identical bytes under two names count once; exact wins over containment", () => {
    const r = matchFiles(rows.slice(0, 1), [file("a", "RE-1001.pdf"), file("b", "RE-1001 Kopie.pdf")]);
    expect(r.ambiguous).toEqual({ "invoice:RE-1001": ["a", "b"] });
    const same = matchFiles(rows.slice(0, 1), [file("a", "RE-1001.pdf", "h"), file("b", "Rechnung RE-1001.pdf", "h")]);
    expect(same).toMatchObject({ matched: { "invoice:RE-1001": "a" }, duplicates: ["b"], orphans: [] });
    const exact = matchFiles(
      [
        { key: "invoice:1001", number: "1001" },
        { key: "invoice:RE-1001", number: "RE-1001" },
      ],
      [file("a", "RE-1001.pdf"), file("b", "1001.pdf")],
    );
    expect(exact.matched).toEqual({ "invoice:1001": "b", "invoice:RE-1001": "a" });
  });

  test("E-IMP-22 a manual assignment resolves an ambiguous row and takes the file away from the other rows", () => {
    const files = [file("d", "RE-1005_RE-1006.pdf"), file("f", "scan_17.pdf")];
    const r = matchFiles(rows, files, { "invoice:RE-1005": "d", "invoice:RE-1006": "f" });
    expect(r.matched).toEqual({ "invoice:RE-1005": "d", "invoice:RE-1006": "f" });
    expect(r.ambiguous).toEqual({});
    expect(r.orphans).toEqual([]);
  });
});
