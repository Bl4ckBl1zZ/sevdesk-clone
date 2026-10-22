/**
 * Letterhead (Briefpapier) as the background of the rendered documents (F01 SET-071/072, ER-11).
 *
 * Accepted: PDF, A4 portrait, 1–2 pages, ≤ 5 MB, no JavaScript/launch actions, no encryption, all fonts embedded.
 * Page 1 is the background of the first page; page 2 (or page 1 if there is only one, or the first page of a separate
 * follow-page file) the background of all later pages. The letterhead pages are embedded as Form XObjects and drawn
 * *under* the document content (the new content stream is moved to the front of the page's `Contents`).
 *
 * LEGAL-OPEN: SET-072 converts a non-conforming letterhead (e.g. non-embedded fonts) into a 300 dpi image background
 * ("Briefpapier wurde für PDF/A in ein Bild umgewandelt."). The server has no rasteriser (no canvas dependency), so
 * such a letterhead is refused with a German message instead; the owner exports it again with embedded fonts (PDF/A).
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFPage, PDFRawStream, PDFStream } from "@cantoo/pdf-lib";
import { isEncryptedPdf } from "./hybrid";

export const LETTERHEAD_MAX_BYTES = 5 * 1024 * 1024;
/** A4 in PDF points (210 × 297 mm) and the tolerance for rounding in exporting tools. */
export const A4_POINTS = { width: 595.28, height: 841.89 } as const;
const TOLERANCE_PT = 3;

export type LetterheadIssueCode =
  | "letterhead_not_pdf"
  | "letterhead_too_large"
  | "letterhead_encrypted"
  | "letterhead_unreadable"
  | "letterhead_page_count"
  | "letterhead_not_a4_portrait"
  | "letterhead_javascript"
  | "letterhead_fonts_not_embedded";

export const LETTERHEAD_MESSAGES: Readonly<Record<LetterheadIssueCode, string>> = {
  letterhead_not_pdf: "Das Briefpapier muss eine PDF-Datei sein.",
  letterhead_too_large: "Das Briefpapier ist größer als 5 MB.",
  letterhead_encrypted:
    "Das Briefpapier ist verschlüsselt oder passwortgeschützt. Bitte eine ungeschützte PDF hochladen.",
  letterhead_unreadable: "Die PDF-Datei des Briefpapiers kann nicht gelesen werden.",
  letterhead_page_count: "Das Briefpapier muss eine oder zwei Seiten haben (Seite 1 und Folgeseiten).",
  letterhead_not_a4_portrait: "Das Briefpapier muss im Format A4 hochkant (210 × 297 mm) angelegt sein.",
  letterhead_javascript:
    "Das Briefpapier enthält JavaScript oder Aktionen. Bitte eine PDF ohne aktive Inhalte hochladen.",
  letterhead_fonts_not_embedded:
    "Im Briefpapier sind nicht alle Schriften eingebettet. Bitte die PDF mit eingebetteten Schriften (z. B. als PDF/A) exportieren.",
};

export type LetterheadCheck =
  | { readonly ok: true; readonly pages: 1 | 2 }
  | { readonly ok: false; readonly code: LetterheadIssueCode; readonly message: string };

const fail = (code: LetterheadIssueCode): LetterheadCheck => ({ ok: false, code, message: LETTERHEAD_MESSAGES[code] });

const SIMPLE_FONTS = new Set(["Type1", "MMType1", "TrueType", "CIDFontType0", "CIDFontType2"]);

function nameOf(dict: PDFDict, key: string): string | undefined {
  const v = dict.get(PDFName.of(key));
  return v instanceof PDFName ? v.decodeText() : undefined;
}

function dictOf(obj: unknown): PDFDict | undefined {
  if (obj instanceof PDFDict) return obj;
  if (obj instanceof PDFRawStream || obj instanceof PDFStream) return (obj as PDFStream).dict;
  return undefined;
}

/** Every dictionary of an object incl. nested direct dictionaries/arrays (references are visited on their own). */
function* dictsOf(obj: unknown): Generator<PDFDict> {
  const dict = dictOf(obj);
  const values = dict ? [...dict.entries()].map(([, v]) => v) : obj instanceof PDFArray ? obj.asArray() : [];
  if (dict) yield dict;
  for (const v of values) if (v instanceof PDFDict || v instanceof PDFArray) yield* dictsOf(v);
}

