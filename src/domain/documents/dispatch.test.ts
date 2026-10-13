import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import {
  type ArchivedArtifact,
  checkOriginalReexport,
  defaultMarkSelection,
  effectiveMark,
  exportedNotMarkedDue,
  exportFileName,
  exportFiles,
  type MarkSentContext,
  type MarkSentInput,
  type SendChannel,
  type SendLogRow,
  sentStateOf,
  validateMarkSent,
  validateRetraction,
  zugangFor,
} from "./dispatch";
import type { Er03Decision } from "./snapshot";

const TODAY = "2026-10-12" as CalendarDate;
const ZUGFERD: ArchivedArtifact = {
  id: "a1",
  kind: "zugferd_pdf",
  variant: "original",
  sha256: "h1",
  name: "RE-2026-0042.pdf",
};
const XML: ArchivedArtifact = { id: "a2", kind: "xrechnung_xml", sha256: "h2", name: "RE-2026-0042.xml" };
const PLAIN: ArchivedArtifact = { id: "a3", kind: "pdf", variant: "original", sha256: "h3", name: "RE-2026-0042.pdf" };
const READING: ArchivedArtifact = {
  id: "a4",
  kind: "pdf",
  variant: "reading",
  sha256: "h4",
  name: "RE-2026-0042_Lesefassung.pdf",
};

const ctx = (patch: Partial<MarkSentContext> = {}): MarkSentContext => ({
  today: TODAY,
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
  sentOn: TODAY,
  channel: "email_manual",
  artifactIds: ["a1"],
  ...patch,
});
const codes = (i: MarkSentInput, c: MarkSentContext = ctx()) => validateMarkSent(i, c).findings.map((f) => f.code);
const CONSENT = { givenAt: "2026-01-01", source: "email" as const, recordedAt: 0 };

describe("mark-sent matrix (F04 App. D.3, T-TAB-04)", () => {
  // decision × channel × files (structured yes/no) × consent → expected blocking code / warning / ok
  const channels: SendChannel[] = ["email_manual", "upload_portal", "other", "post", "hand"];
  const decisions: Er03Decision[] = ["MUST_E", "PDF_NEEDS_CONSENT", "MAY_PAPER_OR_PDF", "NOT_REQUIRED"];
  for (const decision of decisions) {
    for (const channel of channels) {
      for (const structured of [true, false]) {
        for (const consent of [true, false]) {
          const electronic = channel !== "post" && channel !== "hand";
          let expected: string[];
          if (decision === "MUST_E") {
            expected = [];
            if (!electronic) expected.push("must_e_channel_not_electronic");
            if (!structured) expected.push("pdf_not_allowed_must_e");
          } else if (!structured && electronic && !consent) {
            expected = decision === "PDF_NEEDS_CONSENT" ? ["pdf_consent_required"] : ["pdf_consent_tacit"];
          } else {
            expected = [];
          }
          test(`SND-03 SND-17 MAIL-01 ER-03 ${decision} · ${channel} · ${structured ? "E-Rechnung" : "nur PDF"} · ${consent ? "Zustimmung" : "keine Zustimmung"} → ${expected.join(", ") || "ok"}`, () => {
            const input = mark({
              channel,
              artifactIds: [structured ? "a1" : "a3"],
              ...(channel === "other" ? { note: "Per Messenger übermittelt", electronicConfirmed: true } : {}),
            });
            expect(codes(input, ctx({ decision, consents: consent ? [CONSENT] : [] }))).toEqual(expected);
          });
        }
      }
    }
  }

  test("SND-17 EC-197 MUST_E via „Sonstiges“ needs the electronic confirmation", () => {
    expect(codes(mark({ channel: "other", note: "über Portal" }), ctx({ decision: "MUST_E" }))).toEqual([
      "must_e_electronic_confirmation_missing",
    ]);
    const ok = validateMarkSent(
      mark({ channel: "other", note: "über Portal", electronicConfirmed: true }),
      ctx({ decision: "MUST_E" }),
    );
    expect(ok.einvoiceHandedOverElectronically).toBe(true);
  });

  test("SND-17 a Lesefassung alone does not count as the e-invoice; later marks may use any channel", () => {
    expect(codes(mark({ artifactIds: ["a4"] }), ctx({ decision: "MUST_E" }))).toEqual(["pdf_not_allowed_must_e"]);
    const first: SendLogRow = { id: "s1", kind: "mark_sent", sentOn: "2026-10-05", channel: "email_manual", at: 1 };
    expect(
      codes(mark({ channel: "post", artifactIds: ["a3"] }), ctx({ decision: "MUST_E", sendLog: [first] })),
    ).toEqual(["already_marked_sent"]);
  });
});

