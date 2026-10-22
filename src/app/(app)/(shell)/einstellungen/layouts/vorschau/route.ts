import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { AccessError, fetchAuthQuery, requireRole } from "@/lib/auth-server";
import {
  buildLayoutPreview,
  type LayoutPreviewData,
  parsePreviewParams,
  renderLayoutPreview,
} from "@/pdf/layout-preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Raster logos only; SVG logos appear in the P1 renderer (react-pdf has no SVG file support). */
async function loadLogo(url: string | null): Promise<{ data: Buffer; format: "png" | "jpg" } | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(png|jpeg)/.test(type)) return null;
    return { data: Buffer.from(await res.arrayBuffer()), format: type.includes("png") ? "png" : "jpg" };
  } catch {
    return null;
  }
}

/** SET-072: the letterhead PDF(s) of the previewed layout version (validated when uploaded). */
async function loadPdf(url: string | null): Promise<Uint8Array | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/**
 * GET /einstellungen/layouts/vorschau — SET-073 layout preview as PDF (Rechnung, Angebot, Mahnung, Lieferschein;
 * B2B/B2C; KU). Read-only; Convex re-checks `settings.read` in `layoutPreviewData`.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    await requireRole("settings.read");
  } catch (e) {
    if (e instanceof AccessError) return new Response(e.message, { status: 403 });
    throw e;
  }
  const opts = parsePreviewParams(new URL(request.url).searchParams);
  const data = (await fetchAuthQuery(api.settings.layoutPreviewData, {
    ...(opts.layoutId ? { layoutId: opts.layoutId as Id<"layouts"> } : {}),
  })) as LayoutPreviewData & {
    logoUrl: string | null;
    letterheadUrl: string | null;
    letterheadFollowUrl: string | null;
  };
  const model = buildLayoutPreview(data, opts);
  const first = await loadPdf(data.letterheadUrl);
  const follow = await loadPdf(data.letterheadFollowUrl);
  const pdf = await renderLayoutPreview(model, await loadLogo(data.logoUrl), first ? { first, follow } : null);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="layout-vorschau-${opts.type}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
