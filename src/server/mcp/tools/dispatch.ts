import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { dispatchDocId, documentExportWire, documentMarkSentWire, finalizeArgs } from "@/domain/schemas/api/dispatch";
import { finalizeWire } from "@/domain/schemas/api/documents";
import { reminderFinalizeArgs } from "@/domain/schemas/api/dunning";
import { pdfToPngs } from "@/pdf/draft-preview";
import { ApiProblem } from "../../api/http";
import {
  DRAFT_PDF_FAMILIES,
  draftPdfOf,
  exportDocument,
  markSentArgsOrThrow,
  markSentDocument,
  markSentPreviewOf,
  requireFinalizeScopes,
  resolveDispatchDoc,
} from "../../api/resources/dispatch";
import { confirmTokenArg, defineTool, ToolContent, type ToolContext } from "../tool";
import type { PreviewPlan } from "./previews";

/**
 * 06 §3.4 / F04 §7.2: ⚠ `document_finalize` (token from `document_preview`, intent finalize), `document_export` (W:
 * only the `document.export` audit entry; transmits nothing) and ⚠ `document_mark_sent` (token from
 * `preview_action { action: "document_mark_sent" }`). The app never sends a document (EC-189): the owner sends the
 * exported files and confirms how and when, then Claude records the mark. `document_preview_pdf` (R, MCP-017) shows a
 * draft as PNG pages or PDF (watermark „ENTWURF“) so Claude can show the owner what the document will look like.
 */

const FINALIZE_FAMILIES = [
  "quote",
  "order_confirmation",
  "delivery_note",
  "invoice",
  "correction",
  "reminder",
  "self_billing",
] as const;

/** Reminders are always dated today (DUN-004): the finalisation options of other documents are refused. */
export function rejectDocumentOptions(o: { document_date?: unknown; backdate_reason?: unknown; overrides?: unknown }) {
  const field = (["document_date", "backdate_reason", "overrides"] as const).find((k) => o[k] !== undefined);
  if (!field) return;
  throw new ApiProblem("validation_failed", {
    errors: [{ code: "invalid", field, message: "Mahnungen werden immer mit dem heutigen Datum fertiggestellt." }],
  });
}

/** `acknowledge_warnings` belongs to reminders only (their warnings need an explicit acknowledgement, DUN-004). */
export function rejectReminderOptions(ack: readonly string[] | undefined) {
  if (ack === undefined) return;
  throw new ApiProblem("validation_failed", {
    errors: [
      {
        code: "invalid",
        field: "acknowledge_warnings",
        message: "acknowledge_warnings gilt nur für Mahnungen (rem_…).",
      },
    ],
  });
}

export const markSentParams = documentMarkSentWire.extend({ id: dispatchDocId });

/** `preview_action { action: "document_mark_sent" }`: the §5.1.8 validation and the effect; no token on errors. */
export async function markSentPlan(params: z.infer<typeof markSentParams>, { convex }: ToolContext) {
  const { id, ...wire } = params;
  const doc = await resolveDispatchDoc(convex, id);
  const args = markSentArgsOrThrow(doc, wire);
  const effect = await markSentPreviewOf(convex, args);
  if (effect.errors.length > 0) {
    throw new ApiProblem("validation_failed", {
      detail: effect.errors[0]?.message,
      errors: effect.errors.map((e) => ({ code: e.code, rule: e.rule, message: e.message })),
    });
  }
  return {
    args: args as unknown as Record<string, unknown>,
    entities: [{ table: "salesDocuments", id: doc.id }],
    effect: {
      id,
      ...effect,
      summary: `${doc.number ?? id} wird als versendet markiert (${wire.channel}, ${wire.sent_on})${effect.zugang ? `; Zugang ${effect.zugang}` : ""}${effect.first_effective ? "" : " — weiterer Eintrag, Status und Zugang bleiben"}.`,
    },
  } satisfies PreviewPlan;
}

