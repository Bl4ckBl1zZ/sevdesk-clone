import { describe, expect, test } from "vitest";
import { decodeDispatchId, exportRequest, finalizeArgs, markSentArgs, serializeFinalizeCheck } from "./dispatch";

/** 05 §4.3 finalise/export/mark-sent bodies shared by REST and the MCP dispatch tools (06 §2.3 confirm tokens). */

const RAW = "k57f3x2m9q8w1e4r6t";

describe("finalise arguments (DOC-20)", () => {
  test("CON-056 UST-30 overrides for an unverified VAT ID and a missing §13b certificate are passed with their reasons", () => {
    expect(finalizeArgs(RAW, { version: 1 } as never)).toEqual({ id: RAW, version: 1 });
    expect(
      finalizeArgs(RAW, {
        version: 2,
        document_date: "2026-10-01",
        backdate_reason: "Leistung im September",
        overrides: { vat_id_unverified_reason: "BZSt nicht erreichbar", rc13b_confirmation: "Bescheinigung liegt vor" },
      } as never),
    ).toEqual({
      id: RAW,
      version: 2,
      documentDate: "2026-10-01",
      backdateReason: "Leistung im September",
      overrides: {
        vatCheck: { reason: "BZSt nicht erreichbar" },
        rc13bCertificate: { reason: "Bescheinigung liegt vor" },
      },
    });
    expect(finalizeArgs(RAW, { version: 1, overrides: {} } as never)).toEqual({ id: RAW, version: 1 });
  });

  test("DOC-20 the finalise check splits errors and warnings; without a check nothing is allowed", () => {
    const out = serializeFinalizeCheck(`inv_${RAW}`, {
      status: "draft",
      version: 3,
      type: "invoice",
      check: {
        findings: [
          {
            code: "buyer_address_missing",
            severity: "E",
            message: "Anschrift fehlt.",
            rule: "BR-DE-8",
            field: "contact_id",
          },
          { code: "late_supply", severity: "W", message: "Leistungsdatum liegt weit zurück.", rule: "" },
        ],
        canFinalize: false,
        documentDate: "2026-10-12",
        taxCase: "domestic",
        taxCaseReasons: ["Inland"],
        totals: { netCents: 100_000, vatCents: 19_000, grossCents: 119_000, payableCents: 119_000 },
        einvoice: { decision: "required", reason: "B2B", format: "zugferd" },
      },
    });
    expect(out).toMatchObject({
      allowed: false,
      document_date: "2026-10-12",
      errors: [{ code: "buyer_address_missing", rule: "BR-DE-8", field: "contact_id" }],
      warnings: [{ code: "late_supply", rule: null, field: null }],
      totals: { gross_cents: 119_000, payable_cents: 119_000 },
      tax_case: { value: "domestic", reasons: ["Inland"] },
      einvoice: { decision: "required", format: "zugferd" },
    });
    expect(
      serializeFinalizeCheck(`inv_${RAW}`, { status: "finalized", version: 4, type: "invoice", check: null }),
    ).toMatchObject({
      allowed: false,
      document_date: null,
      errors: [],
      warnings: [],
      totals: null,
      tax_case: { value: null, reasons: [] },
      einvoice: { decision: "", reason: null, format: "none" },
    });
  });
});

describe("export and mark-sent bodies (SND-05, SND-16)", () => {
  test("SND-16 the export entry defaults to „default“; a re-export of the original carries its reason", () => {
    expect(exportRequest({})).toEqual({ entry: "default" });
    expect(exportRequest({ entry: "xml", original: true, reason: "Kunde hat das Original verloren" })).toEqual({
      entry: "xml",
      original: true,
      reason: "Kunde hat das Original verloren",
    });
  });

  test("MAIL-02 SND-05 mark-sent maps note and the electronic hand-over; a malformed file ID is an issue", () => {
    const { args, issues } = markSentArgs(RAW, {
      sent_on: "2026-10-12",
      channel: "email_manual",
      note: "an buchhaltung@kunde.de",
      einvoice_handed_over_electronically: true,
      artifacts: [`art_${RAW}`, "pdf-1"],
    } as never);
    expect(args).toEqual({
      id: RAW,
      values: {
        sentOn: "2026-10-12",
        channel: "email_manual",
        note: "an buchhaltung@kunde.de",
        electronicConfirmed: true,
        artifactIds: [RAW, ""],
      },
    });
    expect(issues).toEqual([{ field: "artifacts[1]", message: "Erwartet eine Datei-ID (art_…)." }]);
  });

  test("DOC-01 dispatch IDs resolve the document type from the prefix; an unknown prefix is null", () => {
    expect(decodeDispatchId(`quo_${RAW}`)).toEqual({ id: RAW, idType: "quote" });
    expect(decodeDispatchId(`rem_${RAW}`)?.idType).toBe("reminder");
    expect(decodeDispatchId(`xyz_${RAW}`)).toBeNull();
  });
});
