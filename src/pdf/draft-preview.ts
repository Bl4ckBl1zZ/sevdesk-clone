/**
 * „PDF-Vorschau“ of a draft (F04 §4.4.7, DOC-42; REST `preview-pdf`, MCP `document_preview_pdf`, MCP-017): the
 * preview snapshot of the pipeline (`invoices.draftRenderInput`) rendered with the „ENTWURF“ watermark, and — for
 * Claude — the pages as PNG. Nothing is archived; the bytes are never stored (an archived PDF exists only after
 * finalisation, DOC-28). Runs in the Next.js server (pdfjs + @napi-rs/canvas are native/server-only packages).
 */
/// <reference path="./pdfjs-worker.d.ts" />
import { DOC_TYPE_LABEL_DE } from "@/domain/documents/doc-types";
import { layoutFromConfig } from "@/domain/documents/render-model";
import type { DocumentSnapshot, SalesDocType } from "@/domain/documents/snapshot";
import type { LetterheadFiles } from "./letterhead";
import { renderPdf } from "./render-artifacts";
import type { PdfLogo } from "./sales-document";

export interface DraftPdfInput {
  snapshot: DocumentSnapshot;
  /** The layout version's stored `config` (null = default layout). */
  layoutConfig: unknown;
  logo: PdfLogo | null;
  letterhead: LetterheadFiles | null;
}

/** The draft PDF (no e-invoice XML: the format is decided at finalisation, F04 §4.6). */
export function renderDraftPdf(input: DraftPdfInput): Promise<Uint8Array> {
  return renderPdf(input.snapshot, layoutFromConfig(input.layoutConfig), "draft", {
    logo: input.logo,
    letterhead: input.letterhead,
    createdAt: new Date(),
  });
}

/** „Rechnung-Entwurf.pdf“ — a draft has no number yet. */
export const draftPdfFileName = (type: SalesDocType) => `${DOC_TYPE_LABEL_DE[type].replace(/\s+/g, "-")}-Entwurf.pdf`;

let workerReady: Promise<void> | undefined;

/** pdfjs needs a worker; in Node the worker module is registered on the main thread (as in hybrid.ts). */
async function ensureWorker(): Promise<void> {
  workerReady ??= (async () => {
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
  })();
  return workerReady;
}

/** The first `maxPages` pages as PNG at `scale` × 72 dpi (2 ≈ 144 dpi, readable for Claude and on a phone). */
export async function pdfToPngs(
  pdf: Uint8Array,
  { maxPages = 3, scale = 2 }: { maxPages?: number; scale?: number } = {},
): Promise<{ pageCount: number; pages: Uint8Array[] }> {
  await ensureWorker();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const task = pdfjs.getDocument({ data: pdf.slice(), disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages: Uint8Array[] = [];
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
      pages.push(new Uint8Array(await canvas.encode("png")));
    }
    return { pageCount: doc.numPages, pages };
  } finally {
    await task.destroy();
  }
}
