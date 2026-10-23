import { describe, expect, test } from "vitest";
import { validateRetraction } from "../documents/dispatch";
import type { CalendarDate } from "../time/calendar-date";
import {
  CORRECTION_MESSAGES,
  correctionLetterSubject,
  correctionLetterText,
  correctionReasons,
  validateCorrectionMark,
} from "./correction-request";

const today = "2026-10-23" as CalendarDate;
const findings = [
  { ruleId: "BR-DE-15", text: "Leitweg-ID (BT-10) fehlt.", category: "business_rule" as const },
  { ruleId: "BR-CO-10", text: "Summe der Positionen stimmt nicht.", category: "content" as const },
];

describe("supplier correction request (INB-046)", () => {
  test("INB-046 EC-103 EC-INB-08 a request is offered for findings, „keine E-Rechnung“ or the wrong addressee — not for „nicht geprüft“", () => {
    expect(
      correctionReasons({ validation: { acceptable: true, findings: [] }, notEInvoice: false, warnings: [] }),
    ).toBeNull();
    expect(
      correctionReasons({
        validation: { acceptable: false, unavailable: true, findings: [] },
        notEInvoice: false,
        warnings: [],
      }),
    ).toBeNull();
    expect(
      correctionReasons({ validation: { acceptable: false, findings }, notEInvoice: false, warnings: [] }),
    ).toEqual({
      findings,
      notEInvoice: false,
    });
    expect(correctionReasons({ notEInvoice: true, warnings: [] })).toEqual({ findings: [], notEInvoice: true });
    expect(
      correctionReasons({
        notEInvoice: false,
        warnings: [
          { code: "einvoice_wrong_addressee", message: "Die Rechnung ist nicht an Ihr Unternehmen adressiert." },
        ],
      }),
    ).toEqual({
      findings: [],
      notEInvoice: false,
      wrongAddressee: "Die Rechnung ist nicht an Ihr Unternehmen adressiert.",
    });
  });

  test("INB-046 EC-103 the German letter lists supplier, invoice number/date, the findings with BMF category and rule ID, the requested correction and our receiving address", () => {
    const text = correctionLetterText({
      company: { name: "Muster GmbH", addressLines: ["Hauptstraße 1", "10115 Berlin"], city: "Berlin" },
      supplier: { name: "Lieferant AG", addressLines: ["Ring 2", "80331 München"] },
      invoice: { number: "R-4711", date: "2026-10-01" },
      reasons: { findings, notEInvoice: false },
      receivingAddress: "belege@in.example.de",
      today,
    });
    expect(text).toContain("Lieferant AG\nRing 2\n80331 München");
    expect(text).toContain("Berlin, 23.10.2026");
    expect(text).toContain("Bitte um Rechnungskorrektur – Ihre Rechnung Nr. R-4711 vom 01.10.2026");
    expect(text).toContain("– Geschäftsregelfehler (BR-DE-15): Leitweg-ID (BT-10) fehlt.");
    expect(text).toContain("– Inhaltsfehler (BR-CO-10): Summe der Positionen stimmt nicht.");
    expect(text).toContain("eine berichtigte Rechnung (Berichtigung nach § 31 Abs. 5 UStDV)");
    expect(text).not.toContain("XRechnung oder ZUGFeRD");
    expect(text).toContain("Bitte senden Sie die korrigierte Rechnung an belege@in.example.de.");
    expect(text.endsWith("Mit freundlichen Grüßen\n\nMuster GmbH")).toBe(true);
    // „keine E-Rechnung“ and the wrong addressee ask for the format and our name/address.
    const other = correctionLetterText({
      company: { name: "Muster GmbH", addressLines: [] },
      supplier: { name: "Lieferant AG", addressLines: [] },
      invoice: {},
      reasons: {
        findings: [],
        notEInvoice: true,
        wrongAddressee: "Die Rechnung ist nicht an Ihr Unternehmen adressiert.",
      },
      today,
    });
    expect(other).toContain("keine E-Rechnung im Sinne des § 14 UStG");
    expect(other).toContain("XRechnung oder ZUGFeRD ab Profil EN 16931");
    expect(other).toContain("unserem vollständigen Namen und unserer Anschrift als Leistungsempfänger");
    expect(other).not.toContain("Bitte senden Sie");
    expect(correctionLetterSubject({})).toBe("Bitte um Rechnungskorrektur – Ihre Rechnung");
  });

  test("INB-046 MAIL-02 „Als versendet markieren“: sentOn ≤ today, a note for „other“, the archived letter is required", () => {
    expect(validateCorrectionMark({ sentOn: today, channel: "post" }, { today, letterArchived: true })).toEqual([]);
    const codes = (input: Parameters<typeof validateCorrectionMark>[0], letterArchived = true) =>
      validateCorrectionMark(input, { today, letterArchived }).map((f) => f.message);
    expect(codes({ sentOn: "2026-10-24", channel: "post" })).toEqual([
      "Das Versanddatum darf nicht in der Zukunft liegen.",
    ]);
    expect(codes({ sentOn: today, channel: "other", note: " " })).toEqual([
      "Bitte beschreiben, wie das Dokument übermittelt wurde.",
    ]);
    expect(codes({ sentOn: today, channel: "other", note: "Lieferantenportal-Chat" })).toEqual([]);
    expect(codes({ sentOn: today, channel: "email_manual" }, false)).toEqual([CORRECTION_MESSAGES.letterMissing]);
    // Retractions follow the F04 sendLog rules (reason ≥ 10 characters, target must be an un-retracted mark).
    const rows = [{ id: "s1", kind: "mark_sent" as const, sentOn: today, channel: "post" as const, at: 1 }];
    expect(
      validateRetraction({ retractsId: "s1", reason: "kurz" }, rows, { postalDeliveryDays: 3, at: 2 }).findings[0]
        ?.code,
    ).toBe("retraction_reason_required");
    expect(
      validateRetraction({ retractsId: "s1", reason: "falscher Empfänger gewählt" }, rows, {
        postalDeliveryDays: 3,
        at: 2,
      }).findings,
    ).toEqual([]);
  });
});
