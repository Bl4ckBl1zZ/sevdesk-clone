import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { AccessError, fetchAuthQuery, requireRole } from "@/lib/auth-server";
import {
  buildLayoutPreview,
  type LayoutPreviewData,
  parsePreviewParams,
  renderLayoutPreview,
} from "@/pdf/layout-preview";
import { loadLetterhead, loadLogo } from "@/pdf/remote-assets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
  const logo = await loadLogo(data.logoUrl);
  const pdf = await renderLayoutPreview(
    model,
    logo ? { data: Buffer.from(logo.data), format: logo.format } : null,
    await loadLetterhead(data.letterheadUrl, data.letterheadFollowUrl),
  );
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="layout-vorschau-${opts.type}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
