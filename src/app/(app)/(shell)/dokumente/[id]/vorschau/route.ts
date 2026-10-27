import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { PROBLEMS } from "@/domain/api/problems";
import { AccessError, fetchAuthQuery, requireRole } from "@/lib/auth-server";
import { ApiProblem, appErrorData } from "@/server/api/http";
import { draftPdf } from "@/server/documents/draft-pdf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const text = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });

/**
 * GET /dokumente/{id}/vorschau — „PDF-Vorschau“ of a draft from the editor (F04 §4.4.7, DOC-42): the PDF with the
 * „ENTWURF“ watermark, inline. Read-only; Convex re-checks `documents.read` in `invoices.draftRenderInput`.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireRole("documents.read");
  } catch (e) {
    if (e instanceof AccessError) return text(403, e.message);
    throw e;
  }
  const { id } = await params;
  try {
    const input = await fetchAuthQuery(api.invoices.draftRenderInput, { id: id as Id<"salesDocuments"> });
    const { pdf, fileName } = await draftPdf(input);
    return new Response(pdf as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof ApiProblem) return text(PROBLEMS[e.code].status, e.message);
    const data = appErrorData(e);
    if (data?.code === "not_found") return text(404, "Beleg nicht gefunden.");
    throw e;
  }
}
