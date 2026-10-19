/**
 * Export and the manual sent mark (F04 §3.5 SND, §4.10, App. D.3; B2: the app never transmits documents).
 *
 *  - which archived artifacts an export entry serves, original vs. "Kopie" (SND-05, SND-16, DOC-32, §4.10.2)
 *  - `validateMarkSent` — the §5.1.8 codes incl. the MUST_E electronic-channel rule (SND-17, EC-197) and consent
 *  - the effective mark (earliest non-retracted `mark_sent` row), Zugang (SND-23) and retraction (SND-18)
 *  - the to-do rule „Exportiert, aber nicht als versendet markiert“ (SND-21)
 */
import { consentValidOn, type PdfConsent } from "../contacts/consent";
import { addDays, type CalendarDate, daysBetween, formatGermanDate } from "../time/calendar-date";
import type { EinvoiceFormat, Er03Decision } from "./snapshot";
import { type Finding, finding } from "./validate/finding";

export type SendChannel = "email_manual" | "post" | "hand" | "upload_portal" | "other";

export const SEND_CHANNELS: readonly SendChannel[] = ["email_manual", "post", "hand", "upload_portal", "other"];

export const SEND_CHANNEL_LABELS: Readonly<Record<SendChannel, string>> = {
  email_manual: "E-Mail (selbst versendet)",
  post: "Post",
  hand: "Persönlich übergeben",
  upload_portal: "Upload-Portal (z. B. ZRE, OZG-RE)",
  other: "Sonstiges",
};

export type ArtifactKind = "pdf" | "zugferd_pdf" | "xrechnung_xml";
export type ArtifactVariant = "original" | "copy" | "reading";

export interface ArchivedArtifact {
  readonly id: string;
  readonly kind: ArtifactKind | string;
  readonly variant?: ArtifactVariant | undefined;
  readonly sha256: string;
  readonly name?: string | undefined;
}

/** SND-17: a ZUGFeRD PDF or an XRechnung/structured XML counts as the e-invoice; a Lesefassung or plain PDF does not. */
export const isStructuredEinvoice = (a: Pick<ArchivedArtifact, "kind">): boolean =>
  a.kind === "zugferd_pdf" || a.kind === "xrechnung_xml";

// ── export entries (SND-16, §4.10.2) ────────────────────────────────────────────────────────────────────────────

export type ExportEntry = "default" | "zugferd_pdf" | "xml" | "xrechnung_with_reading" | "pdf" | "zip";

export interface ExportFileSpec {
  readonly kind: ArtifactKind;
  readonly variant: ArtifactVariant;
}

/** SND-09: postal sending via a letter service is out of scope in v1; the export menu only shows this hint. */
export const POSTAL_HINT = "Per Post: bitte ausdrucken und anschließend als versendet markieren (Kanal Post)";

/** Export menu entries offered for a format (non-invoice types and `none`: PDF only). */
export function exportEntriesFor(format: EinvoiceFormat): ExportEntry[] {
  if (format === "zugferd_en16931" || format === "zugferd_xrechnung") return ["zugferd_pdf", "xml", "zip"];
  if (format === "xrechnung_cii" || format === "xrechnung_ubl") return ["xml", "xrechnung_with_reading", "zip"];
  return ["pdf", "zip"];
}

export const EXPORT_ENTRY_LABELS: Readonly<Record<ExportEntry, string>> = {
  default: "Exportieren",
  zugferd_pdf: "E-Rechnung (ZUGFeRD-PDF)",
  xml: "Nur XML",
  xrechnung_with_reading: "XRechnung + Lesefassung (PDF)",
  pdf: "PDF",
  zip: "Alles als ZIP",
};

/**
 * Files of an export entry. `copy` = the document is marked as sent and no original re-export was requested: PDFs
 * are served as the "Kopie" variant (DOC-32); XML has no copy form and is always the archived original.
 */
