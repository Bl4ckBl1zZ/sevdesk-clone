/**
 * F04 §5.2 edge cases of the ER-03 decision, the export and the sent mark (T-EC-074…115): the decision through the
 * validator (`planEinvoice`), the mark through `validateMarkSent`/`validateRetraction`.
 */
import { BUYERS, makeContact, makeContext, makeDraft, serviceLine } from "@test/factories/documents";
import { makeSnapshot } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import { requiresERechnung } from "../einvoice/er03";
import type { CalendarDate } from "../time/calendar-date";
import { buildSnapshot } from "./build-snapshot";
import {
  type ArchivedArtifact,
  exportEntriesFor,
  type MarkSentContext,
  type MarkSentInput,
  type SendLogRow,
  sentStateOf,
  validateMarkSent,
  validateRetraction,
} from "./dispatch";
import type { DocumentContext, DraftDocument } from "./draft";
import { buildSnapshotInput } from "./finalize";
import type { OriginalContext } from "./relations";
import { validateDocument } from "./validate";

const day = (d: string) => d as CalendarDate;
const plan = (draft: DraftDocument, ctx: DocumentContext) => validateDocument(draft, ctx).einvoice;

const ZUGFERD: ArchivedArtifact = { id: "a1", kind: "zugferd_pdf", variant: "original", sha256: "h1", name: "RE.pdf" };
const XML: ArchivedArtifact = { id: "a2", kind: "xrechnung_xml", sha256: "h2", name: "RE.xml" };
const PLAIN: ArchivedArtifact = { id: "a3", kind: "pdf", variant: "original", sha256: "h3", name: "RE.pdf" };
const READING: ArchivedArtifact = {
  id: "a4",
  kind: "pdf",
  variant: "reading",
  sha256: "h4",
  name: "RE_Lesefassung.pdf",
};

const markCtx = (patch: Partial<MarkSentContext> = {}): MarkSentContext => ({
  today: day("2026-10-12"),
  finalizedOn: "2026-10-01",
  backdateWindowDays: 10,
  artifactStatus: "ready",
  artifacts: [ZUGFERD, XML, PLAIN, READING],
  decision: "PDF_NEEDS_CONSENT",
  consents: [],
  sendLog: [],
  ...patch,
});
const mark = (patch: Partial<MarkSentInput> = {}): MarkSentInput => ({
  sentOn: "2026-10-12",
  channel: "email_manual",
  artifactIds: ["a1"],
  ...patch,
});
const markErrors = (i: MarkSentInput, c: MarkSentContext = markCtx()) =>
  validateMarkSent(i, c)
    .findings.filter((f) => f.severity === "E")
    .map((f) => f.code);

