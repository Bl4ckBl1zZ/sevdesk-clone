import { makeContext, makeDraft, serviceLine, TODAY } from "@test/factories/documents";
import { makeSnapshot } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import { serializeEinvoice } from "../einvoice/serialize";
import type { SnapshotInputLine } from "./build-snapshot";
import { type ArchivedArtifact, type MarkSentContext, validateMarkSent } from "./dispatch";
import type { DraftDocument } from "./draft";
import type { OriginalContext } from "./relations";
import { validateDocument } from "./validate";

/** 10-edge-cases §3.1/§3.2/§3.5 edge cases on document dates, the mark-sent dialog and long texts (pure domain). */

const codes = (draft: DraftDocument) => validateDocument(draft, makeContext()).findings.map((f) => f.code);
const severityOf = (draft: DraftDocument, code: string) =>
  validateDocument(draft, makeContext()).findings.find((f) => f.code === code)?.severity;

describe("EC-021 invoice date in the future", () => {
  test("EC-021 a document date after today is blocked (UST-05); today itself is fine", () => {
    expect(severityOf(makeDraft({ documentDate: "2026-10-13" }), "document_date_future")).toBe("E");
    expect(codes(makeDraft({ documentDate: TODAY }))).not.toContain("document_date_future");
  });
});

describe("EC-023 supply date in the future", () => {
  const future = { supplyDate: { kind: "date", date: "2026-11-15" }, documentDate: TODAY } as const;

  test("EC-023 a regular invoice or a final invoice with a future supply date is blocked with the advance-invoice hint", () => {
    for (const type of ["invoice", "final_invoice"] as const) {
      const f = validateDocument(makeDraft({ type, ...future }), makeContext()).findings.find(
        (x) => x.code === "supply_date_in_future",
      );
      expect(f?.severity, type).toBe("E");
      expect(f?.message, type).toMatch(/Abschlagsrechnung/);
    }
  });

  test("EC-023 a correction of an invoice with a future supply date is blocked; a correction of an Anzahlung keeps its expected date", () => {
    const draft = makeDraft({ type: "correction", correctionKind: "rectification", ...future });
    expect(severityOf(draft, "supply_date_in_future")).toBe("E");
    const original = (type: "invoice" | "advance_invoice" | "partial_invoice"): ReturnType<typeof makeContext> => {
      const snap = makeSnapshot({ supplyDate: { kind: "date", date: "2026-11-15" } });
      const o: OriginalContext = {
        id: "orig",
        type,
        status: "finalized",
        number: "RE-2026-0001",
        documentDate: "2026-10-01",
        currency: "EUR",
        groups: [{ category: "S", rateBp: 1900, netCents: 95_000, vatCents: 18_050 }],
        hadXml: false,
        format: "none",
        er03RefDate: "2026-10-01",
        earlierCredits: [],
        earlierCorrections: [],
        snapshot: snap,
      };
      return makeContext({ relations: { original: o } });
    };
    const found = (ctx: ReturnType<typeof makeContext>) =>
      validateDocument(draft, ctx).findings.some((f) => f.code === "supply_date_in_future");
    expect(found(original("invoice"))).toBe(true);
    expect(found(original("advance_invoice"))).toBe(false);
    expect(found(original("partial_invoice"))).toBe(false);
  });

  test("EC-023 advance invoices, amount-based partial invoices, quotes, order confirmations and proforma may name a future supply date", () => {
    for (const type of ["advance_invoice", "partial_invoice", "quote", "order_confirmation", "proforma"] as const) {
      expect(codes(makeDraft({ type, ...future })), type).not.toContain("supply_date_in_future");
    }
  });

  test("EC-023 a supply period starting on/before the document date and ending later is only an info", () => {
    const draft = makeDraft({
      supplyDate: { kind: "period", from: "2026-10-01", to: "2026-10-31" },
      documentDate: TODAY,
    });
    expect(codes(draft)).not.toContain("supply_date_in_future");
    expect(severityOf(draft, "supply_period_ends_after_date")).toBe("I");
  });
});

