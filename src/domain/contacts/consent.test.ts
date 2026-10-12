import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import {
  certificateExpiresSoon,
  certificateGate,
  consentValidOn,
  currentCertificate,
  type PdfConsent,
  pdfOnlyAllowed,
  revocationTarget,
  validateCertificate,
  validateConsent,
} from "./consent";

const today = calendarDate("2026-10-12");

describe("CON-081 CON-082 PDF consent (MAIL-01)", () => {
  test("T-CON-042 CON-081 tacit without note → CONSENT_NOTE_REQUIRED; future givenAt → DATE_IN_FUTURE", () => {
    expect(validateConsent({ givenAt: "2026-02-03", source: "tacit" }, today).errors[0]).toMatchObject({
      code: "CONSENT_NOTE_REQUIRED",
      message: "Bitte beschreiben, woraus sich die stillschweigende Zustimmung ergibt.",
    });
    expect(validateConsent({ givenAt: "2026-10-13", source: "email" }, today).errors[0]?.message).toBe(
      "Das Datum der Zustimmung darf nicht in der Zukunft liegen.",
    );
    expect(
      validateConsent({ givenAt: "2026-02-03", source: "tacit", note: "zahlt seit 2024 PDF-Rechnungen" }, today).errors,
    ).toEqual([]);
  });

  test("T-CON-016 CON-E16 CON-E17 consent 2026-02-03, revoked 2026-09-01: 08-15 PDF allowed, 09-02 not", () => {
    const history: PdfConsent[] = [{ givenAt: "2026-02-03", source: "email", revokedAt: "2026-09-01", recordedAt: 1 }];
    expect(pdfOnlyAllowed("PDF_NEEDS_CONSENT", history, "2026-08-15")).toBe(true);
    expect(pdfOnlyAllowed("PDF_NEEDS_CONSENT", history, "2026-09-02")).toBe(false);
    expect(pdfOnlyAllowed("PDF_NEEDS_CONSENT", history, "2026-02-02")).toBe(false);
    expect(consentValidOn(history, "2026-09-01")).toBeUndefined();
  });

  test("T-CON-043 CON-082 NOT_REQUIRED / MAY_PAPER_OR_PDF offer PDF without consent; MUST_E never", () => {
    expect(pdfOnlyAllowed("NOT_REQUIRED", [], "2026-10-12")).toBe(true);
    expect(pdfOnlyAllowed("MAY_PAPER_OR_PDF", [], "2026-10-12")).toBe(true);
    expect(pdfOnlyAllowed("MUST_E", [{ givenAt: "2026-01-01", source: "email", recordedAt: 1 }], "2026-10-12")).toBe(
      false,
    );
  });

  test("CON-081 revocation keeps the history and targets the active consent", () => {
    const history: PdfConsent[] = [
      { givenAt: "2025-01-01", source: "contract", revokedAt: "2025-06-01", recordedAt: 1 },
      { givenAt: "2026-02-03", source: "email", recordedAt: 2 },
    ];
    expect(revocationTarget(history, calendarDate("2026-09-01"), today)).toEqual({ index: 1 });
    expect(revocationTarget(history, calendarDate("2026-10-13"), today)).toMatchObject({
      error: { code: "DATE_IN_FUTURE" },
    });
    expect(revocationTarget(history, calendarDate("2026-01-01"), today)).toMatchObject({
      error: { code: "REVOKED_BEFORE_GIVEN" },
    });
    expect(revocationTarget(history.slice(0, 1), calendarDate("2026-09-01"), today)).toMatchObject({
      error: { code: "NO_ACTIVE_CONSENT" },
    });
  });
});

describe("CON-070 … CON-072 §13b certificates (UST-22)", () => {
  test("CON-070 §5.6 file type and size; expired at upload → warning", () => {
    expect(
      validateCertificate(
        { validUntil: "2029-09-30", file: { bytes: 11 * 1024 * 1024, mime: "application/pdf" } },
        today,
      ).errors[0]?.message,
    ).toBe("Bitte PDF, JPG oder PNG bis 10 MB hochladen.");
    expect(
      validateCertificate({ validUntil: "2029-09-30", file: { bytes: 10, mime: "text/plain" } }, today).errors,
    ).toHaveLength(1);
    expect(validateCertificate({ validUntil: "2026-01-01" }, today).warnings[0]?.message).toBe(
      "Die Bescheinigung ist bereits abgelaufen.",
    );
  });

  test("T-CON-044 CON-072 the latest unreplaced entry is current; earlier entries stay as evidence", () => {
    const history = [
      {
        validUntil: "2026-09-30",
        addedAt: 1,
        replacedAt: 5,
        file: { sha256: "aa", bytes: 1, mime: "application/pdf" },
      },
      { validUntil: "2029-09-30", addedAt: 5, file: { sha256: "bb", bytes: 1, mime: "application/pdf" } },
    ];
    expect(currentCertificate(history)?.file?.sha256).toBe("bb");
    expect(history).toHaveLength(2);
  });

  test("T-CON-017 CON-E18 certificate valid until 2026-09-30, supply 2026-10-05 → confirmation needed", () => {
    const history = [{ validUntil: "2026-09-30", addedAt: 1 }];
    const g = certificateGate(history, "2026-10-05");
    expect(g).toMatchObject({ kind: "needs_confirmation", reason: "expired" });
    expect(g.kind === "needs_confirmation" && g.message).toContain("nur bis 30.09.2026 gültig");
    expect(certificateGate(history, "2026-09-30").kind).toBe("ok");
    expect(certificateGate([], "2026-09-30")).toMatchObject({ reason: "missing" });
  });

  test("CON-071 notification 30 days before expiry", () => {
    expect(certificateExpiresSoon([{ validUntil: "2026-11-10", addedAt: 1 }], today)).toBe(true);
    expect(certificateExpiresSoon([{ validUntil: "2026-11-12", addedAt: 1 }], today)).toBe(false);
    expect(certificateExpiresSoon([{ validUntil: "2026-10-01", addedAt: 1 }], today)).toBe(false);
  });
});
