import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { decodeDocumentId, encodeDocumentId, encodeId } from "@/domain/api/ids";
import { objectionIssue } from "@/domain/documents/self-billing";
import {
  cancelArgs,
  cancelWire,
  correctWire,
  creditChanges,
  objectionArgs,
  objectionWire,
  rawDocumentId,
} from "@/domain/schemas/api/corrections";
import { berlinCalendarDate } from "@/domain/time/berlin";
import { ApiProblem } from "../../api/http";
import { correctionDraftWire } from "../../api/resources/corrections";
import { loadDocument } from "../../api/resources/documents";
import { confirmTokenArg, defineTool, type ToolContext } from "../tool";

const cancelId = z
  .string()
  .regex(/^(inv|cor|sbc)_[0-9a-zA-Z]{16,64}$/, "Erwartet eine Beleg-ID (inv_…, cor_… oder sbc_…).")
  .meta({ description: "Beleg-ID (inv_… Rechnung, cor_… Korrektur, sbc_… Gutschrift → Widerspruch)" });

function rawSelfBillingId(value: string): string {
  const raw = decodeDocumentId("self_billing", value);
  if (!raw) throw new ApiProblem("not_found", { detail: "Gutschrift nicht gefunden." });
  return raw;
}

/**
 * The objection of `invoice_cancel` / `document_preview` with an `sbc_…` id: `reason` = the objection text (required),
 * `document_date` = the objection date (default today). Preview and act use this one mapping, so the token binds both.
 */
function objectionInput(reason: string | undefined, date: string | undefined) {
  const parsed = objectionWire.safeParse({
    reason: reason?.trim() ?? "",
    objection_date: date ?? berlinCalendarDate(Date.now()),
  });
  if (!parsed.success) {
    throw new ApiProblem("validation_failed", {
      errors: parsed.error.issues.map((i) => ({
        code: "invalid",
        field: i.path[0] === "objection_date" ? "document_date" : "reason",
        message: i.path[0] === "reason" ? "Bitte den Inhalt des Widerspruchs als reason angeben." : i.message,
      })),
    });
  }
  return parsed.data;
}

/**
 * `document_preview { id: "sbc_…", intent: "cancel", reason, document_date }` (F04 §4.9, INV-16): what the objection
 * does — the Gutschrift, the mirror cancellation dated on the objection date and the reversed purchase voucher —
 * with the same rule check as the model (`objectionIssue`). No token while the objection is not possible.
 */
export async function objectionPreviewOf(
  ctx: ToolContext,
  wireId: string,
  input: { reason?: string | undefined; objection_date?: string | undefined },
) {
  const raw = rawSelfBillingId(wireId);
  const doc = await loadDocument(ctx.convex, raw, ["self_billing"], "Gutschrift");
  const today = berlinCalendarDate(Date.now());
  const w = objectionInput(input.reason, input.objection_date);
  const issue = objectionIssue({
    type: doc.type,
    status: doc.status,
    documentDate: doc.document_date ?? "",
    date: w.objection_date,
    text: w.reason,
    today,
  });
  const wire = {
    allowed: issue === null,
    id: wireId,
    number: doc.number,
    status: doc.status,
    document_date: doc.document_date,
    contact_name: doc.contact_name,
    gross_cents: doc.totals.gross_cents,
    objection_date: w.objection_date,
    reason: w.reason,
    errors: issue ? [{ code: "objection_invalid", message: issue, rule: "UST-33" }] : [],
    effect:
      "Der Widerspruch wird mit Datum und Inhalt festgehalten; eine Spiegel-Stornorechnung zum Widerspruchsdatum hebt die Gutschrift auf und der Einkaufsbeleg wird storniert. Unumkehrbar.",
  };
  return { wire, args: objectionArgs(raw, w), raw };
}

/** F04 §7.2 Storno and corrections (06 §3.4). Storno only for unpaid invoices; formal defects → Berichtigung. */
export const correctionTools = [
  defineTool({
    name: "invoice_cancel",
    title: "Rechnung stornieren ⚠",
    description:
      '⚠ Storno (Stornorechnung, unumkehrbar) einer unbezahlten Rechnung oder einer nicht erstatteten Rechnungskorrektur. Zuerst document_preview {id, intent:"cancel", reason?, document_date?} aufrufen, den Spiegel zeigen, bestätigen lassen, dann mit confirm_token und denselben Angaben aufrufen. Bezahlte Rechnungen: invoice_create_correction (credit) + Erstattung; nur formale Fehler: kind rectification. Gutschrift (sbc_…): erfasst den Widerspruch des Lieferanten (reason = Inhalt, Pflicht; document_date = Widerspruchsdatum, Standard heute) und storniert Gutschrift und Einkaufsbeleg – nur nach Angabe des Nutzers.',
    kind: "danger",
    confirmIntent: "invoice_cancel",
    scopes: ["invoices:cancel"],
    input: cancelWire.extend({ id: cancelId, confirm_token: confirmTokenArg }),
    handler: async ({ id, confirm_token, ...w }, { convex, key }) => {
      if (id.startsWith("sbc_")) {
        // F04 §4.9 INV-16: the supplier's objection (Widerspruch) — corrections.recordObjection, intent invoice_cancel.
        if (!key.scopes.includes("invoices:finalize")) {
          throw new ApiProblem("insufficient_scope", {
            extra: { required_scope: "invoices:cancel invoices:finalize" },
          });
        }
        const sb = rawSelfBillingId(id);
        const r = await convex.mutation(api.corrections.recordObjection, {
          ...objectionArgs(sb, objectionInput(w.reason, w.document_date)),
          confirmToken: confirm_token,
        } as never);
        return {
          id: encodeDocumentId("cancellation", r.cancellationId),
          number: r.number,
          original_id: id,
          artifact_status: "pending",
        };
      }
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
