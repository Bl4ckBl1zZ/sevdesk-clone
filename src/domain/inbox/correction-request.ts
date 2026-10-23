/**
 * F06 INB-046 „Korrektur anfordern“ (B2: the app never sends e-mail; MAIL-02, ER-02, GOBD-20). Pure; `today` passed in.
 *
 *  correctionReasons        why a received invoice needs a correction: validation findings (EC-INB-11, EC-103,
 *                           BMF 15.10.2025 categories), „keine E-Rechnung“ (EC-INB-09/10) or the wrong addressee
 *                           (EC-INB-08); none → no request offered
 *  correctionLetterText     the German letter „Bitte um Rechnungskorrektur“ from a fixed template
 *  validateCorrectionMark   „Als versendet markieren“ — same rules, codes and texts as the F04 sendLog marks
 *                           (sentOn ≤ today, note mandatory for `other`, the archived letter must be referenced)
 * Retractions reuse `validateRetraction` from src/domain/documents/dispatch.ts.
 */

import { SEND_CHANNELS, type SendChannel } from "../documents/dispatch";
import { type Finding, finding } from "../documents/validate/finding";
import { CATEGORY_LABEL_DE } from "../einvoice/verdict";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";

export type CorrectionFindingCategory = "format" | "business_rule" | "content";

export interface CorrectionFinding {
  ruleId: string;
  text: string;
  category: CorrectionFindingCategory;
}

export interface CorrectionReasons {
  findings: CorrectionFinding[];
  notEInvoice: boolean;
  /** The addressee warning text (EC-INB-08), if any. */
  wrongAddressee?: string;
}

export const CORRECTION_MESSAGES = {
  notAvailable: "Für diesen Beleg liegt kein Prüfbefund vor – eine Korrekturanforderung ist nicht nötig.",
  letterMissing:
    "Bitte den Brief zuerst als PDF exportieren – die Versandmarkierung verweist auf das archivierte Schreiben.",
} as const;

/** Reasons for a correction request; null when there is nothing to correct. */
export function correctionReasons(input: {
  validation?: { acceptable: boolean; unavailable?: boolean; findings: readonly CorrectionFinding[] } | undefined;
  notEInvoice: boolean;
  warnings: readonly { code: string; message: string }[];
}): CorrectionReasons | null {
  const v = input.validation;
  // „nicht geprüft“ (sidecar down) is no finding of the supplier.
  const findings = v && !v.acceptable && !v.unavailable ? [...v.findings] : [];
  const wrongAddressee = input.warnings.find((w) => w.code === "einvoice_wrong_addressee")?.message;
  if (findings.length === 0 && !input.notEInvoice && !wrongAddressee) return null;
  return { findings, notEInvoice: input.notEInvoice, ...(wrongAddressee ? { wrongAddressee } : {}) };
}

export interface CorrectionLetterInput {
  company: { name: string; addressLines: readonly string[]; city?: string };
  supplier: { name: string; addressLines: readonly string[] };
  invoice: { number?: string; date?: string };
  reasons: CorrectionReasons;
  /** INB-011 receiving address for the corrected invoice. */
  receivingAddress?: string;
  today: CalendarDate;
}

export const CORRECTION_SUBJECT = "Bitte um Rechnungskorrektur";

export function correctionLetterSubject(invoice: CorrectionLetterInput["invoice"]): string {
  const no = invoice.number ? ` Nr. ${invoice.number}` : "";
  const date = invoice.date ? ` vom ${formatGermanDate(invoice.date as CalendarDate)}` : "";
  return `${CORRECTION_SUBJECT} – Ihre Rechnung${no}${date}`;
}

