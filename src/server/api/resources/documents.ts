import "server-only";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { z } from "zod";
import { DOCUMENT_ID_PREFIXES, decodeDocumentId, decodeId } from "@/domain/api/ids";
import { DRAFT_TYPES, type DraftType } from "@/domain/documents/doc-types";
import type { SalesDocType } from "@/domain/documents/snapshot";
import { decimalToScaled } from "@/domain/schemas/api/common";
import {
  acceptWire,
  chainOut,
  convertOut,
  convertWire,
  DOCUMENT_RESOURCES,
  type DocumentCreateWire,
  type DocumentLineWire,
  type DocumentPatchWire,
  type DocumentRecord,
  type DocumentResourceDef,
  decodeLineId,
  documentCreateWire,
  documentFieldMapper,
  documentList,
  documentListQuery,
  documentOut,
  documentPatchWire,
  encodeDoc,
  finalizeWire,
  type LineRecord,
  lineToDraft,
  reasonWire,
  receivedWire,
  rejectWire,
  reviseWire,
  serializeDocument,
  type WireIssue,
  wireToDraft,
} from "@/domain/schemas/api/documents";
import type { DraftValues } from "@/domain/schemas/documents";
import type { ConvexCaller } from "../backend";
import { type AnyEndpoint, defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";
import { expandOf, expandQueryParam, nextCursor, paginationOpts, requireVersion } from "./shared";

/**
 * 05 §4.3 / F04 §7.1 sales documents in this slice: quotes, order confirmations, delivery notes and invoices
 * (standard + proforma). Every resource shares list/create/get/patch/delete/finalize/convert/withdraw; quotes add
 * mark-accepted/mark-rejected/reopen/revise, delivery notes mark-received. The handlers only map wire ⇄ the shared
 * draft schema; all rules run in convex/invoices.ts and convex/documentFlows.ts.
 */

type DocId = Id<"salesDocuments">;

const docParams = (res: DocumentResourceDef) =>
  z.object({
    id: z
      .string()
      .regex(
        new RegExp(`^${DOCUMENT_ID_PREFIXES[res.idType]}[0-9a-zA-Z]{16,64}$`),
        `Erwartet eine ID mit Präfix ${DOCUMENT_ID_PREFIXES[res.idType]}.`,
      )
      .meta({
        description: `${res.singular} (${DOCUMENT_ID_PREFIXES[res.idType]}…)`,
        example: `${DOCUMENT_ID_PREFIXES[res.idType]}k57f3x2m9q8w1e4r6t`,
      }),
  });

export function rawDocId(res: DocumentResourceDef, id: string): DocId {
  const raw = decodeDocumentId(res.idType, id);
  if (!raw) throw new ApiProblem("not_found");
  return raw as DocId;
}

function invalid(issues: readonly WireIssue[]): never {
  throw new ApiProblem("validation_failed", {
    errors: issues.map((i) => ({ code: "invalid", field: i.field, message: i.message })),
  });
}

/** One document in its wire shape (404 when it does not belong to `types`). */
export async function loadDocument(convex: ConvexCaller, id: string, types: readonly DraftType[], label = "Dokument") {
  const row = await convex.query(api.documentsApi.get, { id, types: [...types] });
  if (!row) throw new ApiProblem("not_found", { detail: `${label} nicht gefunden.` });
  return serializeDocument(row.doc as unknown as DocumentRecord, row.lines as unknown as LineRecord[], {
    displayStatus: row.displayStatus,
    related: row.related,
    validation: row.validation,
    canFinalize: row.canFinalize,
  });
}

/** The chain („Verknüpft“, DOC-34) with invoicing progress. */
export async function loadChain(convex: ConvexCaller, id: DocId) {
  const chain = await convex.query(api.documentFlows.chain, { id });
  if (!chain) throw new ApiProblem("not_found");
  return {
    data: chain.documents.map((d) => ({
      id: encodeDoc(d.type as SalesDocType, d._id),
      type: d.type,
      status: d.status,
      number: d.number,
      document_date: d.documentDate,
      revision: d.revision,
      gross_cents: d.grossCents,
      invoiced_percent: d.coveredBp / 100,
      is_current: d.isCurrent,
    })),
    invoiced_percent: chain.coveredBp / 100,
    conversion_targets: chain.targets,
  };
}

/** Wire lines → draft lines; product lines take name, price, unit and tax key from the product (DOC-05/06). */
async function linesToDraft(
  convex: ConvexCaller,
  lines: readonly DocumentLineWire[],
  ctx: { contactId?: string; referenceDate: string; priceMode: "net" | "gross"; currency: string },
  issues: WireIssue[],
): Promise<DraftValues["lines"]> {
  const out: DraftValues["lines"] = [];
  for (const [i, l] of lines.entries()) {
    const line = lineToDraft(l, i, issues);
    if (line.productId) {
      const p = await convex.query(api.invoices.productLine, {
        productId: line.productId as Id<"products">,
        ...(ctx.contactId ? { contactId: ctx.contactId as Id<"contacts"> } : {}),
        referenceDate: ctx.referenceDate,
        priceMode: ctx.priceMode,
        currency: ctx.currency,
      });
      out.push({ ...p.line, ...line } as DraftValues["lines"][number]);
    } else out.push(line);
  }
  return out;
}

function typeFor(res: DocumentResourceDef, invoiceType: "standard" | "proforma" | undefined): DraftType {
  if (res.path !== "invoices") {
    if (invoiceType) invalid([{ field: "invoice_type", message: "Nur für /invoices." }]);
    return res.types[0] as DraftType;
  }
  return invoiceType === "proforma" ? "proforma" : "invoice";
}

/** POST /{type} and MCP `*_create_draft`: creates the draft and returns it with totals and validation. */
export async function createDocumentDraft(convex: ConvexCaller, res: DocumentResourceDef, body: DocumentCreateWire) {
  const type = typeFor(res, body.invoice_type);
  const issues: WireIssue[] = [];
  const contactId = body.contact_id ? decodeId("contacts", body.contact_id) : null;
  if (body.contact_id && !contactId) invalid([{ field: "contact_id", message: "Unbekannte Kontakt-ID." }]);
  const defaults = await convex.query(
    api.invoices.draftDefaults,
    contactId ? { contactId: contactId as Id<"contacts"> } : {},
  );
  const priceMode = body.price_mode ?? defaults.priceMode;
  const currency = body.currency ?? defaults.currency;
  const lines = await linesToDraft(
    convex,
    body.lines,
    { ...(contactId ? { contactId } : {}), referenceDate: body.document_date ?? defaults.today, priceMode, currency },
    issues,
  );
  const { values, issues: more } = wireToDraft({ ...body, lines }, type, {
    currency: defaults.currency,
    language: defaults.language,
    priceMode: defaults.priceMode,
    paymentTerms: defaults.paymentTerms,
  });
  issues.push(...more);
  if (issues.length > 0) invalid(issues);
  const draft: DraftValues = {
    ...values,
    ...(defaults.paymentMethodId && !values.paymentMethodId ? { paymentMethodId: defaults.paymentMethodId } : {}),
    ...(defaults.bankAccountId && !values.bankAccountId ? { bankAccountId: defaults.bankAccountId } : {}),
    ...(defaults.buyerReference && !values.buyerReference ? { buyerReference: defaults.buyerReference } : {}),
  };
  const { id } = await convex.mutation(api.invoices.createDraft, { values: draft });
  return loadDocument(convex, id, res.types, res.singular);
}

/** PATCH /{type}/{id}: merges the given fields onto the current draft values (drafts only, 409 otherwise). */
export async function patchDocumentDraft(
  convex: ConvexCaller,
  res: DocumentResourceDef,
  id: DocId,
  version: number,
  fields: Omit<DocumentPatchWire, "version">,
) {
  const current = await convex.query(api.invoices.get, { id });
  if (!current || !(res.types as readonly string[]).includes(current.doc.type)) throw new ApiProblem("not_found");
  if (!("values" in current) || current.doc.status !== "draft") {
    throw new ApiProblem("immutable_record", { detail: "Nur Entwürfe können geändert werden." });
  }
  if (fields.invoice_type && typeFor(res, fields.invoice_type) !== current.doc.type) {
    invalid([{ field: "invoice_type", message: "Der Typ eines Entwurfs kann nicht geändert werden." }]);
  }
  const base = current.values as unknown as DraftValues;
  const issues: WireIssue[] = [];
  const lines = fields.lines
    ? await linesToDraft(
        convex,
        fields.lines,
        {
          ...(base.contactId ? { contactId: base.contactId } : {}),
          referenceDate: base.documentDate ?? new Date().toISOString().slice(0, 10),
          priceMode: fields.price_mode ?? base.priceMode,
          currency: fields.currency ?? base.currency,
        },
        issues,
      )
    : base.lines;
  const { values, issues: more } = wireToDraft(
    { ...fields, lines },
    current.doc.type as DraftType,
    {
      currency: base.currency,
      language: base.language,
      priceMode: base.priceMode,
      paymentTerms: base.paymentTerms,
    },
    base,
  );
  issues.push(...more);
  if (issues.length > 0) invalid(issues);
  await convex.mutation(api.invoices.updateDraft, { id, version, values });
  return loadDocument(convex, id, res.types, res.singular);
}

/** POST /{type}/{id}/convert (DOC-33) and the collective invoice from delivery notes (QUO-11). */
export async function convertDocument(
  convex: ConvexCaller,
  id: DocId,
  body: z.output<typeof convertWire>,
  sourceType: DraftType,
) {
  if (body.delivery_note_ids && body.delivery_note_ids.length > 0) {
    if (sourceType !== "delivery_note" || body.to !== "invoice") {
      invalid([{ field: "delivery_note_ids", message: "Nur beim Umwandeln von Lieferscheinen in eine Rechnung." }]);
    }
    const others = body.delivery_note_ids.map((s, i) => {
      const raw = decodeDocumentId("delivery_note", s);
      if (!raw) invalid([{ field: `delivery_note_ids[${i}]`, message: "Erwartet eine Lieferschein-ID (dln_…)." }]);
      return raw;
    });
    const ids = [id, ...others.filter((o) => o !== id)];
    const r = await convex.mutation(api.documentFlows.collectiveInvoice, { values: { deliveryNoteIds: ids } });
    return { document: await loadDocument(convex, r.id, DRAFT_TYPES), notices: r.notices.map(String) };
  }
  const quantities: Record<string, number> = {};
  for (const [i, l] of (body.lines ?? []).entries()) {
    const raw = decodeLineId(l.source_line_id);
    const q = decimalToScaled(l.quantity, 3);
    if (!raw || q === null || q < 0) {
      invalid([{ field: `lines[${i}]`, message: "Ungültige Position oder Menge." }]);
    }
    quantities[raw] = q;
  }
  const optionalLineIds = (body.optional_line_ids ?? []).map((s, i) => {
    const raw = decodeLineId(s);
    if (!raw) invalid([{ field: `optional_line_ids[${i}]`, message: "Ungültige Positions-ID." }]);
    return raw;
  });
  const r = await convex.mutation(api.documentFlows.convert, {
    id,
    values: {
      to: body.to,
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.lines ? { quantities } : {}),
      ...(optionalLineIds.length > 0 ? { optionalLineIds } : {}),
      ...(body.accept_source ? { acceptSource: true } : {}),
    },
  });
  return { document: await loadDocument(convex, r.id, DRAFT_TYPES), notices: r.notices.map(String) };
}

