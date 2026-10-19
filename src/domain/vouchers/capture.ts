/**
 * Original files of a voucher (F06 VOU-120…122, GOBD-07/08, ER-13; EC-VOU-01/22/23, EC-161).
 *
 *  - Capture metadata per original (VOU-120): SHA-256 of the exact bytes, size, sniffed MIME, original name,
 *    `capturedAt` (server), `clientCapturedAt` (device, if any), `capturedVia`, actor, page count.
 *  - Originals are stored as received; thumbnails, crops, HEIC→JPEG, combined PDFs and OCR text are renditions with
 *    their own records (VOU-121) — a rendition never replaces an original.
 *  - Replacement (VOU-122) adds a new original and sets `replacedBy` on the old one (old file and hash stay
 *    retrievable); allowed while draft or unlocked, with a reason after finalisation; after the lock only additions.
 * The MIME type is sniffed from magic bytes, never taken from the extension (INB-001, EC-INB-01). Pure.
 */
import { err, type Issue, issue, ok, type Result } from "../result";

export const CAPTURE_CHANNELS = ["upload", "email", "app", "api", "mcp"] as const;
export type CaptureChannel = (typeof CAPTURE_CHANNELS)[number];

export const FILE_ROLES = ["original", "extracted_xml", "embedded_attachment", "eml"] as const;
export type FileRole = (typeof FILE_ROLES)[number];

export const RENDITION_KINDS = [
  "thumbnail",
  "crop_deskew",
  "heic_jpeg",
  "combined_pdf",
  "html_pdf",
  "visualisation",
] as const;
export type RenditionKind = (typeof RENDITION_KINDS)[number];

export interface OriginalFile {
  storageId: string;
  sha256: string;
  bytes: number;
  mime: string;
  name: string;
  pages?: number;
  role: FileRole;
  capturedAt: number;
  clientCapturedAt?: number;
  capturedBy: string;
  capturedVia: CaptureChannel;
  replacedBy?: number;
}

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const CAPTURE_MESSAGES = {
  unsupported: "Dateityp nicht unterstützt. Erlaubt sind PDF, JPG, PNG, HEIC, WebP, TIFF, XML und E-Mails (.eml).",
  tooLarge: (mb: number) => `Die Datei ist zu groß (max. ${mb} MB).`,
  noFile: "Jede Buchung braucht einen Beleg. Bitte Datei hochladen oder einen Eigenbeleg erstellen.",
  replaceLocked: "Originaldateien festgeschriebener Belege können nicht ersetzt werden.",
  replaceReason: "Bitte angeben, warum die Datei ersetzt wird.",
  replaceUnknown: "Die zu ersetzende Datei existiert nicht oder wurde bereits ersetzt.",
} as const;

const startsWith = (b: Uint8Array, sig: readonly number[], offset = 0) => sig.every((x, i) => b[offset + i] === x);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));

/** Magic-byte sniffing (INB-001). Returns null for unsupported content. */
export function sniffMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (["heic", "heix", "hevc", "heif", "mif1", "msf1"].includes(brand)) return "image/heic";
  }
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 512)).replace(/^﻿/, "").trimStart();
  if (head.startsWith("<?xml") || /^<([A-Za-z_][\w.-]*:)?(Invoice|CreditNote|CrossIndustryInvoice)\b/.test(head)) {
    return "application/xml";
  }
  if (
    /^(Received|Return-Path|From|MIME-Version|Delivered-To|Message-ID|Date|Subject|To|DKIM-Signature|X-[\w-]+):/i.test(
      head,
    )
  ) {
    return "message/rfc822";
  }
  return null;
}

export type CaptureIssue = Issue<"file_unsupported" | "file_too_large" | "file_empty">;

export function checkUpload(bytes: Uint8Array, maxBytes = MAX_UPLOAD_BYTES): Result<{ mime: string }, CaptureIssue> {
  if (bytes.byteLength === 0) return err(issue("file_empty", CAPTURE_MESSAGES.unsupported));
  if (bytes.byteLength > maxBytes) {
    return err(issue("file_too_large", CAPTURE_MESSAGES.tooLarge(Math.round(maxBytes / 1024 / 1024))));
  }
  const mime = sniffMime(bytes);
  return mime ? ok({ mime }) : err(issue("file_unsupported", CAPTURE_MESSAGES.unsupported));
}

/** PDF page count from the page tree (`/Type /Page` objects); images and XML count as 1 page. */
export function pageCount(bytes: Uint8Array, mime: string): number {
  if (mime !== "application/pdf") return 1;
  const text = new TextDecoder("latin1").decode(bytes);
  const n = (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  return Math.max(1, n);
}

/** VOU-120: capture metadata fields that are missing on a stored original (empty = complete). */
export function missingCaptureMetadata(f: Partial<OriginalFile>): string[] {
  const out: string[] = [];
  if (!f.sha256 || !/^[0-9a-f]{64}$/.test(f.sha256)) out.push("sha256");
  if (typeof f.bytes !== "number" || f.bytes <= 0) out.push("bytes");
  if (!f.mime) out.push("mime");
  if (!f.name) out.push("name");
  if (typeof f.capturedAt !== "number") out.push("capturedAt");
  if (!f.capturedBy) out.push("capturedBy");
  if (!f.capturedVia) out.push("capturedVia");
  return out;
}

/** The current originals (not replaced). */
export const activeOriginals = <F extends Pick<OriginalFile, "replacedBy">>(files: readonly F[]): F[] =>
  files.filter((f) => f.replacedBy === undefined);

/** EC-VOU-01 / RI-21: does the voucher have a Beleg? */
export function hasBeleg(input: {
  files: readonly Pick<OriginalFile, "replacedBy">[];
  kind: string;
  eigenbelegApproved?: boolean;
  recurringReference?: boolean;
}): boolean {
  if (activeOriginals(input.files).length > 0) return true;
  if (input.kind === "eigenbeleg") return input.eigenbelegApproved === true;
  return input.recurringReference === true;
}

export type ReplaceIssue = Issue<"file_replace_locked" | "file_replace_reason" | "file_replace_unknown">;

/**
 * VOU-122: may file `index` be replaced? Drafts: always. Booked and unlocked: with a reason (EC-VOU-23). Locked
 * (period locked or `lockedAt`): never — only additions (EC-VOU-22).
 */
export function checkReplacement(input: {
  files: readonly Pick<OriginalFile, "replacedBy">[];
  index: number;
  booked: boolean;
  locked: boolean;
  reason?: string;
}): Result<true, ReplaceIssue> {
  const f = input.files[input.index];
  if (!f || f.replacedBy !== undefined) return err(issue("file_replace_unknown", CAPTURE_MESSAGES.replaceUnknown));
  if (input.locked) return err(issue("file_replace_locked", CAPTURE_MESSAGES.replaceLocked));
  if (input.booked && (input.reason?.trim().length ?? 0) < 5) {
    return err(issue("file_replace_reason", CAPTURE_MESSAGES.replaceReason));
  }
  return ok(true);
}

/** Applies a replacement: the new original is appended, the old one points at it. Never removes anything. */
export function replaceOriginal<F extends OriginalFile>(files: readonly F[], index: number, next: F): F[] {
  const out = files.map((f) => ({ ...f }));
  out.push(next);
  (out[index] as F).replacedBy = out.length - 1;
  return out;
}