describe("mark-sent dates, notes and files (§5.1.8)", () => {
  test("SND-07 EC-195 sentOn ≤ today and ≥ the finalisation date; backdating > 10 days needs a note", () => {
    expect(codes(mark({ sentOn: "2026-10-13" }))).toEqual(["mark_sent_date_future"]);
    expect(codes(mark({ sentOn: "2026-09-30" }))).toEqual(["mark_sent_date_before_finalization"]);
    const late = ctx({ finalizedOn: "2026-09-01" });
    expect(codes(mark({ sentOn: "2026-09-30" }), late)).toEqual(["mark_sent_backdate_note_required"]);
    expect(codes(mark({ sentOn: "2026-09-30", note: "Vergessen zu markieren" }), late)).toEqual([]);
    expect(codes(mark({ sentOn: "2026-10-02" }), late)).toEqual([]);
  });

  test("SND-07 channel other needs a note; at least one file; SND-22 unknown files or changed hashes are refused", () => {
    expect(codes(mark({ channel: "other", electronicConfirmed: true }))).toEqual(["mark_sent_note_required"]);
    expect(codes(mark({ artifactIds: [] }))).toEqual(["mark_sent_artifacts_missing"]);
    expect(codes(mark({ artifactIds: ["nope"] }))).toEqual(["mark_sent_artifact_unknown"]);
    expect(codes(mark({ suppliedSha256: { a1: "tampered" } }))).toEqual(["mark_sent_artifact_unknown"]);
    const r = validateMarkSent(mark({ artifactIds: ["a1", "a2"] }), ctx());
    expect(r.artifacts).toEqual([
      { artifactId: "a1", sha256: "h1" },
      { artifactId: "a2", sha256: "h2" },
    ]);
  });

  test("SND-10 marking is impossible while artifacts are pending or blocked", () => {
    expect(codes(mark(), ctx({ artifactStatus: "pending" }))).toEqual(["artifacts_not_ready"]);
    expect(codes(mark(), ctx({ artifactStatus: "blocked" }))).toEqual(["artifacts_blocked"]);
  });
});

describe("effective mark, Zugang and retraction (SND-18, SND-23)", () => {
  const m1: SendLogRow = { id: "s1", kind: "mark_sent", sentOn: "2026-10-05", channel: "post", at: 1 };
  const m2: SendLogRow = { id: "s2", kind: "mark_sent", sentOn: "2026-10-07", channel: "email_manual", at: 2 };

  test("SND-23 Zugang: e-mail/portal/hand = sentOn, post = + N days, other = + 3 days", () => {
    expect(zugangFor({ sentOn: "2026-10-05", channel: "email_manual" }, 3)).toEqual({
      date: "2026-10-05",
      basis: "email_manual",
    });
    expect(zugangFor({ sentOn: "2026-10-05", channel: "hand" }, 3).date).toBe("2026-10-05");
    expect(zugangFor({ sentOn: "2026-10-05", channel: "upload_portal" }, 3).date).toBe("2026-10-05");
    expect(zugangFor({ sentOn: "2026-10-05", channel: "post" }, 4).date).toBe("2026-10-09");
    expect(zugangFor({ sentOn: "2026-10-05", channel: "other" }, 7).date).toBe("2026-10-08");
  });

  test("SND-18 the earliest non-retracted mark is effective; later marks never change status or Zugang", () => {
    expect(effectiveMark([m2, m1])?.id).toBe("s1");
    expect(sentStateOf([m1, m2], 3)).toEqual({
      status: "sent",
      sentAt: 1,
      sentOn: "2026-10-05",
      zugang: { date: "2026-10-08", basis: "post" },
    });
    expect(sentStateOf([], 3)).toEqual({ status: "finalized" });
  });

  test("SND-18 retracting the effective mark re-derives from the next mark, or returns to finalized", () => {
    const r = validateRetraction({ retractsId: "s1", reason: "Falsches Datum erfasst" }, [m1, m2], {
      postalDeliveryDays: 3,
      at: 3,
    });
    expect(r.findings).toEqual([]);
    expect(r.wasEffective).toBe(true);
    expect(r.next).toMatchObject({ status: "sent", sentOn: "2026-10-07", zugang: { date: "2026-10-07" } });
    const last = validateRetraction({ retractsId: "s1", reason: "Doch nicht versendet" }, [m1], {
      postalDeliveryDays: 3,
      at: 3,
    });
    expect(last.next).toEqual({ status: "finalized" });
  });

  test("SND-18 EC-198 reason ≥ 10 characters, valid target, blocked when a later act depends on the mark", () => {
    const codesOf = (r: ReturnType<typeof validateRetraction>) => r.findings.map((f) => f.code);
    expect(
      codesOf(validateRetraction({ retractsId: "s1", reason: "kurz" }, [m1], { postalDeliveryDays: 3, at: 3 })),
    ).toEqual(["retraction_reason_required"]);
    const retracted: SendLogRow = {
      id: "r1",
      kind: "retraction",
      retractsId: "s1",
      sentOn: "2026-10-05",
      channel: "post",
      at: 2,
    };
    expect(
      codesOf(
        validateRetraction({ retractsId: "s1", reason: "noch einmal zurück" }, [m1, retracted], {
          postalDeliveryDays: 3,
          at: 3,
        }),
      ),
    ).toEqual(["retraction_target_invalid"]);
    expect(
      codesOf(
        validateRetraction({ retractsId: "s1", reason: "Falsches Datum erfasst" }, [m1], {
          postalDeliveryDays: 3,
          at: 3,
          dependent: "Mahnung MA-2026-0001",
        }),
      ),
    ).toEqual(["retraction_blocked_dependent"]);
  });
});