export function exportFiles(format: EinvoiceFormat, entry: ExportEntry, copy: boolean): ExportFileSpec[] {
  const pdfVariant: ArtifactVariant = copy ? "copy" : "original";
  const zugferd = format === "zugferd_en16931" || format === "zugferd_xrechnung";
  const xrechnung = format === "xrechnung_cii" || format === "xrechnung_ubl";
  const e = entry === "default" ? (zugferd ? "zugferd_pdf" : xrechnung ? "xml" : "pdf") : entry;
  if (zugferd) {
    if (e === "xml") return [{ kind: "xrechnung_xml", variant: "original" }];
    if (e === "zip")
      return [
        { kind: "zugferd_pdf", variant: pdfVariant },
        { kind: "xrechnung_xml", variant: "original" },
      ];
    return [{ kind: "zugferd_pdf", variant: pdfVariant }];
  }
  if (xrechnung) {
    const reading: ExportFileSpec = { kind: "pdf", variant: copy ? "copy" : "reading" };
    if (e === "xrechnung_with_reading" || e === "zip") return [{ kind: "xrechnung_xml", variant: "original" }, reading];
    return [{ kind: "xrechnung_xml", variant: "original" }];
  }
  return [{ kind: "pdf", variant: pdfVariant }];
}

/** §4.10.2 file names: number with `/` → `-`. */
export function exportFileName(number: string, spec: ExportFileSpec): string {
  const stem = number.replaceAll("/", "-");
  if (spec.kind === "xrechnung_xml") return `${stem}.xml`;
  if (spec.variant === "reading") return `${stem}_Lesefassung.pdf`;
  if (spec.variant === "copy") return `${stem}_Kopie.pdf`;
  return `${stem}.pdf`;
}

export const zipFileName = (number: string): string => `${number.replaceAll("/", "-")}.zip`;

/** SND-05: once marked as sent, an original re-export needs a reason. */
export function checkOriginalReexport(
  marked: boolean,
  wantOriginal: boolean,
  reason: string | undefined,
): Finding | null {
  if (!marked || !wantOriginal || (reason ?? "").trim().length > 0) return null;
  return finding(
    "resend_original_reason",
    "E",
    "UST-34",
    "hinweise",
    "Bitte begründen, warum das Original erneut exportiert wird (wird protokolliert).",
    { field: "reason" },
  );
}

/** SND-10 */
export function checkArtifactsReady(status: "pending" | "ready" | "blocked" | undefined): Finding | null {
  if (status === "ready") return null;
  return status === "blocked"
    ? finding(
        "artifacts_blocked",
        "E",
        "ER-12",
        "e_rechnung",
        "Die E-Rechnung konnte nicht erzeugt werden – Export und Versand gesperrt.",
      )
    : finding("artifacts_not_ready", "E", "ER-12", "e_rechnung", "PDF/E-Rechnung wird noch erzeugt.");
}

// ── send log, effective mark, Zugang (SND-18, SND-23) ───────────────────────────────────────────────────────────

export interface SendLogRow {
  readonly id: string;
  readonly kind: "mark_sent" | "retraction";
  readonly retractsId?: string | undefined;
  readonly sentOn: string;
  readonly channel: SendChannel;
  readonly at: number;
}

/** The earliest (recording order) `mark_sent` row that has not been retracted. */
export function effectiveMark<T extends SendLogRow>(rows: readonly T[]): T | null {
  const retracted = new Set(rows.filter((r) => r.kind === "retraction").map((r) => r.retractsId));
  return (
    [...rows]
      .filter((r) => r.kind === "mark_sent" && !retracted.has(r.id))
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))[0] ?? null
  );
}

export interface Zugang {
  readonly date: string;
  readonly basis: SendChannel;
}

/** SND-23: e-mail, upload portal, hand → sentOn; post → sentOn + N (setting, default 3); other → sentOn + 3. */
export function zugangFor(mark: Pick<SendLogRow, "sentOn" | "channel">, postalDeliveryDays: number): Zugang {
  const days = mark.channel === "post" ? postalDeliveryDays : mark.channel === "other" ? 3 : 0;
  return { date: addDays(mark.sentOn as CalendarDate, days), basis: mark.channel };
}

export interface SentState {
  readonly status: "finalized" | "sent";
  readonly sentAt?: number;
  readonly sentOn?: string;
  readonly zugang?: Zugang;
}

