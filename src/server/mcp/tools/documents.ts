import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { DOCUMENT_ID_PREFIXES, decodeDocumentId, decodeId } from "@/domain/api/ids";
import type { DraftType } from "@/domain/documents/doc-types";
import {
  acceptWire,
  convertWire,
  DOCUMENT_RESOURCES,
  type DocumentRecord,
  type DocumentResourceDef,
  documentCreateWire,
  documentFieldMapper,
  documentPatchWire,
  rejectWire,
  serializeDocument,
} from "@/domain/schemas/api/documents";
import { ApiProblem } from "../../api/http";
import {
  convertDocument,
  createDocumentDraft,
  loadChain,
  loadDocument,
  patchDocumentDraft,
} from "../../api/resources/documents";
import { defineTool } from "../tool";

/**
 * F04 §7.2 / 06 §3.4 document tools of this slice: search, get, quote and invoice drafts (standard, proforma),
 * draft updates, conversions and the manual acceptance/rejection of quotes. All W tools create or change drafts or
 * record a customer's answer — nothing is finalised here: `document_finalize` (⚠, confirm token from
 * `document_preview`) follows with the preview slice.
 */

const docId = z.string().max(100).meta({ description: "Beleg-ID (quo_…, ord_…, dln_…, inv_…)" });

const res = (path: DocumentResourceDef["path"]) =>
  DOCUMENT_RESOURCES.find((r) => r.path === path) as DocumentResourceDef;

/** Any sales-document ID of this slice → raw id + resource (prefix decides; `inv_` = invoice or proforma). */
function resolveId(value: string): { id: string; res: DocumentResourceDef } {
  for (const r of DOCUMENT_RESOURCES) {
    const raw = decodeDocumentId(r.idType, value);
    if (raw) return { id: raw, res: r };
  }
  throw new ApiProblem("not_found", {
    detail: `Unbekannte Beleg-ID. Erwartet ${Object.values(DOCUMENT_ID_PREFIXES).slice(0, 4).join(", ")}…`,
  });
}

const SEARCH_TYPES = ["quote", "order_confirmation", "delivery_note", "invoice", "proforma"] as const;