describe("export (SND-05, SND-16, DOC-32, §4.10.2)", () => {
  test("SND-02 default export per format, originals while unmarked, Kopie once marked", () => {
    expect(exportFiles("zugferd_en16931", "default", false)).toEqual([{ kind: "zugferd_pdf", variant: "original" }]);
    expect(exportFiles("zugferd_en16931", "zip", false)).toEqual([
      { kind: "zugferd_pdf", variant: "original" },
      { kind: "xrechnung_xml", variant: "original" },
    ]);
    expect(exportFiles("zugferd_en16931", "default", true)).toEqual([{ kind: "zugferd_pdf", variant: "copy" }]);
    expect(exportFiles("xrechnung_ubl", "default", false)).toEqual([{ kind: "xrechnung_xml", variant: "original" }]);
    expect(exportFiles("xrechnung_ubl", "xrechnung_with_reading", false)).toEqual([
      { kind: "xrechnung_xml", variant: "original" },
      { kind: "pdf", variant: "reading" },
    ]);
    expect(exportFiles("none", "default", true)).toEqual([{ kind: "pdf", variant: "copy" }]);
  });

  test("SND-02 file names replace / with -", () => {
    expect(exportFileName("RE/2026/42", { kind: "zugferd_pdf", variant: "original" })).toBe("RE-2026-42.pdf");
    expect(exportFileName("RE-1", { kind: "xrechnung_xml", variant: "original" })).toBe("RE-1.xml");
    expect(exportFileName("RE-1", { kind: "pdf", variant: "reading" })).toBe("RE-1_Lesefassung.pdf");
  });

  test("SND-05 EC-099 an original re-export after the mark needs a reason", () => {
    expect(checkOriginalReexport(true, true, "")?.code).toBe("resend_original_reason");
    expect(checkOriginalReexport(true, true, "Kunde hat Original verloren")).toBeNull();
    expect(checkOriginalReexport(false, true, "")).toBeNull();
  });

  test("SND-07 the mark dialog preselects the files of the latest unmarked export", () => {
    expect(defaultMarkSelection("zugferd_en16931", [ZUGFERD, XML], ["a2"])).toEqual(["a2"]);
    expect(defaultMarkSelection("zugferd_en16931", [ZUGFERD, XML], undefined)).toEqual(["a1"]);
  });
});

describe("to-do „Exportiert, aber nicht als versendet markiert“ (SND-21)", () => {
  test("SND-21 EC-196 due 2 Berlin calendar days after the first export without an effective mark", () => {
    const base = { firstExportedOn: "2026-10-10", status: "finalized", hasEffectiveMark: false };
    expect(exportedNotMarkedDue({ ...base, today: "2026-10-11" as CalendarDate })).toBe(false);
    expect(exportedNotMarkedDue({ ...base, today: "2026-10-12" as CalendarDate })).toBe(true);
    expect(exportedNotMarkedDue({ ...base, hasEffectiveMark: true, today: TODAY })).toBe(false);
    expect(exportedNotMarkedDue({ ...base, status: "cancelled", today: TODAY })).toBe(false);
    expect(exportedNotMarkedDue({ ...base, firstExportedOn: undefined, today: TODAY })).toBe(false);
  });
});