describe("ER-03 decision edges (EC-DOC-86…90, 109)", () => {
  const in2027 = (patch: Partial<DocumentContext["company"]> = {}) => makeContext({ today: day("2027-03-15") }, patch);
  const draft2027 = makeDraft({ supplyDate: { kind: "date", date: "2027-03-10" } });

  test("EC-DOC-86 T-EC-086 a 2027 invoice uses the confirmed 2026 turnover, else the running total with turnover_provisional", () => {
    const confirmed = plan(draft2027, in2027({ priorYearTurnover: [{ year: 2026, amountCents: 50_000_000 }] }));
    expect(confirmed.er03).toMatchObject({ decision: "PDF_NEEDS_CONSENT", warnings: [] });
    const running = plan(
      draft2027,
      in2027({ priorYearTurnover: [{ year: 2026, amountCents: 50_000_000, provisional: true }] }),
    );
    expect(running.er03).toMatchObject({ decision: "PDF_NEEDS_CONSENT", warnings: ["turnover_provisional"] });
    const above = plan(
      draft2027,
      in2027({ priorYearTurnover: [{ year: 2026, amountCents: 80_000_001, provisional: true }] }),
    );
    expect(above.er03).toMatchObject({ decision: "MUST_E", warnings: ["turnover_provisional"] });
    expect(above.format).not.toBe("none");
  });

  test("EC-DOC-87 T-EC-087 the transition applies by supply date: 2027-12-31 invoiced 2028-01-05 → PDF_NEEDS_CONSENT; 2028 supply → MUST_E", () => {
    const ctx = makeContext(
      { today: day("2028-01-05") },
      {
        priorYearTurnover: [
          { year: 2026, amountCents: 50_000_000 },
          { year: 2027, amountCents: 50_000_000 },
        ],
      },
    );
    const lateInvoice = makeDraft({ documentDate: "2028-01-05", supplyDate: { kind: "date", date: "2027-12-31" } });
    expect(plan(lateInvoice, ctx).er03.decision).toBe("PDF_NEEDS_CONSENT");
    const supply2028 = makeDraft({ documentDate: "2028-01-05", supplyDate: { kind: "date", date: "2028-01-01" } });
    const p = plan(supply2028, ctx);
    expect(p.er03.decision).toBe("MUST_E");
    expect(validateDocument({ ...supply2028, einvoiceFormat: "none" }, ctx).findings.map((f) => f.code)).toContain(
      "einvoice_required",
    );
  });

  test("EC-DOC-88 T-EC-088 the correction or Storno of an E-Rechnung is itself an E-Rechnung (R1)", () => {
    const original: OriginalContext = {
      id: "re1",
      type: "invoice",
      status: "sent",
      number: "RE-2026-0042",
      documentDate: "2026-10-01",
      currency: "EUR",
      groups: [{ category: "S", rateBp: 1900, netCents: 95_000, vatCents: 18_050 }],
      hadXml: true,
      format: "zugferd_en16931",
      er03RefDate: "2026-09-30",
      earlierCredits: [],
      earlierCorrections: [],
      snapshot: makeSnapshot(),
    };
    const credit = makeDraft({
      type: "correction",
      correctionKind: "credit",
      lines: [serviceLine({ quantityMilli: -1_000 })],
      einvoiceFormat: "none",
    });
    const v = validateDocument(credit, makeContext({ relations: { original } }));
    expect(v.einvoice.er03).toMatchObject({ decision: "MUST_E", ruleId: "R1" });
    expect(v.einvoice.format).toBe("zugferd_en16931");
    expect(v.einvoice.chosenNotAllowed).toBe(true); // "none" is not offered; the commit uses the XML format
    const storno = requiresERechnung({
      docType: "cancellation",
      taxCase: "domestic",
      issuer: { isKleinunternehmer: false, priorYearTurnover: { cents: 50_000_000, final: true } },
      recipient: { countryCode: "DE", isConsumer: false, isPublicAuthority: false },
      refDate: "2026-09-30",
      grossEurCents: 113_050,
      original: { hadXml: true, refDate: "2026-09-30" },
    });
    expect(storno).toMatchObject({ decision: "MUST_E", ruleId: "R1" });
  });

  test("EC-DOC-89 T-EC-089 a 2028 Storno of a PDF invoice for a 2026 supply follows the original's reference date", () => {
    const storno = requiresERechnung({
      docType: "cancellation",
      taxCase: "domestic",
      issuer: { isKleinunternehmer: false, priorYearTurnover: { cents: 50_000_000, final: true } },
      recipient: { countryCode: "DE", isConsumer: false, isPublicAuthority: false },
      refDate: "2028-02-01",
      grossEurCents: 113_050,
      original: { hadXml: false, refDate: "2026-06-30" },
    });
    expect(storno.decision).toBe("PDF_NEEDS_CONSENT");
    // a fresh invoice on the Storno date would need the E-Rechnung
    expect(
      requiresERechnung({
        docType: "invoice",
        taxCase: "domestic",
        issuer: { isKleinunternehmer: false, priorYearTurnover: { cents: 50_000_000, final: true } },
        recipient: { countryCode: "DE", isConsumer: false, isPublicAuthority: false },
        refDate: "2028-02-01",
        grossEurCents: 113_050,
      }).decision,
    ).toBe("MUST_E");
  });

  test("EC-DOC-90 T-EC-090 an Ist company gets the UST-13 note only on documents dated from 2028-01-01", () => {
    const notesOn = (date: string) => {
      const ctx = makeContext({ today: day(date) }, { taxationMethod: [{ validFrom: "2020-01-01", method: "ist" }] });
      const draft = makeDraft({ documentDate: date, supplyDate: { kind: "date", date: "2027-12-20" } });
      const v = validateDocument(draft, ctx);
      const s = buildSnapshot(
        buildSnapshotInput(draft, ctx, v.resolved, {
          number: "RE-1",
          documentDate: date,
          layoutVersionId: "layout-v1",
          plan: v.einvoice,
        }),
      );
      if (!s.ok) throw new Error(s.error.code);
      return s.value.notes.map((n) => n.id);
    };
    expect(notesOn("2027-12-31")).not.toContain("ist_2028");
    expect(notesOn("2028-01-01")).toContain("ist_2028");
  });

  test("EC-DOC-109 T-EC-109 an E-Rechnung to a foreign recipient or a consumer is allowed; the decision is NOT_REQUIRED", () => {
    const foreign = makeContext({
      contact: makeContact({ countryCode: "CH", buyer: BUYERS.ch, vatId: undefined }),
    });
    const consumer = makeContext({
      contact: makeContact({ isConsumer: true, buyer: BUYERS.consumer, vatId: undefined }),
    });
    for (const ctx of [foreign, consumer]) {
      const p = plan(makeDraft({ einvoiceFormat: "zugferd_en16931" }), ctx);
      expect(p.er03.decision).toBe("NOT_REQUIRED");
      expect(p.format).toBe("zugferd_en16931");
      expect(p.chosenNotAllowed).toBe(false);
    }
  });
});

