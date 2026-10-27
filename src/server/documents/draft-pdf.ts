import "server-only";
import type { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import type { SalesDocType } from "@/domain/documents/snapshot";
import { draftPdfFileName, renderDraftPdf } from "@/pdf/draft-preview";
import { loadLetterhead, loadLogo } from "@/pdf/remote-assets";
import { ApiProblem } from "../api/http";

/**
 * „PDF-Vorschau“ of a draft (F04 §4.4.7, DOC-42): one implementation for the editor route, REST `preview-pdf` and
 * MCP `document_preview_pdf` (MCP-017). Input is `invoices.draftRenderInput` (Convex checks `documents.read`);
 * nothing is written or archived.
 */
export type DraftRenderInput = FunctionReturnType<typeof api.invoices.draftRenderInput>;

export const NOT_A_DRAFT =
  "Nur Entwürfe haben eine PDF-Vorschau. Fertiggestellte Belege werden exportiert (Oberfläche „Exportieren“, MCP document_export).";

export async function draftPdf(input: DraftRenderInput): Promise<{ pdf: Uint8Array; fileName: string }> {
  if (input.status !== "draft") throw new ApiProblem("immutable_record", { detail: NOT_A_DRAFT });
  if (!input.snapshot) {
    const errors = input.findings.filter((f) => f.severity === "E");
    throw new ApiProblem("validation_failed", {
      detail: `Der Entwurf kann noch nicht dargestellt werden: ${errors.map((f) => f.message).join(" ") || "Kontakt fehlt."}`,
      errors: errors.map((f) => ({
        code: f.code,
        rule: f.rule,
        message: f.message,
        ...(f.field ? { field: f.field } : {}),
      })),
    });
  }
  const pdf = await renderDraftPdf({
    snapshot: input.snapshot,
    layoutConfig: input.layoutConfig,
    logo: await loadLogo(input.logoUrl),
    letterhead: await loadLetterhead(input.letterheadUrl, input.letterheadFollowUrl),
  });
  return { pdf, fileName: draftPdfFileName(input.type as SalesDocType) };
}
