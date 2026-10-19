/**
 * Document attachments (F04 DOC-18) and post-finalisation proofs (F04 INV-30, UST-21/UST-23). Pure rules:
 *  - attachments: ≤ 10 files, ≤ 10 MB each, PDF/PNG/JPEG/XLSX/CSV/TXT; drafts only (frozen at finalisation);
 *    `includeInExport` (default on, SND-16) and `embedInXml` (BT-125, BG-24; XRechnung/ZUGFeRD only);
 *  - evidence („Nachweise“): appended to finalised documents, never part of the snapshot; an intra-Community supply
 *    warns until a Gelangensbestätigung or CMR is attached, an export until an Ausfuhrnachweis is attached.
 */
import type { TaxCase } from "../tax/tax-case";

export const ATTACHMENT_MAX_FILES = 10;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const ATTACHMENT_MIMES: Readonly<Record<string, string>> = {
  "application/pdf": "PDF",
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "text/csv": "CSV",
  "text/plain": "TXT",
};

/** Browsers send CSV/TXT with varying types; fall back to the extension. */
export function attachmentMime(name: string, mime: string): string | null {
  const m = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ATTACHMENT_MIMES[m]) return m;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const byExt: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
    txt: "text/plain",
  };
  return byExt[ext] ?? null;
}

export function attachmentIssue(existing: number, file: { name: string; mime: string; bytes: number }): string | null {
  if (existing >= ATTACHMENT_MAX_FILES) return `Höchstens ${ATTACHMENT_MAX_FILES} Anhänge je Beleg.`;
  if (!attachmentMime(file.name, file.mime)) return "Erlaubt sind PDF, PNG, JPEG, XLSX, CSV und TXT.";
  if (file.bytes > ATTACHMENT_MAX_BYTES) return "Ein Anhang darf höchstens 10 MB groß sein.";
  if (file.bytes === 0) return "Die Datei ist leer.";
  return null;
}

/** EN 16931 BT-125 mimeCode code list (CEF): TXT may be attached to the export bundle but not embedded as BG-24. */
export const XML_EMBEDDABLE_MIMES: readonly string[] = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export function embedIssue(mime: string): string | null {
  return XML_EMBEDDABLE_MIMES.includes(mime)
    ? null
    : "Diese Dateiart kann nicht in die E-Rechnung eingebettet werden (BG-24 erlaubt PDF, PNG, JPEG, CSV, XLSX).";
}

export const EVIDENCE_KINDS = ["gelangensbestaetigung", "cmr", "ausfuhrnachweis", "other"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_LABEL_DE: Readonly<Record<EvidenceKind, string>> = {
  gelangensbestaetigung: "Gelangensbestätigung",
  cmr: "CMR-Frachtbrief",
  ausfuhrnachweis: "Ausfuhrnachweis",
  other: "Sonstiger Nachweis",
};

/** Document types that evidence a supply (advance invoices precede the supply; Storno/reminders carry no proof). */
const PROOF_TYPES: readonly string[] = ["invoice", "partial_invoice", "final_invoice"];

export type ProofWarning = { readonly code: "proof_missing_igl" | "proof_missing_export"; readonly message: string };

/** INV-30 (F04 §5 `proof_missing_igl` / `proof_missing_export`): the proof a finalised invoice still lacks, or null. Warning only. */
export function missingProof(
  doc: { readonly type: string; readonly taxCase: TaxCase | string },
  evidence: readonly { kind: string }[],
): ProofWarning | null {
  if (!PROOF_TYPES.includes(doc.type)) return null;
  const kinds = new Set(evidence.map((e) => e.kind));
  if (doc.taxCase === "intra_community_supply" && !kinds.has("gelangensbestaetigung") && !kinds.has("cmr")) {
    return {
      code: "proof_missing_igl",
      message:
        "Gelangensnachweis fehlt (Gelangensbestätigung oder CMR). Ohne Nachweis ist die Steuerbefreiung gefährdet.",
    };
  }
  if (doc.taxCase === "export" && !kinds.has("ausfuhrnachweis")) {
    return { code: "proof_missing_export", message: "Ausfuhrnachweis fehlt (z. B. ATLAS-Ausgangsvermerk)." };
  }
  return null;
}