export const documentTools = [
  defineTool({
    name: "document_search",
    title: "Belege suchen",
    description:
      "Sucht Angebote, Auftragsbestätigungen, Lieferscheine, Rechnungen oder Proforma eines Typs (Standard: invoice). " +
      "Filter: status (draft, finalized, sent, accepted, rejected, expired, invoiced, paid …), contact_id, q (Kundenname).",
    kind: "read",
    scopes: ["documents:read"],
    input: z.object({
      type: z.enum(SEARCH_TYPES).optional(),
      status: z.string().max(40).optional(),
      contact_id: z.string().max(100).optional(),
      q: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().max(2000).optional(),
    }),
    handler: async (a, { convex }) => {
      const contactId = a.contact_id ? decodeId("contacts", a.contact_id) : null;
      if (a.contact_id && !contactId) throw new ApiProblem("not_found", { detail: "Unbekannte Kontakt-ID." });
      const page = await convex.query(api.documentsApi.list, {
        paginationOpts: { numItems: a.limit ?? 20, cursor: a.cursor ?? null },
        type: a.type ?? "invoice",
        ...(a.status ? { status: a.status } : {}),
        ...(contactId ? { contactId } : {}),
        ...(a.q ? { q: a.q } : {}),
      });
      return {
        data: page.page.map((r) => {
          const d = serializeDocument(r.doc as unknown as DocumentRecord, [], {
            displayStatus: r.displayStatus,
            related: {},
          });
          return {
            id: d.id,
            type: d.type,
            number: d.number,
            status: d.status,
            display_status: d.display_status_label,
            contact_name: d.contact_name,
            document_date: d.document_date,
            valid_until: d.valid_until,
            gross_cents: d.totals.gross_cents,
            currency: d.currency,
            invoiced_percent: d.invoiced_percent,
          };
        }),
        next_cursor: page.isDone ? null : page.continueCursor,
      };
    },
  }),
  defineTool({
    name: "document_get",
    title: "Beleg abrufen",
    description:
      "Vollständiger Beleg: Positionen, Summen, Status, Annahme/Ablehnung, Prüfergebnis (Entwürfe) und die Kette " +
      "(Angebot → Auftrag → Lieferscheine → Rechnungen) mit Abrechnungsfortschritt.",
    kind: "read",
    scopes: ["documents:read"],
    input: z.object({ id: docId }),
    handler: async ({ id }, { convex }) => {
      const r = resolveId(id);
      const doc = await loadDocument(convex, r.id, r.res.types, r.res.singular);
      return { ...doc, chain: await loadChain(convex, r.id as never) };
    },
  }),
  defineTool({
    name: "quote_create_draft",
    title: "Angebot als Entwurf anlegen",
    description:
      "Neuer Angebots-Entwurf: contact_id (con_…; vorher contact_search/contact_upsert), Positionen per product_id " +
      'oder Freitext (name, quantity "10", unit_price "95.00", vat_rate_key). valid_until optional (Standard aus den ' +
      "Einstellungen), optional: true markiert optionale Positionen. Antwort mit Summen und Prüfergebnis.",
    kind: "write",
    scopes: ["documents:write"],
    input: documentCreateWire.omit({ invoice_type: true, show_prices: true }),
    fieldMapper: documentFieldMapper,
    handler: async (a, { convex }) => createDocumentDraft(convex, res("quotes"), a),
  }),
  defineTool({
    name: "invoice_create_draft",
    title: "Rechnung als Entwurf anlegen",
    description:
      "Neuer Rechnungs-Entwurf (invoice_type standard oder proforma). supply_date (date/period/month) angeben – " +
      "ohne Leistungsdatum ist keine Fertigstellung möglich. Positionen per product_id oder Freitext.",
    kind: "write",
    scopes: ["documents:write"],
    input: documentCreateWire.omit({ valid_until: true, show_prices: true, delivery_terms: true }),
    fieldMapper: documentFieldMapper,
    handler: async (a, { convex }) => createDocumentDraft(convex, res("invoices"), a),
  }),
  defineTool({
    name: "document_update_draft",
    title: "Entwurf ändern",
    description:
      "Ändert einen Entwurf (nur übergebene Felder; lines ersetzt alle Positionen). version aus document_get ist Pflicht.",
    kind: "write",
    scopes: ["documents:write"],
    input: documentPatchWire.extend({ id: docId, version: z.number().int().min(1) }),
    fieldMapper: documentFieldMapper,
    handler: async ({ id, version, ...fields }, { convex }) => {
      const r = resolveId(id);
      return patchDocumentDraft(convex, r.res, r.id as never, version, fields);
    },
  }),
  defineTool({
    name: "document_convert",
    title: "Beleg umwandeln",
    description:
      "Neuer Entwurf aus einem fertiggestellten Beleg: Angebot → Auftragsbestätigung/Lieferschein/Proforma/Rechnung, " +
      "Auftrag → Lieferschein/Rechnung, Lieferschein → Rechnung (delivery_note_ids: Sammelrechnung). Teilmengen mit " +
      "mode quantities + lines; nie mehr als offen. Angebote müssen angenommen sein (oder accept_source: true nach " +
      "Rückfrage beim Nutzer).",
    kind: "write",
    scopes: ["documents:write"],
    input: convertWire.extend({ id: docId }),
    fieldMapper: documentFieldMapper,
    handler: async ({ id, ...body }, { convex }) => {
      const r = resolveId(id);
      const source = await loadDocument(convex, r.id, r.res.types, r.res.singular);
      return convertDocument(convex, r.id as never, body, source.type as DraftType);
    },
  }),
  defineTool({
    name: "quote_mark_accepted",
    title: "Angebot als angenommen markieren",
    description:
      "Erfasst die Annahme durch den Kunden (Datum, Name, Kanal email/phone/manual). Nur nach Angabe des Nutzers – " +
      "nie vermuten. Abgelaufene Angebote nur mit late: true.",
    kind: "write",
    scopes: ["documents:write"],
    input: acceptWire.extend({ id: docId }),
    fieldMapper: documentFieldMapper,
    handler: async ({ id, ...b }, { convex }) => {
      const r = quoteId(id);
      await convex.mutation(api.documentFlows.accept, {
        id: r as never,
        values: {
          date: b.date,
          byName: b.accepted_by,
          channel: b.channel,
          ...(b.note ? { note: b.note } : {}),
          ...(b.late ? { late: true } : {}),
        },
      });
      return loadDocument(convex, r, ["quote"], "Angebot");
    },
  }),
  defineTool({
    name: "quote_mark_rejected",
    title: "Angebot als abgelehnt markieren",
    description:
      "Erfasst die Ablehnung durch den Kunden (Datum, optional Grund). Danach ist eine neue Version möglich.",
    kind: "write",
    scopes: ["documents:write"],
    input: rejectWire.extend({ id: docId }),
    handler: async ({ id, ...b }, { convex }) => {
      const r = quoteId(id);
      await convex.mutation(api.documentFlows.reject, {
        id: r as never,
        values: { date: b.date, ...(b.reason ? { reason: b.reason } : {}) },
      });
      return loadDocument(convex, r, ["quote"], "Angebot");
    },
  }),
];

function quoteId(value: string): string {
  const raw = decodeDocumentId("quote", value);
  if (!raw) throw new ApiProblem("not_found", { detail: "Erwartet eine Angebots-ID (quo_…)." });
  return raw;
}