/** POST /{type}/{id}/finalize: the full pipeline (02 §6); errors before the commit consume no number. */
export async function finalizeDocument(
  convex: ConvexCaller,
  res: DocumentResourceDef,
  id: DocId,
  body: z.output<typeof finalizeWire>,
) {
  await loadDocument(convex, id, res.types, res.singular);
  await convex.action(api.invoices.finalize, {
    id,
    version: body.version,
    ...(body.document_date ? { documentDate: body.document_date } : {}),
    ...(body.backdate_reason ? { backdateReason: body.backdate_reason } : {}),
    ...(body.overrides
      ? {
          overrides: {
            ...(body.overrides.vat_id_unverified_reason
              ? { vatCheck: { reason: body.overrides.vat_id_unverified_reason } }
              : {}),
            ...(body.overrides.rc13b_confirmation
              ? { rc13bCertificate: { reason: body.overrides.rc13b_confirmation } }
              : {}),
          },
        }
      : {}),
  });
  return loadDocument(convex, id, res.types, res.singular);
}

const DOCUMENT_ERRORS = ["not_found", "validation_failed", "conflict", "illegal_transition"] as const;

function sharedEndpoints(res: DocumentResourceDef): AnyEndpoint[] {
  const base = `/${res.path}`;
  const params = docParams(res);
  const op = (verb: string) => `${verb}${res.schemaPrefix}`;
  const isInvoices = res.path === "invoices";
  const endpoints: AnyEndpoint[] = [
    defineEndpoint({
      method: "GET",
      path: base,
      operationId: `list${res.schemaPrefix === "OrderConfirmation" ? "OrderConfirmations" : `${res.schemaPrefix}s`}`,
      summary: `${res.plural} auflisten`,
      description: isInvoices
        ? "Filter `status`, `contact_id`, `q` (Kundenname), `invoice_type` (`standard` Standard, `proforma`)."
        : "Filter `status`, `contact_id`, `q` (Kundenname). Neueste zuerst.",
      tag: res.tag,
      scope: "documents:read",
      query: documentListQuery,
      response: { status: 200, schema: documentList, description: `Eine Seite ${res.plural}` },
      handler: async ({ convex, query }) => {
        const type = typeFor(res, isInvoices ? query.invoice_type : undefined);
        const contactId = query.contact_id ? decodeId("contacts", query.contact_id) : null;
        if (query.contact_id && !contactId) return { body: { data: [], next_cursor: null } };
        const page = await convex.query(api.documentsApi.list, {
          paginationOpts: paginationOpts(query),
          type,
          ...(query.status ? { status: query.status } : {}),
          ...(contactId ? { contactId } : {}),
          ...(query.q ? { q: query.q } : {}),
        });
        return {
          body: {
            data: page.page.map((r) =>
              serializeDocument(r.doc as unknown as DocumentRecord, [], {
                displayStatus: r.displayStatus,
                related: {},
              }),
            ),
            next_cursor: nextCursor(page),
          },
        };
      },
    }),
    defineEndpoint({
      method: "POST",
      path: base,
      operationId: op("create"),
      summary: `${res.singular} als Entwurf anlegen`,
      description:
        "Legt einen **Entwurf** an. Mengen und Preise als Dezimalstrings mit Punkt; `product_id` übernimmt Name, Preis, " +
        "Einheit und Steuerschlüssel des Produkts. Antwort mit Summen und Prüfergebnis (`validation`). `Idempotency-Key` wird unterstützt.",
      tag: res.tag,
      scope: "documents:write",
      body: documentCreateWire,
      response: { status: 201, schema: documentOut, description: "Entwurf angelegt" },
      errors: ["validation_failed", "not_found", "idempotency_key_reused"],
      fieldMapper: documentFieldMapper,
      handler: async ({ convex, body }) => {
        const doc = await createDocumentDraft(convex, res, body);
        return { status: 201, body: doc, headers: { Location: `/api/v1${base}/${doc.id}` } };
      },
    }),
    defineEndpoint({
      method: "GET",
      path: `${base}/{id}`,
      operationId: op("get"),
      summary: `${res.singular} abrufen`,
      description:
        "Mit Positionen, Summen, Status und (bei Entwürfen) dem Prüfergebnis. `expand=chain` fügt die Kette an.",
      tag: res.tag,
      scope: "documents:read",
      params,
      query: z.object({ expand: expandQueryParam(["chain"]) }),
      response: { status: 200, schema: documentOut, description: res.singular },
      errors: ["not_found", "invalid_expand"],
      handler: async ({ convex, params: p, query }) => {
        const expand = expandOf(query.expand, ["chain"]);
        const id = rawDocId(res, p.id);
        const doc = await loadDocument(convex, id, res.types, res.singular);
        return { body: expand.has("chain") ? { ...doc, chain: await loadChain(convex, id) } : doc };
      },
    }),
    defineEndpoint({
      method: "PATCH",
      path: `${base}/{id}`,
      operationId: op("update"),
      summary: `${res.singular} (Entwurf) ändern`,
      description:
        "Nur Entwürfe. Übergebene Felder werden ersetzt, `lines` ersetzt alle Positionen. `version` oder `If-Match` ist Pflicht.",
      tag: res.tag,
      scope: "documents:write",
      params,
      body: documentPatchWire,
      response: { status: 200, schema: documentOut, description: "Der geänderte Entwurf" },
      errors: ["not_found", "validation_failed", "version_conflict", "immutable_record"],
      fieldMapper: documentFieldMapper,
      handler: async ({ convex, params: p, body, ifMatch }) => {
        const { version: bodyVersion, ...fields } = body;
        const version = requireVersion(ifMatch, bodyVersion);
        return { body: await patchDocumentDraft(convex, res, rawDocId(res, p.id), version, fields) };
      },
    }),
    defineEndpoint({
      method: "DELETE",
      path: `${base}/{id}`,
      operationId: op("delete"),
      summary: `${res.singular} (Entwurf) löschen`,
      description: "Nur Entwürfe; die Löschung wird mit Inhalt protokolliert. Fertiggestellte Dokumente → 409.",
      tag: res.tag,
      scope: "documents:write",
      params,
      response: { status: 204, description: "Gelöscht" },
      errors: ["not_found", "immutable_record"],
      handler: async ({ convex, params: p }) => {
        const id = rawDocId(res, p.id);
        await loadDocument(convex, id, res.types, res.singular);
        await convex.mutation(api.invoices.deleteDraft, { id });
        return { status: 204 };
      },
    }),
    defineEndpoint({
      method: "POST",
      path: `${base}/{id}/finalize`,
      operationId: op("finalize"),
      summary: `${res.singular} fertigstellen`,
      description:
        "Vergibt die Nummer, friert den Inhalt ein und erzeugt PDF (und bei Rechnungen die E-Rechnung). " +
        "Angebote, Auftragsbestätigungen, Lieferscheine und Proforma buchen nichts. `Idempotency-Key` ist Pflicht.",
      tag: res.tag,
      scope: "invoices:finalize",
      params,
      body: finalizeWire,
      idempotency: "required",
      response: { status: 200, schema: documentOut, description: "Das fertiggestellte Dokument" },
      errors: [
        "not_found",
        "validation_failed",
        "version_conflict",
        "immutable_record",
        "revalidation_failed",
        "einvoice_validation_failed",
        "dependency_unavailable",
        "idempotency_key_required",
      ],
      fieldMapper: documentFieldMapper,
      handler: async ({ convex, params: p, body }) => ({
        body: await finalizeDocument(convex, res, rawDocId(res, p.id), body),
      }),
    }),
    defineEndpoint({
      method: "POST",
      path: `${base}/{id}/convert`,
      operationId: op("convert"),
      summary: `${res.singular} umwandeln`,
      description:
        "Neuer Entwurf aus diesem Dokument (DOC-33): `to` = order_confirmation | delivery_note | proforma | invoice. " +
        "`mode: quantities` mit `lines` für Teilmengen; nie mehr als offen (QUO-13). Angebote müssen angenommen sein " +
        "(`accept_source: true` markiert sie dabei als angenommen)." +
        (res.path === "delivery-notes"
          ? " `delivery_note_ids` fasst weitere Lieferscheine zu einer Sammelrechnung zusammen."
          : ""),
      tag: res.tag,
      scope: "documents:write",
      params,
      body: convertWire,
      response: { status: 201, schema: convertOut, description: "Der neue Entwurf und Hinweise" },
      errors: [...DOCUMENT_ERRORS],
      fieldMapper: documentFieldMapper,
      handler: async ({ convex, params: p, body }) => {
        const id = rawDocId(res, p.id);
        const source = await loadDocument(convex, id, res.types, res.singular);
        const r = await convertDocument(convex, id, body, source.type as DraftType);
        return { status: 201, body: r, headers: { Location: `/api/v1/${pathOf(r.document.type)}/${r.document.id}` } };
      },
    }),
    defineEndpoint({
      method: "POST",
      path: `${base}/{id}/withdraw`,
      operationId: op("withdraw"),
      summary: `${res.singular} zurückziehen`,
      description: isInvoices
        ? "Nur Proforma: Status „Storniert“, die Nummer bleibt verbraucht. Rechnungen werden storniert (`/cancel`)."
        : "Status „Storniert“, die Nummer bleibt verbraucht. Nicht möglich, solange Rechnungen aus dem Dokument bestehen.",
      tag: res.tag,
      scope: "documents:write",
      params,
      body: reasonWire,
      response: { status: 200, schema: documentOut, description: "Das zurückgezogene Dokument" },
      errors: [...DOCUMENT_ERRORS],
      handler: async ({ convex, params: p, body }) => {
        const id = rawDocId(res, p.id);
        await loadDocument(convex, id, res.types, res.singular);
        await convex.mutation(api.documentFlows.withdraw, { id, values: { reason: body.reason } });
        return { body: await loadDocument(convex, id, res.types, res.singular) };
      },
    }),
  ];
  // `/invoices/{id}/chain` belongs to the invoice-correction slice (Storno/Abschläge); the letters get theirs here.
  if (!isInvoices) {
    endpoints.push(
      defineEndpoint({
        method: "GET",
        path: `${base}/{id}/chain`,
        operationId: op("chainOf"),
        summary: "Verknüpfte Dokumente",
        description: "Angebot → Auftragsbestätigung → Lieferscheine → Rechnungen mit Abrechnungsfortschritt (DOC-34).",
        tag: res.tag,
        scope: "documents:read",
        params,
        response: { status: 200, schema: chainOut, description: "Die Kette" },
        errors: ["not_found"],
        handler: async ({ convex, params: p }) => {
          const id = rawDocId(res, p.id);
          await loadDocument(convex, id, res.types, res.singular);
          return { body: await loadChain(convex, id) };
        },
      }),
    );
  }
  return endpoints;
}

