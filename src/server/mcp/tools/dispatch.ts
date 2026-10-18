import "server-only";
import { api } from "@convex/_generated/api";
import type { z } from "zod";
import { dispatchDocId, documentExportWire, documentMarkSentWire, finalizeArgs } from "@/domain/schemas/api/dispatch";
import { finalizeWire } from "@/domain/schemas/api/documents";
import { ApiProblem } from "../../api/http";
import {
  exportDocument,
  markSentArgsOrThrow,
  markSentDocument,
  markSentPreviewOf,
  requireFinalizeScopes,
  resolveDispatchDoc,
} from "../../api/resources/dispatch";
import { confirmTokenArg, defineTool, type ToolContext } from "../tool";
import type { PreviewPlan } from "./previews";

/**
 * 06 §3.4 / F04 §7.2: ⚠ `document_finalize` (token from `document_preview`, intent finalize), `document_export` (W:
 * only the `document.export` audit entry; transmits nothing) and ⚠ `document_mark_sent` (token from
 * `preview_action { action: "document_mark_sent" }`). The app never sends a document (EC-189): the owner sends the
 * exported files and confirms how and when, then Claude records the mark.
 */

const FINALIZE_FAMILIES = ["quote", "order_confirmation", "delivery_note", "invoice", "correction"] as const;

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
      "⚠ Stellt einen Entwurf fertig (Nummer, eingefrorener Inhalt, PDF/E-Rechnung; unumkehrbar). Zuerst document_preview {id} (intent finalize, dieselben document_date/backdate_reason/overrides) aufrufen, Summen, Steuerfall und ER-03 zeigen, bestätigen lassen, dann mit confirm_token und der version aus der Vorschau. Danach document_export; versenden macht der Inhaber selbst.",
    kind: "danger",
    confirmIntent: "document_finalize",
    scopes: ["invoices:finalize"],
    input: finalizeWire.extend({ id: dispatchDocId, confirm_token: confirmTokenArg }),
    handler: async ({ id, confirm_token, ...w }, { convex, key }) => {
      const doc = await resolveDispatchDoc(convex, id, FINALIZE_FAMILIES);
      requireFinalizeScopes(key, doc.type);
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
