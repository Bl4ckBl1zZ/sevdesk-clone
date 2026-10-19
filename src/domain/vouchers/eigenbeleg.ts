/**
 * Eigenbeleg for lost or unobtainable receipts (F06 VOU-063, GOBD-07; EC-EIG-01…04).
 *
 * Date, recipient (name/address), amount, purpose and the reason why no original exists (`lost`, `not_obtainable`
 * e.g. a parking meter, `other` + text) — approved by the owner, rendered as PDF with SHA-256 and immutable from then
 * on. The tax rule is forced to `no_input_vat`: an Eigenbeleg is not an invoice (§14 UStG) and gives no input-VAT
 * deduction (EC-EIG-01). Pure.
 */

import { formatMoneyDe } from "../banking/amount";
import type { EigenbelegContent } from "../banking/eigenbeleg";
import { type Issue, issue } from "../result";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";

export type EigenbelegReason = "lost" | "not_obtainable" | "other";

export interface EigenbelegData {
  reason: EigenbelegReason;
  reasonText?: string;
  recipient: string;
  purpose: string;
  approvedAt?: number;
}

export const EIGENBELEG_REASON_DE: Readonly<Record<EigenbelegReason, string>> = {
  lost: "Originalbeleg verloren",
  not_obtainable: "Beleg nicht erhältlich (z. B. Parkautomat)",
  other: "Sonstiger Grund",
};

export const EIGENBELEG_MESSAGES = {
  inputVat: "Aus Eigenbelegen ist kein Vorsteuerabzug möglich.",
  fields: "Bitte Empfänger, Zweck und Grund für das Fehlen des Originalbelegs angeben.",
  approved: "Der Eigenbeleg ist freigegeben und unveränderbar.",
  notApproved: "Bitte zuerst den Eigenbeleg freigeben.",
  many: "Ungewöhnlich viele/hohe Eigenbelege – bitte nach Möglichkeit Originalbelege beschaffen.",
} as const;

export type EigenbelegIssue = Issue<"eigenbeleg_fields" | "eigenbeleg_input_vat" | "eigenbeleg_many">;

/** EC-EIG-02: recipient, purpose and reason (and the text for `other`) are required for the approval. */
export function checkEigenbelegApproval(data: EigenbelegData): EigenbelegIssue | null {
  const missing =
    !data.recipient.trim() || !data.purpose.trim() || (data.reason === "other" && !(data.reasonText ?? "").trim());
  return missing ? issue("eigenbeleg_fields", EIGENBELEG_MESSAGES.fields) : null;
}

/** EC-EIG-03: more than 5 Eigenbelege in the month (incl. this one) or more than 250 € → info. */
export function eigenbelegVolumeInfo(input: { countInMonth: number; grossEurCents: number }): EigenbelegIssue | null {
  return input.countInMonth > 5 || input.grossEurCents > 25_000
    ? issue("eigenbeleg_many", EIGENBELEG_MESSAGES.many)
    : null;
}

export function voucherEigenbelegContent(input: {
  data: EigenbelegData;
  date: string;
  grossCents: number;
  currency: string;
  company: { name: string };
  internalNumber?: string;
  createdOn: string;
  createdBy: string;
}): EigenbelegContent {
  const d = input.data;
  const rows: [string, string][] = [
    ["Datum der Ausgabe", formatGermanDate(input.date as CalendarDate)],
    ["Betrag", formatMoneyDe(input.grossCents, input.currency)],
    ["Empfänger", d.recipient.trim()],
    ["Zweck", d.purpose.trim()],
    [
      "Grund",
      d.reason === "other"
        ? `${EIGENBELEG_REASON_DE.other}: ${d.reasonText?.trim() ?? ""}`
        : EIGENBELEG_REASON_DE[d.reason],
    ],
  ];
  if (input.internalNumber) rows.push(["Belegnummer", input.internalNumber]);
  rows.push(["Freigegeben am", `${formatGermanDate(input.createdOn as CalendarDate)} von ${input.createdBy}`]);
  return {
    title: "Ersatzbeleg für einen fehlenden Originalbeleg",
    fileName: `Eigenbeleg-${input.date}-${input.grossCents}.pdf`,
    rows,
    statement:
      "Ein Originalbeleg liegt nicht vor. Die Angaben wurden vom Unternehmer nach bestem Wissen gemacht und freigegeben. Aus einem Eigenbeleg ist kein Vorsteuerabzug möglich.",
  };
}