export const dispatchTools = [
  defineTool({
    name: "document_finalize",
    title: "Beleg fertigstellen ⚠",
    description:
      "⚠ Stellt einen Entwurf fertig (Nummer, eingefrorener Inhalt, PDF/E-Rechnung; unumkehrbar), auch einen Mahnungsentwurf (rem_…, mit denselben acknowledge_warnings wie in der Vorschau). Zuerst document_preview {id} (intent finalize, dieselben document_date/backdate_reason/overrides) aufrufen, Summen, Steuerfall und ER-03 bzw. die Mahnforderung zeigen, bestätigen lassen, dann mit confirm_token und der version aus der Vorschau. Danach document_export; versenden macht der Inhaber selbst.",
    kind: "danger",
    confirmIntent: "document_finalize",
    scopes: ["invoices:finalize"],
    input: finalizeWire.extend({
      id: dispatchDocId,
      acknowledge_warnings: z
        .array(z.string().max(60))
        .max(20)
        .optional()
        .meta({ description: "Nur Mahnungen (rem_…): dieselben bestätigten Warnungscodes wie in document_preview" }),
      confirm_token: confirmTokenArg,
    }),
    handler: async ({ id, confirm_token, acknowledge_warnings, ...w }, { convex, key }) => {
      const doc = await resolveDispatchDoc(convex, id, FINALIZE_FAMILIES);
      requireFinalizeScopes(key, doc.type);
      if (doc.idType === "reminder") {
        // DUN-004 `dunning.finalize` (⚠ invoices.finalize → intent document_finalize; token bound to these args).
        rejectDocumentOptions(w);
        const r = await convex.mutation(api.dunning.finalize, {
          ...reminderFinalizeArgs(doc.id, { version: w.version, acknowledge_warnings }),
          confirmToken: confirm_token,
        } as never);
        return {
          id: doc.wireId,
          number: r.number,
          status: "finalized",
          artifact_status: "pending",
          next: "document_export (PDF der Mahnung), dann versendet der Inhaber selbst; danach document_mark_sent.",
        };
      }
      rejectReminderOptions(acknowledge_warnings);
      const r = await convex.action(api.invoices.finalize, {
        ...finalizeArgs(doc.id, w),
        confirmToken: confirm_token,
      } as never);
      return {
        id: doc.wireId,
        number: r.number,
        status: "finalized",
        artifact_status: r.idempotentReplay ? "unchanged" : "pending",
        idempotent_replay: r.idempotentReplay,
        next: "document_export, dann versendet der Inhaber selbst; danach document_mark_sent.",
      };
    },
  }),
  defineTool({
    name: "document_export",
    title: "Belegdateien exportieren",
    description:
      "Kurzlebige Links (5 min, nur im Tailnet) zu den archivierten Dateien eines fertiggestellten Belegs (Rechnung, Korrektur, Angebot, Mahnung …) für den Inhaber zum Herunterladen. entry: default (je Format), zugferd_pdf, xml, xrechnung_with_reading, pdf, zip. Versendet nichts; protokolliert den Export. Original erneut nach der Markierung nur in der Oberfläche.",
    kind: "write",
    scopes: ["documents:read"],
    input: documentExportWire.omit({ original: true, reason: true }).extend({ id: dispatchDocId }),
    handler: async ({ id, ...w }, { convex }) => exportDocument(convex, await resolveDispatchDoc(convex, id), w),
  }),
  defineTool({
    name: "document_preview_pdf",
    title: "PDF-Vorschau eines Entwurfs",
    description:
      "Zeigt einen Entwurf (Rechnung, Angebot, Auftragsbestätigung, Lieferschein, Korrektur, Gutschrift) so, wie das PDF aussehen wird — mit Wasserzeichen „ENTWURF“, ohne Nummer. format png (Standard): die Seiten als Bilder (max_pages, Standard 3) zum Ansehen oder Zeigen; format pdf: die PDF-Datei als eingebettete Ressource, wenn der Nutzer die Datei möchte. Schreibt nichts. Fertiggestellte Belege: document_export. Blockierende Fehler kommen als validation_failed mit den Befunden zurück.",
    kind: "read",
    scopes: ["documents:read"],
    input: z.object({
      id: dispatchDocId,
      format: z.enum(["png", "pdf"]).default("png").meta({ description: "png = Seiten als Bilder, pdf = PDF-Datei" }),
      max_pages: z.number().int().min(1).max(10).default(3).meta({ description: "Nur png: höchstens so viele Seiten" }),
    }),
    handler: async ({ id, format, max_pages }, { convex }) => {
      const doc = await resolveDispatchDoc(convex, id, DRAFT_PDF_FAMILIES);
      const { pdf, fileName } = await draftPdfOf(convex, doc);
      const base = { id: doc.wireId, format, file_name: fileName, watermark: "ENTWURF" };
      if (format === "pdf") {
        return new ToolContent({ ...base, bytes: pdf.length }, [
          {
            type: "resource",
            resource: {
              uri: `rechnung://documents/${doc.wireId}/${fileName}`,
              mimeType: "application/pdf",
              blob: Buffer.from(pdf).toString("base64"),
            },
          },
        ]);
      }
      const { pageCount, pages } = await pdfToPngs(pdf, { maxPages: max_pages });
      return new ToolContent({ ...base, page_count: pageCount, pages_returned: pages.length }, [
        ...pages.map((png) => ({
          type: "image" as const,
          data: Buffer.from(png).toString("base64"),
          mimeType: "image/png",
        })),
      ]);
    },
  }),
  defineTool({
    name: "document_mark_sent",
    title: "Als versendet markieren ⚠",
    description:
      '⚠ „Als versendet markieren“, nachdem der Inhaber bestätigt hat, wie und wann er die exportierten Dateien selbst übergeben hat (channel email_manual, post, hand, upload_portal, other; artifacts = art_… aus document_export). Nie vermuten. Erst preview_action {action:"document_mark_sent", params}, Auswirkung (Status, Zugang) zeigen, bestätigen lassen, dann mit confirm_token und denselben params.',
    kind: "danger",
    confirmIntent: "document_mark_sent",
    scopes: ["invoices:send"],
    input: markSentParams.extend({ confirm_token: confirmTokenArg }),
    handler: async ({ id, confirm_token, ...wire }, { convex }) => {
      const doc = await resolveDispatchDoc(convex, id);
      return { id, ...(await markSentDocument(convex, markSentArgsOrThrow(doc, wire), confirm_token)) };
    },
  }),
];