/** The letter as plain text (copy to clipboard; the PDF prints the same lines). */
export function correctionLetterText(input: CorrectionLetterInput): string {
  const { reasons } = input;
  const issues: string[] = [
    ...reasons.findings.map((f) => `– ${CATEGORY_LABEL_DE[f.category]} (${f.ruleId}): ${f.text}`),
    ...(reasons.notEInvoice && !reasons.findings.some((f) => f.category === "format")
      ? ["– Die Rechnung ist keine E-Rechnung im Sinne des § 14 UStG (kein strukturiertes Format nach EN 16931)."]
      : []),
    ...(reasons.wrongAddressee ? [`– ${reasons.wrongAddressee}`] : []),
  ];
  const wantFormat = reasons.notEInvoice || reasons.findings.some((f) => f.category === "format");
  const wantCorrection = reasons.findings.some((f) => f.category !== "format");
  const requests = [
    ...(wantFormat
      ? ["– eine E-Rechnung in einem zulässigen strukturierten Format (XRechnung oder ZUGFeRD ab Profil EN 16931)"]
      : []),
    ...(wantCorrection
      ? ["– eine berichtigte Rechnung (Berichtigung nach § 31 Abs. 5 UStDV) bzw. Stornierung und Neuausstellung"]
      : []),
    ...(reasons.wrongAddressee
      ? ["– eine Rechnung mit unserem vollständigen Namen und unserer Anschrift als Leistungsempfänger"]
      : []),
  ];
  const place = input.company.city ? `${input.company.city}, ` : "";
  return [
    input.company.name,
    ...input.company.addressLines,
    "",
    input.supplier.name,
    ...input.supplier.addressLines,
    "",
    `${place}${formatGermanDate(input.today)}`,
    "",
    correctionLetterSubject(input.invoice),
    "",
    "Sehr geehrte Damen und Herren,",
    "",
    "bei der Prüfung Ihrer oben genannten Rechnung haben wir Folgendes festgestellt:",
    "",
    ...issues,
    "",
    "Wir bitten Sie daher um",
    ...requests,
    "",
    ...(input.receivingAddress ? [`Bitte senden Sie die korrigierte Rechnung an ${input.receivingAddress}.`, ""] : []),
    "Den Vorsteuerabzug können wir erst geltend machen, wenn uns eine ordnungsgemäße Rechnung vorliegt.",
    "",
    "Mit freundlichen Grüßen",
    "",
    input.company.name,
  ].join("\n");
}

export interface CorrectionMarkInput {
  sentOn: string;
  channel: SendChannel;
  note?: string | undefined;
}

/** „Als versendet markieren“ for a correction letter (codes and texts as F04 `validateMarkSent`). */
export function validateCorrectionMark(
  input: CorrectionMarkInput,
  ctx: { today: CalendarDate; letterArchived: boolean },
): Finding[] {
  const out: Finding[] = [];
  const note = (input.note ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sentOn)) {
    out.push(
      finding("mark_sent_date_invalid", "E", "MAIL-02", "hinweise", "Bitte ein gültiges Versanddatum angeben.", {
        field: "sentOn",
      }),
    );
  } else if (input.sentOn > ctx.today) {
    out.push(
      finding(
        "mark_sent_date_future",
        "E",
        "MAIL-02",
        "hinweise",
        "Das Versanddatum darf nicht in der Zukunft liegen.",
        {
          field: "sentOn",
        },
      ),
    );
  }
  if (!SEND_CHANNELS.includes(input.channel)) {
    out.push(
      finding("mark_sent_channel_invalid", "E", "MAIL-02", "hinweise", "Bitte einen Versandweg wählen.", {
        field: "channel",
      }),
    );
  } else if (input.channel === "other" && !note) {
    out.push(
      finding(
        "mark_sent_note_required",
        "E",
        "MAIL-02",
        "hinweise",
        "Bitte beschreiben, wie das Dokument übermittelt wurde.",
        {
          field: "note",
        },
      ),
    );
  }
  if (!ctx.letterArchived) {
    out.push(
      finding("mark_sent_artifacts_missing", "E", "MAIL-02", "hinweise", CORRECTION_MESSAGES.letterMissing, {
        field: "artifactIds",
      }),
    );
  }
  return out;
}