const pathOf = (type: string) =>
  DOCUMENT_RESOURCES.find((r) => (r.types as readonly string[]).includes(type))?.path ?? "invoices";

function flow(
  res: DocumentResourceDef,
  path: string,
  operationId: string,
  summary: string,
  description: string,
  body: z.ZodType,
  run: (convex: ConvexCaller, id: DocId, body: never) => Promise<unknown>,
  status = 200,
): AnyEndpoint {
  return defineEndpoint({
    method: "POST",
    path: `/${res.path}/{id}/${path}`,
    operationId,
    summary,
    description,
    tag: res.tag,
    scope: "documents:write",
    params: docParams(res),
    body,
    response: { status, schema: documentOut, description: summary },
    errors: [...DOCUMENT_ERRORS],
    fieldMapper: documentFieldMapper,
    handler: async ({ convex, params: p, body: b }) => {
      const id = rawDocId(res, p.id);
      await loadDocument(convex, id, res.types, res.singular);
      const target = (await run(convex, id, b as never)) as DocId | undefined;
      return { status, body: await loadDocument(convex, target ?? id, res.types, res.singular) };
    },
  });
}

const quotes = DOCUMENT_RESOURCES.find((r) => r.path === "quotes") as DocumentResourceDef;
const deliveryNotes = DOCUMENT_RESOURCES.find((r) => r.path === "delivery-notes") as DocumentResourceDef;

