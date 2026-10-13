import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { encodeId } from "@/domain/api/ids";
import {
  cancelArgs,
  cancelWire,
  correctWire,
  creditChanges,
  documentId,
  rawDocumentId,
} from "@/domain/schemas/api/corrections";
import { ApiProblem } from "../../api/http";
import { correctionDraftWire } from "../../api/resources/corrections";
import { confirmTokenArg, defineTool } from "../tool";

/** F04 §7.2 Storno and corrections (06 §3.4). Storno only for unpaid invoices; formal defects → Berichtigung. */
export const correctionTools = [
  defineTool({
    name: "invoice_cancel",
    title: "Rechnung stornieren ⚠",
    description:
      '⚠ Storno (Stornorechnung, unumkehrbar) einer unbezahlten Rechnung oder einer nicht erstatteten Rechnungskorrektur. Zuerst document_preview {id, intent:"cancel", reason?, document_date?} aufrufen, den Spiegel zeigen, bestätigen lassen, dann mit confirm_token und denselben Angaben aufrufen. Bezahlte Rechnungen: invoice_create_correction (credit) + Erstattung; nur formale Fehler: kind rectification.',
    kind: "danger",
    confirmIntent: "invoice_cancel",
    scopes: ["invoices:cancel"],
    input: cancelWire.extend({ id: documentId, confirm_token: confirmTokenArg }),
    handler: async ({ id, confirm_token, ...w }, { convex }) => {
      const raw = rawDocumentId(id);
      if (!raw) throw new ApiProblem("not_found");
      const r = await convex.mutation(api.corrections.cancel, {
        ...cancelArgs(raw, w),
        confirmToken: confirm_token,
      } as never);
      return { id: encodeId("invoices", r.id), number: r.number, original_id: id, artifact_status: "pending" };
    },
  }),
  defineTool({
    name: "invoice_create_correction",
    title: "Korrekturentwurf anlegen",
    description:
      "Entwurf einer Rechnungskorrektur (kind credit: mindert Beträge; changes = neue Menge/neuer Einzelpreis je Position, ohne changes der volle Betrag) oder Rechnungsberichtigung (kind rectification: gleiche Beträge, nur formale Angaben wie Anschrift/USt-IdNr – diese vorher am Kontakt ändern). Korrekturen erhöhen nie Beträge; Nachberechnung = neue Rechnung.",
    kind: "write",
    scopes: ["documents:write"],
    input: correctWire.extend({ id: z.string().regex(/^inv_[0-9a-zA-Z]{16,64}$/, "Erwartet inv_…") }),
    handler: async ({ id, ...w }, { convex }) => {
      const raw = rawDocumentId(id);
      if (!raw) throw new ApiProblem("not_found");
      const changes = creditChanges(w);
      const r = await convex.mutation(api.corrections.createCorrection, {
        originalId: raw as never,
        kind: w.kind,
        ...(changes.length ? { changes } : {}),
      });
      return correctionDraftWire(convex, r.id, id);
    },
  }),
];
