import "server-only";
import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { z } from "zod";
import { encodeId } from "@/domain/api/ids";
import {
  CONTACT_EXPANDS,
  type ContactWireExtras,
  type ContactWireRecord,
  contactCreateToForm,
  contactCreateWire,
  contactFieldMapper,
  contactList,
  contactListQuery,
  contactOut,
  contactPatchToForm,
  contactPatchWire,
  matchValues,
  parseMatch,
  serializeContact,
} from "@/domain/schemas/api/contacts";
import type { ConvexCaller } from "../backend";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";
import {
  expandOf,
  expandQueryParam,
  idParams,
  nextCursor,
  paginationOpts,
  rawId,
  requireVersion,
  updatedSince,
  versionField,
} from "./shared";

type ContactRow = NonNullable<FunctionReturnType<typeof api.contactsApi.get>>;

/** Convex row (contact + sub-records) → wire contact with the requested expansions. */
export function contactToWire(
  row: Omit<ContactRow, "persons"> & { persons?: ContactRow["persons"] },
  expand: Set<string>,
) {
  const extras: ContactWireExtras = {
    addresses: row.addresses as ContactWireExtras["addresses"],
    channels: row.channels as ContactWireExtras["channels"],
    ...(row.persons ? { persons: row.persons } : {}),
    stats: {},
  };
  return serializeContact(row.contact as unknown as ContactWireRecord, extras, expand);
}

export async function loadContact(convex: ConvexCaller, id: string, expand = new Set<string>()) {
  const row = await convex.query(api.contactsApi.get, { id });
  if (!row) {
    // F12 PRV-012: 410 with minimal data for a restricted contact (keys without `audit:read`)
    const restricted = await convex.query(api.contactsApi.restrictedInfo, { id });
    if (restricted) throw new ApiProblem("contact_restricted", { extra: { contact: restricted } });
    throw new ApiProblem("not_found", { detail: "Kontakt nicht gefunden." });
  }
  return contactToWire(row, expand);
}

const warnings = z.array(z.object({ code: z.string(), message: z.string() }));
const contactWithMeta = contactOut
  .extend({
    meta: z
      .object({ warnings, created: z.boolean().optional(), matched_by: z.string().nullable().optional() })
      .optional(),
  })
  .meta({ id: "ContactWithMeta" });

const listQ = contactListQuery.extend({ expand: expandQueryParam(CONTACT_EXPANDS) });
const getQ = z.object({ expand: expandQueryParam(CONTACT_EXPANDS) });
const createQ = z.object({
  match: z
    .string()
    .optional()
    .meta({ description: "Upsert: email, vat_id, number (kommagetrennt, in Reihenfolge)", example: "vat_id,email" }),
});
const patchBody = contactPatchWire.extend({ version: versionField }).strict().meta({ id: "ContactPatchRequest" });

const vatCheckOut = z
  .object({
    id: z.string().meta({ description: "vck_…" }),
    status: z.enum(["valid", "invalid", "unavailable"]),
    message: z.string(),
    warning: z.string().nullable(),
    reused: z.boolean(),
  })
  .meta({ id: "VatIdCheck" });