const quoteEndpoints: AnyEndpoint[] = [
  flow(
    quotes,
    "mark-accepted",
    "markQuoteAccepted",
    "Angebot als angenommen markieren",
    "QUO-05: Datum, Name, Kanal (email | phone | manual); speichert den Hash des angenommenen Stands. " +
      "Abgelaufene Angebote nur mit `late: true`.",
    acceptWire,
    async (convex, id, b: z.output<typeof acceptWire>) => {
      await convex.mutation(api.documentFlows.accept, {
        id,
        values: {
          date: b.date,
          byName: b.accepted_by,
          channel: b.channel,
          ...(b.note ? { note: b.note } : {}),
          ...(b.late ? { late: true } : {}),
        },
      });
      return undefined;
    },
  ),
  flow(
    quotes,
    "mark-rejected",
    "markQuoteRejected",
    "Angebot als abgelehnt markieren",
    "QUO-05: Datum und optional ein Grund.",
    rejectWire,
    async (convex, id, b: z.output<typeof rejectWire>) => {
      await convex.mutation(api.documentFlows.reject, {
        id,
        values: { date: b.date, ...(b.reason ? { reason: b.reason } : {}) },
      });
      return undefined;
    },
  ),
  flow(
    quotes,
    "reopen",
    "reopenQuote",
    "Abgelehntes Angebot wieder öffnen",
    "Mit Grund; das Angebot ist wieder offen.",
    reasonWire,
    async (convex, id, b: z.output<typeof reasonWire>) => {
      await convex.mutation(api.documentFlows.reopen, { id, values: { reason: b.reason } });
      return undefined;
    },
  ),
  flow(
    quotes,
    "revise",
    "reviseQuote",
    "Neue Angebotsversion anlegen",
    "QUO-06: neuer Entwurf mit dem Inhalt dieses Angebots; beim Fertigstellen erhält er die Nummer mit Suffix " +
      "(z. B. AN-2026-0001-V2) und dieses Angebot wird „Ersetzt“.",
    reviseWire,
    async (convex, id, b: z.output<typeof reviseWire>) =>
      (await convex.mutation(api.documentFlows.revise, { id, values: b.reason ? { reason: b.reason } : {} })).id,
    201,
  ),
];

const deliveryNoteEndpoints: AnyEndpoint[] = [
  flow(
    deliveryNotes,
    "mark-received",
    "markDeliveryNoteReceived",
    "Lieferschein als erhalten markieren",
    "QUO-09: Empfangsdatum und Name des Empfängers.",
    receivedWire,
    async (convex, id, b: z.output<typeof receivedWire>) => {
      await convex.mutation(api.documentFlows.markReceived, {
        id,
        values: { date: b.date, byName: b.received_by },
      });
      return undefined;
    },
  ),
];

const resourceFor = (path: DocumentResourceDef["path"]) =>
  DOCUMENT_RESOURCES.find((r) => r.path === path) as DocumentResourceDef;

export const documentsResource = defineResource(
  "documents",
  "Verkaufsbelege: Angebote, Auftragsbestätigungen, Lieferscheine, Rechnungen und Proforma",
  [
    ...sharedEndpoints(resourceFor("quotes")),
    ...quoteEndpoints,
    ...sharedEndpoints(resourceFor("order-confirmations")),
    ...sharedEndpoints(resourceFor("delivery-notes")),
    ...deliveryNoteEndpoints,
    ...sharedEndpoints(resourceFor("invoices")),
  ],
);
