import "server-only";
import type { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { pdfToPngs } from "@/pdf/draft-preview";
import { type DraftRenderInput, draftPdf } from "./draft-pdf";

/**
 * „Vorschau“ section of the Beleg page (F04 §6.4, DOC-62): the pages of the document as PNG images, so they show the
 * same on desktop, iPhone and Pixel (mobile browsers do not page an embedded PDF, and the app forbids framing).
 * Finalised: the archived original PDF (`invoices.viewInput`, no export, nothing written). Draft: the „ENTWURF“ render
 * of the stored draft (DOC-42). Nothing is stored.
 */
export type DocumentViewInput = FunctionReturnType<typeof api.invoices.viewInput>;

export type DocumentPages =
  | { state: "pages"; pageCount: number; pages: string[] }
  | { state: "unavailable"; reason: "pending" | "blocked" | "missing" | "invalid" | "none"; errors?: string[] };

/** Long documents show the first pages; the full file is in „Exportieren“ / „PDF-Vorschau“. */
export const VIEW_MAX_PAGES = 10;
/** 2 × 72 dpi: sharp on phone and retina screens at the width of the main column. */
const SCALE = 2;

export interface DocumentPagesDeps {
  fetchPdf: (url: string) => Promise<Uint8Array | null>;
  draftInput: () => Promise<DraftRenderInput>;
}

const dataUrl = (png: Uint8Array) => `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

async function pagesOf(pdf: Uint8Array): Promise<DocumentPages> {
  const { pageCount, pages } = await pdfToPngs(pdf, { maxPages: VIEW_MAX_PAGES, scale: SCALE });
  return { state: "pages", pageCount, pages: pages.map(dataUrl) };
}

export async function documentPages(view: DocumentViewInput, deps: DocumentPagesDeps): Promise<DocumentPages> {
  if (view.status === "draft") {
    const input = await deps.draftInput();
    if (input.status === "draft" && !input.snapshot) {
      const errors = input.findings.filter((f) => f.severity === "E").map((f) => f.message);
      return { state: "unavailable", reason: "invalid", errors };
    }
    return pagesOf((await draftPdf(input)).pdf);
  }
  // Imported without a file (F09): nothing was ever rendered, so there is nothing to wait for.
  if (view.artifactStatus === null) return { state: "unavailable", reason: "none" };
  if (view.artifactStatus === "blocked") return { state: "unavailable", reason: "blocked" };
  if (view.artifactStatus !== "ready") return { state: "unavailable", reason: "pending" };
  const pdf = view.url ? await deps.fetchPdf(view.url) : null;
  if (!pdf) return { state: "unavailable", reason: "missing" };
  return pagesOf(pdf);
}
