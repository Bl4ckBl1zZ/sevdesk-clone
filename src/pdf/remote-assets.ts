import type { LetterheadFiles } from "./letterhead";
import type { PdfLogo } from "./sales-document";

/**
 * Logo and letterhead bytes behind Convex storage URLs, for PDFs rendered in the Next.js server (layout preview
 * SET-073, draft preview DOC-42). Missing or unreachable files render without them instead of failing the preview.
 */

/** Raster logos only; react-pdf has no SVG file support (F01 SET-070). */
export async function loadLogo(url: string | null): Promise<PdfLogo | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(png|jpeg)/.test(type)) return null;
    return { data: new Uint8Array(await res.arrayBuffer()), format: type.includes("png") ? "png" : "jpg" };
  } catch {
    return null;
  }
}

/** SET-072: a letterhead PDF of the layout version (validated when uploaded). */
export async function loadPdf(url: string | null): Promise<Uint8Array | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export async function loadLetterhead(first: string | null, follow: string | null): Promise<LetterheadFiles | null> {
  const a = await loadPdf(first);
  if (!a) return null;
  const b = await loadPdf(follow);
  return { first: a, ...(b ? { follow: b } : {}) };
}