/** JavaScript, launch actions and fonts without an embedded program, over every parsed object (incl. object streams). */
function scanObjects(doc: PDFDocument): { javascript: boolean; missingFont: boolean } {
  let javascript = false;
  let missingFont = false;
  const checkDict = (dict: PDFDict) => {
    const s = nameOf(dict, "S");
    if (dict.has(PDFName.of("JS")) || s === "JavaScript" || s === "Launch") javascript = true;
    if (nameOf(dict, "Type") === "Font" && SIMPLE_FONTS.has(nameOf(dict, "Subtype") ?? "")) {
      const descriptor = dict.lookup(PDFName.of("FontDescriptor"));
      const fd = descriptor instanceof PDFDict ? descriptor : undefined;
      const embedded =
        fd !== undefined &&
        (fd.has(PDFName.of("FontFile")) || fd.has(PDFName.of("FontFile2")) || fd.has(PDFName.of("FontFile3")));
      if (!embedded) missingFont = true;
    }
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    for (const dict of dictsOf(obj)) checkDict(dict);
  }
  // The name tree of document-level scripts.
  const names = doc.catalog.lookup(PDFName.of("Names"));
  if (names instanceof PDFDict && names.has(PDFName.of("JavaScript"))) javascript = true;
  return { javascript, missingFont };
}

function isA4Portrait(page: PDFPage): boolean {
  const box = page.getMediaBox();
  const rotated = page.getRotation().angle % 180 !== 0;
  const width = rotated ? box.height : box.width;
  const height = rotated ? box.width : box.height;
  return Math.abs(width - A4_POINTS.width) <= TOLERANCE_PT && Math.abs(height - A4_POINTS.height) <= TOLERANCE_PT;
}

/** SET-072: validates an uploaded letterhead (bytes as stored). */
export async function validateLetterhead(bytes: Uint8Array): Promise<LetterheadCheck> {
  if (bytes.length > LETTERHEAD_MAX_BYTES) return fail("letterhead_too_large");
  if (new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).indexOf("%PDF-") < 0) return fail("letterhead_not_pdf");
  if (isEncryptedPdf(bytes)) return fail("letterhead_encrypted");
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    return fail("letterhead_unreadable");
  }
  const count = doc.getPageCount();
  if (count < 1 || count > 2) return fail("letterhead_page_count");
  if (!doc.getPages().every(isA4Portrait)) return fail("letterhead_not_a4_portrait");
  const scan = scanObjects(doc);
  if (scan.javascript) return fail("letterhead_javascript");
  if (scan.missingFont) return fail("letterhead_fonts_not_embedded");
  return { ok: true, pages: count as 1 | 2 };
}

export interface LetterheadFiles {
  /** The letterhead PDF (page 1 → first page, page 2 → later pages). */
  readonly first: Uint8Array;
  /** Optional separate file whose first page is the background of the later pages (`letterheadPage2StorageId`). */
  readonly follow?: Uint8Array | null;
}

/** Moves the content stream just appended by pdf-lib to the front, so it is painted first (background). */
function sendLastStreamToBack(page: PDFPage): void {
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray) || contents.size() < 2) return;
  const last = contents.get(contents.size() - 1);
  contents.remove(contents.size() - 1);
  contents.insert(0, last);
}

/** SET-072: draws the letterhead under every page of the rendered document. */
export async function applyLetterhead(pdf: Uint8Array, files: LetterheadFiles): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const source = await PDFDocument.load(files.first, { updateMetadata: false });
  const [firstPage] = await doc.embedPdf(source, [0]);
  let laterPage = firstPage;
  if (files.follow) {
    [laterPage] = await doc.embedPdf(await PDFDocument.load(files.follow, { updateMetadata: false }), [0]);
  } else if (source.getPageCount() > 1) {
    [laterPage] = await doc.embedPdf(source, [1]);
  }
  if (!firstPage || !laterPage) throw new Error("letterhead_unreadable");
  doc.getPages().forEach((page, i) => {
    const background = i === 0 ? firstPage : laterPage;
    const { width, height } = page.getSize();
    page.drawPage(background, { x: 0, y: 0, width, height });
    sendLastStreamToBack(page);
  });
  return doc.save();
}
