import { describe, expect, test } from "vitest";
import { BUYERS, makeSnapshot } from "../../../test/factories/snapshot";
import { checkEinvoiceDocument, type EinvoiceInvariantDoc } from "./invariants";

const LEITWEG = "04011000-1234512345-06";

const mustE = (patch: Partial<EinvoiceInvariantDoc> = {}): EinvoiceInvariantDoc => ({
  name: "RE-2027-001",
  type: "invoice",
  status: "finalized",
  decision: "MUST_E",
  validation: "passed",
  artifactStatus: "ready",
  snapshot: makeSnapshot({ einvoice: { format: "zugferd_en16931", decision: "MUST_E" } }),
  artifacts: [
    { id: "a1", kind: "zugferd_pdf" },
    { id: "a2", kind: "xrechnung_xml" },
    { id: "a3", kind: "validation_report_kosit" },
  ],
  marks: [],
  ...patch,
});

describe("RI-18 MUST_E documents have a validated E-Rechnung", () => {
  test("RI-18 archived XML + KoSIT report, handed over electronically: no finding", () => {
    const d = mustE({
      status: "sent",
      marks: [
        {
          id: "m1",
          kind: "mark_sent",
          channel: "email_manual",
          artifactIds: ["a1"],
          einvoiceHandedOverElectronically: true,
        },
      ],
    });
    expect(checkEinvoiceDocument(d)).toEqual([]);
  });

  test("RI-18 ready artifacts without XML or without the KoSIT report are an ERROR", () => {
    expect(checkEinvoiceDocument(mustE({ artifacts: [{ id: "a1", kind: "pdf" }] })).map((f) => f.message)).toEqual([
      expect.stringContaining("keine XML"),
      expect.stringContaining("kein Prüfbericht"),
    ]);
    // test deployments without the sidecar record `skipped` (convex/lib/einvoiceTools.ts) — no report expected
    expect(
      checkEinvoiceDocument(mustE({ validation: "skipped", artifacts: [{ id: "a2", kind: "xrechnung_xml" }] })),
    ).toEqual([]);
    // Storno/corrections have no preview validation: the XML is required, the report only follows a `passed` preview
    expect(
      checkEinvoiceDocument(
        mustE({ type: "cancellation", validation: undefined, artifacts: [{ id: "a2", kind: "xrechnung_xml" }] }),
      ),
    ).toEqual([]);
    expect(
      checkEinvoiceDocument(
        mustE({ type: "cancellation", validation: undefined, artifacts: [{ id: "a1", kind: "pdf" }] }),
      ),
    ).toEqual([expect.objectContaining({ id: "RI-18", message: expect.stringContaining("keine XML") })]);
  });

  test("RI-18 pending artifacts are not yet checked; blocked artifacts must not carry a sent mark", () => {
    expect(checkEinvoiceDocument(mustE({ artifactStatus: "pending", artifacts: [] }))).toEqual([]);
    expect(checkEinvoiceDocument(mustE({ artifactStatus: "blocked", artifacts: [] }))).toEqual([]);
    const sent = mustE({
      artifactStatus: "blocked",
      marks: [
        {
          id: "m1",
          kind: "mark_sent",
          channel: "email_manual",
          artifactIds: ["a1"],
          einvoiceHandedOverElectronically: true,
        },
      ],
    });
    expect(checkEinvoiceDocument(sent)).toEqual([
      expect.objectContaining({ id: "RI-18", message: expect.stringContaining("blockiert") }),
    ]);
  });

  test("RI-18 the effective mark must hand over the structured e-invoice electronically (post / PDF only fail)", () => {
    const post = mustE({
      marks: [{ id: "m1", kind: "mark_sent", channel: "post", artifactIds: ["a1"] }],
    });
    expect(checkEinvoiceDocument(post)).toEqual([expect.objectContaining({ id: "RI-18" })]);
    // a retracted wrong mark followed by a correct one is fine
    const fixed = mustE({
      marks: [
        { id: "m1", kind: "mark_sent", channel: "post", artifactIds: ["a1"] },
        { id: "r1", kind: "retraction", retractsId: "m1", channel: "post", artifactIds: [] },
        {
          id: "m2",
          kind: "mark_sent",
          channel: "upload_portal",
          artifactIds: ["a2"],
          einvoiceHandedOverElectronically: true,
        },
      ],
    });
    expect(checkEinvoiceDocument(fixed)).toEqual([]);
  });

  test("RI-18 MUST_E with format none or without validation is an ERROR; other decisions are not checked", () => {
    const none = mustE({
      snapshot: makeSnapshot({ einvoice: { format: "none", decision: "MUST_E" } }),
      validation: "not_required",
    });
    expect(checkEinvoiceDocument(none).map((f) => f.id)).toEqual(["RI-18", "RI-18"]);
    expect(
      checkEinvoiceDocument(mustE({ decision: "PDF_NEEDS_CONSENT", artifacts: [{ id: "a1", kind: "pdf" }] })),
    ).toEqual([]);
  });
});

describe("RI-25 B2G invoices carry a valid Leitweg-ID", () => {
  const b2g = (buyerReference: string | undefined, type: EinvoiceInvariantDoc["type"] = "invoice") =>
    mustE({
      type,
      decision: "PDF_NEEDS_CONSENT",
      snapshot: makeSnapshot({ buyer: BUYERS.public, ...(buyerReference ? { references: { buyerReference } } : {}) }),
    });

  test("RI-25 a valid Leitweg-ID in BT-10 passes", () => {
    const d = b2g(LEITWEG);
    expect(d.snapshot.references.buyerReference).toBe(LEITWEG);
    expect(checkEinvoiceDocument(d)).toEqual([]);
  });

  test("RI-25 a missing or wrong Leitweg-ID on a B2G invoice is an ERROR", () => {
    expect(checkEinvoiceDocument(b2g(undefined))).toEqual([
      expect.objectContaining({ id: "RI-25", severity: "ERROR" }),
    ]);
    expect(checkEinvoiceDocument(b2g("04011000-1234512345-07"))).toEqual([expect.objectContaining({ id: "RI-25" })]);
  });

  test("RI-25 quotes to public authorities carry no BT-10", () => {
    expect(checkEinvoiceDocument(b2g(undefined, "quote"))).toEqual([]);
  });
});