/** 05 §4.1 / F02 §7.1 contacts (this slice: list, get, create/upsert, update, archive, VAT-ID check). */
export const contactsResource = defineResource("contacts", "Kontakte (Kunden, Lieferanten, Personen)", [
  defineEndpoint({
    method: "GET",
    path: "/contacts",
    operationId: "listContacts",
    summary: "Kontakte auflisten",
    description:
      "Filter `q`, `role`, `status`, `vat_id`, `email`, `number`, `tag`, `updated_since`. Zusammengeführte Kontakte nur mit `include_merged=true`; eingeschränkte Kontakte (DSGVO) nie.",
    tag: "Kontakte",
    scope: "contacts:read",
    query: listQ,
    response: { status: 200, schema: contactList, description: "Eine Seite Kontakte" },
    errors: ["invalid_expand"],
    handler: async ({ convex, query }) => {
      const expand = expandOf(query.expand, CONTACT_EXPANDS);
      const since = updatedSince(query);
      const page = await convex.query(api.contactsApi.list, {
        paginationOpts: paginationOpts(query),
        ...(query.q ? { q: query.q } : {}),
        ...(query.role ? { role: query.role } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.vat_id ? { vatId: query.vat_id } : {}),
        ...(query.email ? { email: query.email } : {}),
        ...(query.number ? { number: query.number } : {}),
        ...(query.tag ? { tag: rawId("tags", query.tag) } : {}),
        ...(query.include_merged === "true" ? { includeMerged: true } : {}),
        ...(since !== undefined ? { updatedSince: since } : {}),
      });
      return { body: { data: page.page.map((r) => contactToWire(r, expand)), next_cursor: nextCursor(page) } };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/contacts",
    operationId: "createContact",
    summary: "Kontakt anlegen (oder per ?match= aktualisieren)",
    description:
      "Legt einen Kontakt an. Mit `?match=email|vat_id|number` (mehrere in Reihenfolge) wird ein eindeutig passender Kontakt mit den übergebenen Feldern aktualisiert (200) statt eine Dublette anzulegen; mehrere Treffer → 409 `upsert_ambiguous`. Bei einem Treffer werden Anschrift und Kanäle des Bodys nicht übernommen. `Idempotency-Key` wird unterstützt.",
    tag: "Kontakte",
    scope: "contacts:write",
    query: createQ,
    body: contactCreateWire,
    response: { status: 201, schema: contactWithMeta, description: "Angelegt (201) oder per match aktualisiert (200)" },
    errors: ["validation_failed", "upsert_ambiguous", "number_collision", "idempotency_key_reused"],
    fieldMapper: contactFieldMapper,
    handler: async ({ convex, query, body }) => {
      const match = parseMatch(query.match);
      if (match === null) {
        throw new ApiProblem("bad_request", {
          errors: [{ code: "invalid", field: "match", message: "Erlaubt: email, vat_id, number." }],
        });
      }
      const form = contactCreateToForm(body);
      if (match.length > 0) {
        const { kind: _kind, billing_address: _a, channels: _c, ...fields } = body;
        const r = await convex.mutation(api.contactsApi.upsert, {
          match,
          matchValues: matchValues(body),
          values: form,
          patch: contactPatchToForm(fields),
        });
        const contact = await loadContact(convex, r.id);
        return {
          status: r.created ? 201 : 200,
          body: { ...contact, meta: { warnings: r.warnings, created: r.created, matched_by: r.matchedBy } },
          headers: { Location: `/api/v1/contacts/${contact.id}` },
        };
      }
      const r = await convex.mutation(api.contacts.create, { values: form });
      const contact = await loadContact(convex, r.id);
      return {
        status: 201,
        body: { ...contact, meta: { warnings: r.warnings.map((message) => ({ code: "warning", message })) } },
        headers: { Location: `/api/v1/contacts/${contact.id}` },
      };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/contacts/{id}",
    operationId: "getContact",
    summary: "Kontakt abrufen",
    tag: "Kontakte",
    scope: "contacts:read",
    params: idParams("contacts"),
    query: getQ,
    response: { status: 200, schema: contactOut, description: "Der Kontakt" },
    errors: ["not_found", "invalid_expand", "contact_restricted"],
    handler: async ({ convex, params, query }) => ({
      body: await loadContact(convex, rawId("contacts", params.id), expandOf(query.expand, CONTACT_EXPANDS)),
    }),
  }),
  defineEndpoint({
    method: "PATCH",
    path: "/contacts/{id}",
    operationId: "updateContact",
    summary: "Kontakt ändern",
    description: "Nur die übergebenen Felder werden geändert; `version` (oder `If-Match`) ist Pflicht.",
    tag: "Kontakte",
    scope: "contacts:write",
    params: idParams("contacts"),
    body: patchBody,
    response: { status: 200, schema: contactWithMeta, description: "Der geänderte Kontakt" },
    errors: ["not_found", "validation_failed", "version_conflict", "contact_merged", "number_collision"],
    fieldMapper: contactFieldMapper,
    handler: async ({ convex, params, body, ifMatch }) => {
      const { version: bodyVersion, ...fields } = body;
      const version = requireVersion(ifMatch, bodyVersion);
      const id = rawId("contacts", params.id);
      const r = await convex.mutation(api.contactsApi.patch, { id, version, values: contactPatchToForm(fields) });
      return { body: { ...(await loadContact(convex, id)), meta: { warnings: r.warnings } } };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/contacts/{id}/archive",
    operationId: "archiveContact",
    summary: "Kontakt archivieren",
    description: "Reversibel; Belege bleiben unverändert.",
    tag: "Kontakte",
    scope: "contacts:write",
    params: idParams("contacts"),
    response: { status: 200, schema: contactOut, description: "Der archivierte Kontakt" },
    errors: ["not_found"],
    handler: async ({ convex, params }) => {
      const id = rawId("contacts", params.id);
      await convex.mutation(api.contactsApi.archive, { id });
      return { body: await loadContact(convex, id) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/contacts/{id}/vat-id-checks",
    operationId: "checkContactVatId",
    summary: "USt-IdNr prüfen",
    description:
      "Qualifizierte Prüfung (BZSt eVatR) für EU-IDs bzw. einfache Prüfung (VIES); speichert den Nachweis (MISC-04). Ein Ergebnis der letzten 24 h wird wiederverwendet, außer `force`.",
    tag: "Kontakte",
    scope: "contacts:write",
    params: idParams("contacts"),
    body: z.object({ force: z.boolean().optional() }).strict().meta({ id: "VatIdCheckRequest" }),
    response: { status: 201, schema: vatCheckOut, description: "Der gespeicherte Nachweis" },
    errors: ["not_found", "validation_failed", "dependency_unavailable"],
    handler: async ({ convex, params, body }) => {
      const id = rawId("contacts", params.id);
      if (!(await convex.query(api.contactsApi.get, { id }))) throw new ApiProblem("not_found");
      const r = await convex.action(api.vatIdChecks.check, {
        contactId: id as never,
        ...(body.force ? { force: true } : {}),
      });
      return {
        body: {
          id: encodeId("vatIdChecks", r.checkId),
          status: r.status,
          message: r.message,
          warning: r.warning,
          reused: r.reused,
        },
      };
    },
  }),
]);
