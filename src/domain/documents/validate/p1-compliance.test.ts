import { makeContext, makeDraft, serviceLine } from "@test/factories/documents";
import { describe, expect, test } from "vitest";
import type { DocumentContext, DraftDocument } from "../draft";
import { validateDocument } from "./index";

const findings = (draft: DraftDocument, ctx: DocumentContext = makeContext(), opts = {}) =>
  validateDocument(draft, ctx, opts).findings;
const codes = (draft: DraftDocument, ctx: DocumentContext = makeContext(), opts = {}) =>
  findings(draft, ctx, opts).map((f) => f.code);

describe("line content (DOC-49, UST-07)", () => {
  test("DOC-49 every item line needs a Rec 20/21 unit code; generic descriptions warn with generic_description", () => {
    const noUnit = findings(makeDraft({ lines: [serviceLine({ unitCode: undefined })] }));
    expect(noUnit.find((f) => f.code === "line_unit_missing")?.severity).toBe("E");
    const badUnit = findings(makeDraft({ lines: [serviceLine({ unitCode: "STUNDEN" })] }));
    expect(badUnit.find((f) => f.code === "line_unit_invalid")?.severity).toBe("E");
    for (const name of ["Leistung", "Diverses", " Pauschale ", "SERVICE"]) {
      const f = findings(makeDraft({ lines: [serviceLine({ name })] })).find((x) => x.code === "generic_description");
      expect(f?.severity, name).toBe("W");
    }
    // a specific description and a seeded unit code pass
    expect(codes(makeDraft({ lines: [serviceLine({ name: "Webdesign Startseite", unitCode: "HUR" })] }))).not.toEqual(
      expect.arrayContaining(["line_unit_missing", "line_unit_invalid", "generic_description"]),
    );
    // headings and text lines need no unit
    expect(codes(makeDraft({ lines: [{ kind: "heading", name: "Leistungen" }, serviceLine()] }))).not.toContain(
      "line_unit_missing",
    );
  });
});
