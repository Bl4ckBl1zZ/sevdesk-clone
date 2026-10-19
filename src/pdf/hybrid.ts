/**
 * Hybrid PDF helpers for the receipt inbox (F06 INB-022, EC-INB-03/14/15). Run in a Convex "use node" action.
 *
 *  - `extractInvoiceXml`: the embedded invoice XML of a ZUGFeRD/Factur-X/XRechnung hybrid (`factur-x.xml`,
 *    `zugferd-invoice.xml`, `ZUGFeRD-invoice.xml`, `xrechnung.xml`, case-insensitive; `factur-x.xml` wins, the other
 *    candidates are listed for EC-INB-14). Encrypted PDFs are reported as such (EC-INB-03) and never decrypted. The
 *    PDF stays the original; the extracted XML is stored as an additional original-derived file by the caller.
 *  - `pdfTextLayer`: the text layer of the first pages (pdfjs-dist, main-thread "fake worker"), only to compare key
 *    values with the XML (EC-INB-15) — never OCR, never sent anywhere.
 */
/// <reference path="./pdfjs-worker.d.ts" />
import { readEmbeddedFiles } from "./embedded-files";

export type HybridXml =
  | { kind: "encrypted" }
  | { kind: "unreadable" }
  | { kind: "none" }
  | { kind: "found"; name: string; bytes: Uint8Array; others: string[] };

/** Preference order (EC-INB-14: factur-x.xml first). */
export const INVOICE_XML_NAMES = ["factur-x.xml", "zugferd-invoice.xml", "xrechnung.xml"] as const;

const rank = (name: string) => {
  const n = name.toLowerCase();
  const i = (INVOICE_XML_NAMES as readonly string[]).indexOf(n);
  return i;
};

/** `/Encrypt` in a trailer or cross-reference stream dictionary (the bytes are scanned, nothing is decrypted). */
export function isEncryptedPdf(pdf: Uint8Array): boolean {
  const text = new TextDecoder("latin1").decode(pdf);
  return /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(text);
}

export async function extractInvoiceXml(pdf: Uint8Array): Promise<HybridXml> {
  if (isEncryptedPdf(pdf)) return { kind: "encrypted" };
  let files: Awaited<ReturnType<typeof readEmbeddedFiles>>;
  try {
    files = await readEmbeddedFiles(pdf);
  } catch {
    return { kind: "unreadable" };
  }
  const candidates = files.filter((f) => rank(f.name) >= 0).sort((a, b) => rank(a.name) - rank(b.name));
  const first = candidates[0];
  if (!first) return { kind: "none" };
  return { kind: "found", name: first.name, bytes: first.bytes, others: candidates.slice(1).map((f) => f.name) };
}

/** EC-INB-14. */
export const multipleXmlMessage = (name: string) => `Mehrere eingebettete Rechnungs-XML gefunden. Verwendet: ${name}.`;

/** EC-INB-03. */
export const ENCRYPTED_PDF_MESSAGE =
  "Die PDF ist passwortgeschützt und kann nicht ausgelesen werden. Bitte Daten manuell erfassen.";

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
}

let workerReady: Promise<void> | undefined;

/** pdfjs needs a worker; in Node the worker module is registered on the main thread (no file lookup at run time). */
async function ensureWorker(): Promise<void> {
  workerReady ??= (async () => {
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
  })();
  return workerReady;
}

export async function pdfTextLayer(pdf: Uint8Array, maxPages = 5): Promise<string> {
  if (isEncryptedPdf(pdf)) return "";
  try {
    await ensureWorker();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: pdf.slice(),
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    });
    const doc = await task.promise;
    const parts: string[] = [];
    try {
      for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const items = content.items as TextItemLike[];
        parts.push(items.map((i) => `${i.str ?? ""}${i.hasEOL ? "\n" : " "}`).join(""));
      }
    } finally {
      await task.destroy();
    }
    return parts
      .join("\n")
      .replace(/[ \t]+/g, " ")
      .trim();
  } catch {
    return "";
  }
}