/** Status, `sentAt`, `sentOn` and Zugang derived from the send log (SND-05, SND-18, SND-23). */
export function sentStateOf(rows: readonly SendLogRow[], postalDeliveryDays: number): SentState {
  const mark = effectiveMark(rows);
  if (!mark) return { status: "finalized" };
  return { status: "sent", sentAt: mark.at, sentOn: mark.sentOn, zugang: zugangFor(mark, postalDeliveryDays) };
}

// ── mark-sent validation (SND-03, SND-07, SND-17, §5.1.8, App. D.3) ─────────────────────────────────────────────

export interface MarkSentInput {
  readonly sentOn: string;
  readonly channel: SendChannel;
  readonly note?: string | undefined;
  /** "elektronisch übermittelt" confirmation for channel `other` (SND-17). */
  readonly electronicConfirmed?: boolean | undefined;
  readonly artifactIds: readonly string[];
  /** API/MCP may send the hashes they saw; they must equal the archived ones (SND-22). */
  readonly suppliedSha256?: Readonly<Record<string, string>> | undefined;
}

export interface MarkSentContext {
  readonly today: CalendarDate;
  /** Europe/Berlin date of the finalisation (EC-195). */
  readonly finalizedOn: string;
  readonly backdateWindowDays: number;
  readonly artifactStatus: "pending" | "ready" | "blocked" | undefined;
  /** Archived artifacts and frozen attachments of this document. */
  readonly artifacts: readonly ArchivedArtifact[];
  /** ER-03 decision stored at finalisation; absent for types without ER-03. */
  readonly decision?: Er03Decision | undefined;
  readonly consents: readonly PdfConsent[];
  readonly sendLog: readonly SendLogRow[];
}

export interface MarkSentResult {
  readonly findings: readonly Finding[];
  /** The selected artifacts with their archived hashes (what the sendLog row stores). */
  readonly artifacts: readonly { readonly artifactId: string; readonly sha256: string }[];
  readonly firstEffective: boolean;
  readonly einvoiceHandedOverElectronically: boolean;
}

const ELECTRONIC: readonly SendChannel[] = ["email_manual", "upload_portal", "other"];