describe("export and the sent mark (EC-DOC-74, 75, 113…115)", () => {
  test("EC-DOC-74 T-EC-074 MUST_E with a customer who prefers PDF: XML always produced, no PDF-only export, PDF-only mark refused", () => {
    const pdfFan = makeContext(
      {
        today: day("2028-03-15"),
        contact: makeContact({ preferredFormat: "pdf" }),
      },
      { priorYearTurnover: [{ year: 2027, amountCents: 50_000_000 }] },
    );
    const p = plan(makeDraft({ supplyDate: { kind: "date", date: "2028-03-10" } }), pdfFan);
    expect(p.er03.decision).toBe("MUST_E");
    expect(p.format).toBe("zugferd_en16931");
    expect(p.formatDecision.notice).toBe("E-Rechnung ist Pflicht – PDF-Wunsch des Kunden kann nicht erfüllt werden");
    expect(exportEntriesFor(p.format)).not.toContain("pdf");
    expect(markErrors(mark({ artifactIds: ["a3"] }), markCtx({ decision: "MUST_E" }))).toEqual([
      "pdf_not_allowed_must_e",
    ]);
    // without MUST_E the PDF wish is honoured
    const p2026 = plan(makeDraft(), makeContext({ contact: makeContact({ preferredFormat: "pdf" }) }));
    expect(p2026.format).toBe("none");
  });

  test("EC-DOC-75 T-EC-075 PDF_NEEDS_CONSENT without consent: a PDF-only electronic hand-over is blocked; E-Rechnung or paper allowed", () => {
    expect(markErrors(mark({ artifactIds: ["a3"] }))).toEqual(["pdf_consent_required"]);
    expect(markErrors(mark({ artifactIds: ["a1"] }))).toEqual([]);
    expect(markErrors(mark({ artifactIds: ["a2"], channel: "upload_portal" }))).toEqual([]);
    for (const channel of ["post", "hand"] as const) {
      expect(markErrors(mark({ artifactIds: ["a3"], channel })), channel).toEqual([]);
    }
    // once the consent is captured (with its source) the PDF may be e-mailed
    const consent = { givenAt: "2026-10-12", source: "email" as const, recordedAt: 1 };
    expect(markErrors(mark({ artifactIds: ["a3"] }), markCtx({ consents: [consent] }))).toEqual([]);
  });

  test("EC-DOC-113 T-EC-113 MUST_E: post/hand only or a PDF Lesefassung/plain PDF is refused; ZUGFeRD/XML electronically or confirmed other is fine; a later postal mark is allowed", () => {
    const mustE = markCtx({ decision: "MUST_E" });
    expect(markErrors(mark({ channel: "post", artifactIds: ["a1"] }), mustE)).toEqual([
      "must_e_channel_not_electronic",
    ]);
    expect(markErrors(mark({ channel: "hand", artifactIds: ["a1"] }), mustE)).toEqual([
      "must_e_channel_not_electronic",
    ]);
    expect(markErrors(mark({ artifactIds: ["a4"] }), mustE)).toEqual(["pdf_not_allowed_must_e"]);
    expect(markErrors(mark({ artifactIds: ["a3"] }), mustE)).toEqual(["pdf_not_allowed_must_e"]);
    expect(markErrors(mark({ artifactIds: ["a1"] }), mustE)).toEqual([]);
    expect(markErrors(mark({ channel: "upload_portal", artifactIds: ["a2"] }), mustE)).toEqual([]);
    expect(
      markErrors(
        mark({ channel: "other", note: "Kundenportal", electronicConfirmed: true, artifactIds: ["a2"] }),
        mustE,
      ),
    ).toEqual([]);
    const first: SendLogRow = { id: "s1", kind: "mark_sent", sentOn: "2026-10-05", channel: "email_manual", at: 1 };
    const later = validateMarkSent(
      mark({ channel: "post", artifactIds: ["a3"] }),
      markCtx({ decision: "MUST_E", sendLog: [first] }),
    );
    expect(later.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(later.firstEffective).toBe(false);
  });

  test("EC-DOC-114 T-EC-114 a second mark is appended with a warning; retracting re-derives or returns to finalized; blocked by a dependent reminder", () => {
    const m1: SendLogRow = { id: "s1", kind: "mark_sent", sentOn: "2026-10-05", channel: "email_manual", at: 1 };
    const second = validateMarkSent(
      mark({ sentOn: "2026-10-08", channel: "post", artifactIds: ["a1"] }),
      markCtx({ sendLog: [m1] }),
    );
    expect(second.findings.map((f) => [f.code, f.severity])).toEqual([["already_marked_sent", "W"]]);
    expect(second.firstEffective).toBe(false);
    const m2: SendLogRow = { id: "s2", kind: "mark_sent", sentOn: "2026-10-08", channel: "post", at: 2 };
    // status, sentOn and Zugang stay those of the first mark
    expect(sentStateOf([m1, m2], 3)).toMatchObject({
      status: "sent",
      sentOn: "2026-10-05",
      zugang: { date: "2026-10-05" },
    });
    const r = validateRetraction({ retractsId: "s1", reason: "Falsches Datum erfasst" }, [m1, m2], {
      postalDeliveryDays: 3,
      at: 3,
    });
    expect(r.findings).toEqual([]);
    expect(r.next).toMatchObject({
      status: "sent",
      sentOn: "2026-10-08",
      zugang: { date: "2026-10-11", basis: "post" },
    });
    const only = validateRetraction({ retractsId: "s1", reason: "Doch nicht versendet" }, [m1], {
      postalDeliveryDays: 3,
      at: 3,
    });
    expect(only.next).toEqual({ status: "finalized" });
    const blocked = validateRetraction({ retractsId: "s1", reason: "Falsches Datum erfasst" }, [m1], {
      postalDeliveryDays: 3,
      at: 3,
      dependent: "Zahlungserinnerung MA-2026-0001",
    });
    expect(blocked.findings.map((f) => f.code)).toEqual(["retraction_blocked_dependent"]);
    // retracting the non-effective second mark is not blocked by the reminder
    expect(
      validateRetraction({ retractsId: "s2", reason: "Doppelt erfasst" }, [m1, m2], {
        postalDeliveryDays: 3,
        at: 3,
        dependent: "Zahlungserinnerung MA-2026-0001",
      }).findings,
    ).toEqual([]);
  });

  test("EC-DOC-115 T-EC-115 a mark with another document's artifact ID or a sha256 that differs from the archive is rejected", () => {
    const foreign = validateMarkSent(mark({ artifactIds: ["other-doc-artifact"] }), markCtx());
    expect(foreign.findings.map((f) => f.code)).toEqual(["mark_sent_artifact_unknown"]);
    expect(foreign.findings[0]?.severity).toBe("E");
    expect(markErrors(mark({ suppliedSha256: { a1: "0".repeat(64) } }))).toEqual(["mark_sent_artifact_unknown"]);
    expect(markErrors(mark({ suppliedSha256: { a1: "h1" } }))).toEqual([]);
  });
});
