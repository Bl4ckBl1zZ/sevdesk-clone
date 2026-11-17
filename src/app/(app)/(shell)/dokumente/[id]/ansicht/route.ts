import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { AccessError, fetchAuthQuery, requireRole } from "@/lib/auth-server";
import { loadPdf } from "@/pdf/remote-assets";
import { appErrorData } from "@/server/api/http";
import { documentPages } from "@/server/documents/view-pages";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/**
 * GET /dokumente/{id}/ansicht — the pages of the document for the „Vorschau“ section of the Beleg page (F04 §6.4,
 * DOC-62) as PNG data URLs. Read-only; Convex re-checks `documents.read` in `invoices.viewInput` / `draftRenderInput`.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireRole("documents.read");
  } catch (e) {
    if (e instanceof AccessError) return json(403, { error: e.message });
    throw e;
  }
  const docId = (await params).id as Id<"salesDocuments">;
  try {
    const view = await fetchAuthQuery(api.invoices.viewInput, { id: docId });
    const pages = await documentPages(view, {
      fetchPdf: loadPdf,
      draftInput: () => fetchAuthQuery(api.invoices.draftRenderInput, { id: docId }),
    });
    return json(200, pages);
  } catch (e) {
    if (appErrorData(e)?.code === "not_found") return json(404, { error: "Beleg nicht gefunden." });
    throw e;
  }
}