export function validateMarkSent(input: MarkSentInput, ctx: MarkSentContext): MarkSentResult {
  const out: Finding[] = [];
  const push = (f: Finding | null) => {
    if (f) out.push(f);
  };
  push(checkArtifactsReady(ctx.artifactStatus));
  const note = (input.note ?? "").trim();
  if (input.sentOn > ctx.today) {
    push(
      finding(
        "mark_sent_date_future",
        "E",
        "MAIL-02",
        "hinweise",
        "Das Versanddatum darf nicht in der Zukunft liegen.",
        { field: "sentOn" },
      ),
    );
  } else if (input.sentOn < ctx.finalizedOn) {
    push(
      finding(
        "mark_sent_date_before_finalization",
        "E",
        "MAIL-02",
        "hinweise",
        `Das Versanddatum darf nicht vor der Fertigstellung (${formatGermanDate(ctx.finalizedOn as CalendarDate)}) liegen.`,
        { field: "sentOn", params: { date: ctx.finalizedOn } },
      ),
    );
  } else {
    const back = daysBetween(input.sentOn as CalendarDate, ctx.today);
    if (back > ctx.backdateWindowDays && !note) {
      push(
        finding(
          "mark_sent_backdate_note_required",
          "E",
          "MAIL-02",
          "hinweise",
          `Das Versanddatum liegt ${back} Tage zurück. Bitte im Hinweis angeben, warum erst jetzt markiert wird (wird protokolliert).`,
          { field: "note", params: { days: back } },
        ),
      );
    }
  }
  if (input.channel === "other" && !note) {
    push(
      finding(
        "mark_sent_note_required",
        "E",
        "MAIL-02",
        "hinweise",
        "Bitte beschreiben, wie das Dokument übermittelt wurde.",
        { field: "note" },
      ),
    );
  }
  const selected: ArchivedArtifact[] = [];
  if (input.artifactIds.length === 0) {
    push(
      finding(
        "mark_sent_artifacts_missing",
        "E",
        "MAIL-02",
        "hinweise",
        "Bitte angeben, welche Dateien übergeben wurden.",
        { field: "artifactIds" },
      ),
    );
  }
  for (const id of input.artifactIds) {
    const a = ctx.artifacts.find((x) => x.id === id);
    const supplied = input.suppliedSha256?.[id];
    if (!a || (supplied !== undefined && supplied !== a.sha256)) {
      push(
        finding(
          "mark_sent_artifact_unknown",
          "E",
          "MAIL-02",
          "hinweise",
          `Die Datei ${a?.name ?? id} gehört nicht zu diesem Dokument oder wurde verändert.`,
          {
            field: "artifactIds",
            params: { name: a?.name ?? id },
          },
        ),
      );
    } else {
      selected.push(a);
    }
  }
  const current = effectiveMark(ctx.sendLog);
  const firstEffective = current === null;
  if (current) {
    push(
      finding(
        "already_marked_sent",
        "W",
        "MAIL-02",
        "hinweise",
        `Bereits am ${formatGermanDate(current.sentOn as CalendarDate)} als versendet markiert (${SEND_CHANNEL_LABELS[current.channel]}). Die erneute Markierung wird zusätzlich protokolliert; Status und Zugang bleiben unverändert.`,
        { params: { date: current.sentOn, channel: current.channel } },
      ),
    );
  }
  const structured = selected.some(isStructuredEinvoice);
  const electronic =
    input.channel === "email_manual" ||
    input.channel === "upload_portal" ||
    (input.channel === "other" && !!input.electronicConfirmed);
  const decision = ctx.decision;
  if (decision === "MUST_E" && firstEffective) {
    if (input.channel === "post" || input.channel === "hand") {
      push(
        finding(
          "must_e_channel_not_electronic",
          "E",
          "ER-03",
          "e_rechnung",
          "Eine E-Rechnung muss elektronisch übermittelt werden. „Post“ oder „Persönlich übergeben“ genügt nicht – bitte „E-Mail (selbst versendet)“, „Upload-Portal“ oder „Sonstiges (elektronisch übermittelt)“ wählen.",
          { field: "channel" },
        ),
      );
    } else if (input.channel === "other" && !input.electronicConfirmed) {
      push(
        finding(
          "must_e_electronic_confirmation_missing",
          "E",
          "ER-03",
          "e_rechnung",
          "Bitte bestätigen, dass die E-Rechnung elektronisch übermittelt wurde.",
          {
            field: "electronicConfirmed",
          },
        ),
      );
    }
    if (selected.length > 0 && !structured) {
      push(
        finding(
          "pdf_not_allowed_must_e",
          "E",
          "ER-03",
          "e_rechnung",
          "Für diese Rechnung ist eine E-Rechnung Pflicht. Bitte die ZUGFeRD-PDF oder die XRechnung-Datei übergeben – ein reines PDF, eine Lesefassung oder Papier genügt nicht.",
          { field: "artifactIds" },
        ),
      );
    }
  }
  const pdfOnlyElectronic = selected.length > 0 && !structured && ELECTRONIC.includes(input.channel);
  if (pdfOnlyElectronic && decision !== "MUST_E") {
    const consent = consentValidOn(ctx.consents, input.sentOn);
    if (!consent && decision === "PDF_NEEDS_CONSENT") {
      push(
        finding(
          "pdf_consent_required",
          "E",
          "MAIL-01",
          "e_rechnung",
          "Für die elektronische Übermittlung als reines PDF ist während der Übergangszeit die Zustimmung des Kunden erforderlich. Bitte die E-Rechnung übergeben, auf Papier versenden oder die Zustimmung erfassen.",
          { field: "artifactIds" },
        ),
      );
    } else if (!consent && (decision === "MAY_PAPER_OR_PDF" || decision === "NOT_REQUIRED")) {
      push(
        finding(
          "pdf_consent_tacit",
          "W",
          "MAIL-01",
          "e_rechnung",
          "Keine Zustimmung zu PDF-Rechnungen erfasst. Eine stillschweigende Zustimmung genügt in der Regel.",
        ),
      );
    }
  }
  return {
    findings: out,
    artifacts: selected.map((a) => ({ artifactId: a.id, sha256: a.sha256 })),
    firstEffective,
    einvoiceHandedOverElectronically: structured && electronic,
  };
}

