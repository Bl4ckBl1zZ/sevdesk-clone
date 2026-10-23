import "server-only";
import { z } from "zod";
import { letterKindEnum, letterListQuery, letterRequestWire } from "@/domain/schemas/api/letters";
import { ApiProblem } from "../../api/http";
import { createLetter, listLetters, previewLetter } from "../../api/resources/receivable-letters";
import { defineTool } from "../tool";

/**
 * 06 §3.5 receivables letters (F05 PAY-005, PAY-048, DUN-028, DUN-044). Preview (R) and generate + archive (W: writes
 * only the immutable archive copy and its audit entry, transmits nothing — like `document_export`). „Als versendet
 * markieren“ is deliberately not an MCP tool: the Convex mutation carries no confirm intent, so it stays UI/REST
 * only (CLAUDE.md rule 8; 06 §3.5 note).
 */

const KINDS =
  "kind: account_statement (contact_id, from, to – Kontoauszug), payment_confirmation (payment_id – Zahlungsbestätigung), interest_claim (invoice_id – Zinsforderung nach vollständiger, verspäteter Zahlung), mahnbescheid_sheet (invoice_id – Mahnbescheid-Datenblatt).";

// MCP tool inputs are one flat object; the handler validates it with the shared discriminated wire schema.
const [statement, confirmation, claim] = letterRequestWire.options;
const flatInput = z.object({
  kind: letterKindEnum,
  ...statement.omit({ kind: true }).partial().shape,
  ...confirmation.omit({ kind: true }).partial().shape,
  ...claim.omit({ kind: true }).partial().shape,
});

function parseRequest(a: z.infer<typeof flatInput>) {
  const r = letterRequestWire.safeParse(Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)));
  if (!r.success) {
    throw new ApiProblem("validation_failed", {
      errors: r.error.issues.map((i) => ({ code: "invalid", field: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

export const letterTools = [
  defineTool({
    name: "receivable_letter_preview",
    title: "Forderungsschreiben – Vorschau",
    description: `Inhalt eines Forderungsschreibens (Betreff, Absätze, Tabelle, beim Datenblatt die JSON-Daten), ohne zu archivieren. ${KINDS}`,
    kind: "read",
    scopes: ["payments:read"],
    input: flatInput,
    handler: async (a, { convex }) => previewLetter(convex, parseRequest(a)),
  }),
  defineTool({
    name: "receivable_letter_create",
    title: "Forderungsschreiben erzeugen",
    description: `Erzeugt das PDF, archiviert es unveränderbar (SHA-256) und liefert einen kurzlebigen Download-Link (nur im Tailnet). Versendet nichts: der Inhaber verschickt es selbst und markiert es in der App als versendet. Nur auf Wunsch des Nutzers. ${KINDS}`,
    kind: "write",
    scopes: ["payments:read"],
    input: flatInput,
    handler: async (a, { convex }) => {
      const { content_base64: _bytes, ...r } = await createLetter(convex, parseRequest(a));
      return r;
    },
  }),
  defineTool({
    name: "receivable_letter_list",
    title: "Archivierte Forderungsschreiben",
    description:
      "Archivierte Schreiben eines Kontakts (contact_id) oder einer Rechnung (invoice_id) mit Versandvermerk.",
    kind: "read",
    scopes: ["payments:read"],
    input: letterListQuery,
    handler: async (q, { convex }) => ({ data: await listLetters(convex, q) }),
  }),
];