// ── EC-091 ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ZUGFERD: ArchivedArtifact = { id: "z", kind: "zugferd_pdf", variant: "original", sha256: "hz", name: "RE.pdf" };
const XML: ArchivedArtifact = { id: "x", kind: "xrechnung_xml", sha256: "hx", name: "RE.xml" };
const PLAIN: ArchivedArtifact = { id: "p", kind: "pdf", variant: "original", sha256: "hp", name: "RE.pdf" };
const markCtx = (patch: Partial<MarkSentContext> = {}): MarkSentContext => ({
  today: TODAY,
  finalizedOn: "2026-10-12",
  backdateWindowDays: 10,
  artifactStatus: "ready",
  artifacts: [ZUGFERD, XML, PLAIN],
  decision: "PDF_NEEDS_CONSENT",
  consents: [],
  sendLog: [],
  ...patch,
});
const markCodes = (channel: "email_manual" | "post" | "hand" | "upload_portal", ids: string[], c = markCtx()) =>
  validateMarkSent({ sentOn: TODAY, channel, artifactIds: ids }, c).findings.map((f) => f.code);

describe("EC-091 PDF_NEEDS_CONSENT without stored consent", () => {
  test("EC-091 the E-Rechnung on an electronic channel and any file on paper (post/hand) are allowed", () => {
    expect(markCodes("email_manual", ["z"])).toEqual([]);
    expect(markCodes("upload_portal", ["x"])).toEqual([]);
    expect(markCodes("post", ["p"])).toEqual([]);
    expect(markCodes("hand", ["p"])).toEqual([]);
  });

  test("EC-091 a PDF-only hand-over on an electronic channel needs the consent recorded first (with source)", () => {
    expect(markCodes("email_manual", ["p"])).toEqual(["pdf_consent_required"]);
    const f = validateMarkSent({ sentOn: TODAY, channel: "email_manual", artifactIds: ["p"] }, markCtx()).findings[0];
    expect(f).toMatchObject({ severity: "E", rule: "MAIL-01" });
    // Once the consent (with its source) is stored and valid on the send date, the same hand-over passes.
    const consented = markCtx({ consents: [{ givenAt: "2026-10-01", source: "email", recordedAt: 0 }] });
    expect(markCodes("email_manual", ["p"], consented)).toEqual([]);
    // A consent given only after the send date does not count.
    const late = markCtx({ consents: [{ givenAt: "2026-10-13", source: "email", recordedAt: 0 }] });
    expect(markCodes("email_manual", ["p"], late)).toEqual(["pdf_consent_required"]);
  });
});

// ── EC-095 ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("EC-095 very long texts and many lines", () => {
  test("EC-095 1,000 lines with 5,000-character descriptions: the XML keeps every line and the full text; build + serialise within budget", () => {
    const description = `${"Leistungsbeschreibung mit vollständigem Wortlaut ".repeat(100)}ENDE`;
    expect(description.length).toBeGreaterThan(4_900);
    const lines: SnapshotInputLine[] = Array.from({ length: 1_000 }, (_, i) => ({
      kind: "item",
      name: `Position ${i + 1} ${"N".repeat(300)}`,
      description: `${description} #${i + 1}`,
      quantityMilli: 1_000,
      unitCode: "C62",
      unitPriceMicros: 10_000,
      vatCategory: "S",
      vatRateBp: 1900,
      vatRuleRowId: "standard@2021-01-01",
    }));
    const started = performance.now();
    const snapshot = makeSnapshot({ lines });
    for (const format of ["zugferd_en16931", "xrechnung_ubl"] as const) {
      const { xml } = serializeEinvoice(snapshot, format);
      expect(xml.split(`${description} #`).length - 1, format).toBe(1_000);
      expect(xml, format).toContain(`${description} #1000`);
      expect(xml, format).toContain(`Position 1000 ${"N".repeat(300)}`);
    }
    expect(snapshot.totals.netCents).toBe(1_000 * 100);
    // F04 performance budget: 1,000 lines finalise < 30 s (domain part: snapshot + both XML syntaxes).
    expect(performance.now() - started).toBeLessThan(30_000);
  });

  test("EC-095 a line text far beyond typical field limits is never truncated in the line itself", () => {
    const huge = "x".repeat(100_000);
    const snapshot = makeSnapshot({ lines: [{ ...serviceLineSnapshot(), description: huge }] });
    expect(serializeEinvoice(snapshot, "xrechnung_cii").xml).toContain(huge);
  });
});

function serviceLineSnapshot(): Extract<SnapshotInputLine, { kind: "item" }> {
  const l = serviceLine();
  return {
    kind: "item",
    name: l.name ?? "",
    quantityMilli: l.quantityMilli ?? 1_000,
    unitCode: l.unitCode ?? "C62",
    unitPriceMicros: l.unitPriceMicros ?? 0,
    vatCategory: "S",
    vatRateBp: 1900,
    vatRuleRowId: "standard@2021-01-01",
  };
}