/** Default selection in the mark dialog: the files of the latest unmarked export, else the default export files. */
export function defaultMarkSelection(
  format: EinvoiceFormat,
  artifacts: readonly ArchivedArtifact[],
  lastExportArtifactIds: readonly string[] | undefined,
): string[] {
  if (lastExportArtifactIds && lastExportArtifactIds.length > 0) {
    return lastExportArtifactIds.filter((id) => artifacts.some((a) => a.id === id));
  }
  const specs = exportFiles(format, "default", false);
  return specs
    .map((s) => artifacts.find((a) => a.kind === s.kind && (a.variant ?? "original") === s.variant)?.id)
    .filter((id): id is string => !!id);
}

// ── retraction (SND-18) ─────────────────────────────────────────────────────────────────────────────────────────

export interface RetractionInput {
  readonly retractsId: string;
  readonly reason: string;
}

export interface RetractionResult {
  readonly findings: readonly Finding[];
  /** The retracted row was the effective mark. */
  readonly wasEffective: boolean;
  /** State after the retraction. */
  readonly next: SentState;
}

export function validateRetraction(
  input: RetractionInput,
  rows: readonly SendLogRow[],
  ctx: { readonly postalDeliveryDays: number; readonly dependent?: string | undefined; readonly at: number },
): RetractionResult {
  const out: Finding[] = [];
  if (input.reason.trim().length < 10) {
    out.push(
      finding(
        "retraction_reason_required",
        "E",
        "GOBD-06",
        "hinweise",
        "Bitte begründen, warum die Versandmarkierung zurückgenommen wird (mind. 10 Zeichen).",
        {
          field: "reason",
        },
      ),
    );
  }
  const retracted = new Set(rows.filter((r) => r.kind === "retraction").map((r) => r.retractsId));
  const target = rows.find((r) => r.id === input.retractsId && r.kind === "mark_sent" && !retracted.has(r.id));
  if (!target) {
    out.push(
      finding(
        "retraction_target_invalid",
        "E",
        "GOBD-06",
        "hinweise",
        "Diese Versandmarkierung existiert nicht oder wurde bereits zurückgenommen.",
        {
          field: "retractsId",
        },
      ),
    );
  }
  const wasEffective = !!target && effectiveMark(rows)?.id === target.id;
  if (wasEffective && ctx.dependent) {
    out.push(
      finding(
        "retraction_blocked_dependent",
        "E",
        "GOBD-06",
        "hinweise",
        `Die Versandmarkierung kann nicht zurückgenommen werden, weil ${ctx.dependent} darauf aufbaut.`,
        { params: { dependent: ctx.dependent } },
      ),
    );
  }
  const after: SendLogRow[] = [
    ...rows,
    {
      id: "__retraction__",
      kind: "retraction",
      retractsId: input.retractsId,
      sentOn: target?.sentOn ?? "",
      channel: target?.channel ?? "other",
      at: ctx.at,
    },
  ];
  return { findings: out, wasEffective, next: sentStateOf(after, ctx.postalDeliveryDays) };
}

// ── to-do SND-21 ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * „Exportiert, aber nicht als versendet markiert“: due 2 Berlin calendar days after the first export for sending,
 * as long as there is no effective mark and the document is not cancelled.
 */
export function exportedNotMarkedDue(input: {
  readonly firstExportedOn?: string | undefined;
  readonly status: string;
  readonly hasEffectiveMark: boolean;
  readonly today: CalendarDate;
}): boolean {
  if (!input.firstExportedOn || input.hasEffectiveMark) return false;
  if (input.status !== "finalized") return false;
  return input.today >= addDays(input.firstExportedOn as CalendarDate, 2);
}

export const exportedNotMarkedTitle = (number: string): string =>
  `Exportiert, aber nicht als versendet markiert: ${number}`;
