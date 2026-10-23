import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { decodeDocumentId, decodeId, encodeId } from "@/domain/api/ids";
import { sha256Hex } from "@/domain/audit/chain";
import {
  type LetterContentLike,
  type LetterRequestWire,
  type LetterRowLike,
  letterCreatedOut,
  letterListQuery,
  letterMarkSentWire,
  letterOut,
  letterPreviewOut,
  letterRequestArgs,
  letterRequestWire,
  serializeLetter,
  serializeLetterPreview,
} from "@/domain/schemas/api/letters";
import type { ConvexCaller } from "../backend";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";
import { idParams, rawId } from "./shared";

/**
 * 05 §4.4 `/receivable-letters` (F05 PAY-005, PAY-048, DUN-028, DUN-044): preview, generate + archive (PDF with
 * SHA-256, Mahnbescheid data as JSON), list per contact or invoice and „Als versendet markieren“. Thin wire ⇄ Convex
 * mapping over convex/payments.ts (`letterPreview`, `letter`, `letters`, `markLetterSent`); the app never sends (B2).
 */

const TAG = "Forderungsschreiben";

function requestOf(w: LetterRequestWire) {
  const r = letterRequestArgs(w);
  if (!r) throw new ApiProblem("not_found");
  return r;
}

export async function previewLetter(convex: ConvexCaller, w: LetterRequestWire) {
  const p = await convex.query(api.payments.letterPreview, { request: requestOf(w) as never });
  return serializeLetterPreview({ content: p.content as unknown as LetterContentLike, data: p.data });
}

/** Renders and archives the letter; returns the archived bytes and their SHA-256. */
export async function createLetter(convex: ConvexCaller, w: LetterRequestWire) {
  const r = await convex.action(api.payments.letter, { request: requestOf(w) as never });
  const bytes = Uint8Array.from(atob(r.pdfBase64), (ch) => ch.charCodeAt(0));
  return {
    id: encodeId("receivableLetters", r.letterId),
    file_name: r.name,
    sha256: await sha256Hex(bytes),
    url: r.url,
    content_base64: r.pdfBase64,
    data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : null,
  };
}

export async function listLetters(convex: ConvexCaller, q: z.infer<typeof letterListQuery>) {
  if (!q.contact_id && !q.invoice_id) {
    throw new ApiProblem("validation_failed", {
      errors: [{ code: "required", field: "contact_id", message: "Bitte contact_id oder invoice_id angeben." }],
    });
  }
  const contactId = q.contact_id ? decodeId("contacts", q.contact_id) : undefined;
  const documentId = q.invoice_id ? decodeDocumentId("invoice", q.invoice_id) : undefined;
  if (contactId === null || documentId === null) throw new ApiProblem("not_found");
  const rows = await convex.query(api.payments.letters, {
    ...(contactId ? { contactId: contactId as never } : {}),
    ...(documentId ? { documentId: documentId as never } : {}),
  });
  return rows.map((r) => serializeLetter(r as unknown as LetterRowLike));
}

export const receivableLettersResource = defineResource(
  "receivable-letters",
  "Forderungsschreiben: Kontoauszug, Zahlungsbestätigung, Zinsforderung, Mahnbescheid-Datenblatt",
  [
    defineEndpoint({
      method: "POST",
      path: "/receivable-letters/preview",
      operationId: "previewReceivableLetter",
      summary: "Forderungsschreiben prüfen (Vorschau)",
      description:
        "Inhalt des Schreibens (Betreff, Absätze, Tabelle, Datenblatt) ohne zu archivieren. Kontoauszug (PAY-005) für einen Zeitraum bis heute, Zahlungsbestätigung (PAY-048), Zinsforderung nach vollständiger, verspäteter Zahlung (DUN-028) und Mahnbescheid-Datenblatt (DUN-044).",
      tag: TAG,
      scope: "payments:read",
      body: letterRequestWire,
      response: { status: 200, schema: letterPreviewOut, description: "Der Inhalt" },
      errors: ["not_found", "validation_failed"],
      handler: async ({ convex, body }) => ({ body: await previewLetter(convex, body) }),
    }),
    defineEndpoint({
      method: "POST",
      path: "/receivable-letters",
      operationId: "createReceivableLetter",
      summary: "Forderungsschreiben erzeugen und archivieren",
      description:
        "Erzeugt das PDF (Geschäftsbrief-Fußzeile), archiviert es unveränderbar mit SHA-256 und liefert es Base64-kodiert zurück; beim Mahnbescheid-Datenblatt zusätzlich die Daten als JSON für online-mahnantrag.de. Versendet nichts — danach `mark-sent`.",
      tag: TAG,
      scope: "payments:read",
      body: letterRequestWire,
      response: { status: 201, schema: letterCreatedOut, description: "Das archivierte Schreiben" },
      errors: ["not_found", "validation_failed"],
      handler: async ({ convex, body }) => {
        const { url: _url, ...r } = await createLetter(convex, body);
        return { status: 201, body: { ...r, content_type: "application/pdf" } };
      },
    }),
    defineEndpoint({
      method: "GET",
      path: "/receivable-letters",
      operationId: "listReceivableLetters",
      summary: "Archivierte Forderungsschreiben",
      description: "Die Schreiben eines Kontakts (`contact_id`) oder einer Rechnung (`invoice_id`), neueste zuerst.",
      tag: TAG,
      scope: "payments:read",
      query: letterListQuery,
      response: { status: 200, schema: z.object({ data: z.array(letterOut) }), description: "Die Schreiben" },
      errors: ["not_found", "validation_failed"],
      handler: async ({ convex, query }) => ({ body: { data: await listLetters(convex, query) } }),
    }),
    defineEndpoint({
      method: "POST",
      path: "/receivable-letters/{id}/mark-sent",
      operationId: "markReceivableLetterSent",
      summary: "Forderungsschreiben als versendet markieren",
      description:
        "Einmalig, nachdem der Inhaber das Schreiben selbst übergeben hat (Datum zwischen Briefdatum und heute; Kanal „Sonstiges“ mit Notiz). Danach unveränderbar. `Idempotency-Key` ist Pflicht. Nicht über MCP.",
      tag: TAG,
      scope: "dunning:write",
      params: idParams("receivableLetters"),
      body: letterMarkSentWire,
      idempotency: "required",
      response: {
        status: 200,
        schema: z.object({ id: z.string(), sent: letterOut.shape.sent }).meta({ id: "ReceivableLetterMarkSentResult" }),
        description: "Der Versandvermerk",
      },
      errors: ["not_found", "validation_failed", "conflict", "idempotency_key_required"],
      handler: async ({ convex, params, body }) => {
        await convex.mutation(api.payments.markLetterSent, {
          id: rawId("receivableLetters", params.id) as never,
          sentOn: body.sent_on,
          channel: body.channel as never,
          ...(body.note ? { note: body.note } : {}),
        });
        return {
          body: {
            id: params.id,
            sent: { sent_on: body.sent_on, channel: body.channel, note: body.note?.trim() || null },
          },
        };
      },
    }),
  ],
);
