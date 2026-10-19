import { describe, expect, test } from "vitest";
import { ATTACHMENT_MAX_BYTES, attachmentIssue, attachmentMime, embedIssue, missingProof } from "./attachments";

describe("attachments (DOC-18)", () => {
  test("DOC-18 at most 10 files, 10 MB each, PDF/PNG/JPEG/XLSX/CSV/TXT", () => {
    expect(attachmentIssue(0, { name: "agb.pdf", mime: "application/pdf", bytes: 1000 })).toBeNull();
    expect(attachmentIssue(10, { name: "x.pdf", mime: "application/pdf", bytes: 1 })).toBe(
      "Höchstens 10 Anhänge je Beleg.",
    );
    expect(attachmentIssue(0, { name: "x.pdf", mime: "application/pdf", bytes: ATTACHMENT_MAX_BYTES + 1 })).toBe(
      "Ein Anhang darf höchstens 10 MB groß sein.",
    );
    expect(attachmentIssue(0, { name: "x.exe", mime: "application/octet-stream", bytes: 1 })).toBe(
      "Erlaubt sind PDF, PNG, JPEG, XLSX, CSV und TXT.",
    );
    expect(attachmentMime("liste.CSV", "application/vnd.ms-excel")).toBe("text/csv");
    expect(attachmentMime("note.txt", "text/plain;charset=utf-8")).toBe("text/plain");
  });

  test("DOC-18 only BT-125 code-list types may be embedded as BG-24", () => {
    expect(embedIssue("application/pdf")).toBeNull();
    expect(embedIssue("text/csv")).toBeNull();
    expect(embedIssue("text/plain")).toContain("nicht in die E-Rechnung eingebettet");
  });
});

describe("proof attachments (INV-30, UST-21)", () => {
  const igl = { type: "invoice", taxCase: "intra_community_supply" };
  test("INV-30 UST-21 an intra-Community supply warns until a Gelangensbestätigung or CMR is attached", () => {
    expect(missingProof(igl, [])?.code).toBe("proof_missing_igl");
    expect(missingProof(igl, [])?.message).toContain("Gelangensbestätigung");
    expect(missingProof(igl, [{ kind: "other" }])).not.toBeNull();
    expect(missingProof(igl, [{ kind: "cmr" }])).toBeNull();
    expect(missingProof(igl, [{ kind: "gelangensbestaetigung" }])).toBeNull();
  });

  test("INV-30 UST-23 an export warns until an Ausfuhrnachweis is attached; domestic and Storno never warn", () => {
    const exp = { type: "final_invoice", taxCase: "export" };
    expect(missingProof(exp, [{ kind: "cmr" }])?.code).toBe("proof_missing_export");
    expect(missingProof(exp, [{ kind: "ausfuhrnachweis" }])).toBeNull();
    expect(missingProof({ type: "invoice", taxCase: "domestic" }, [])).toBeNull();
    expect(missingProof({ type: "cancellation", taxCase: "intra_community_supply" }, [])).toBeNull();
    expect(missingProof({ type: "advance_invoice", taxCase: "export" }, [])).toBeNull();
  });
});
