import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { encodeId } from "@/domain/api/ids";
import { ADDRESS_TYPES } from "@/domain/contacts/address";
import { CONTACT_ROLES } from "@/domain/contacts/core";
import {
  addressToForm,
  addressWire,
  CONTACT_EXPANDS,
  type ContactWireRecord,
  channelToForm,
  channelWire,
  contactCreateToForm,
  contactCreateWire,
  contactFieldMapper,
  contactMergeArgs,
  contactMergeWire,
  contactPatchToForm,
  contactPatchWire,
  contactSearchRow,
  matchValues,
} from "@/domain/schemas/api/contacts";
import { ACTIVITY_KINDS } from "@/domain/schemas/contacts";
import { ApiProblem } from "../../api/http";
import { loadContact } from "../../api/resources/contacts";
import { rawId } from "../../api/resources/shared";
import { confirmTokenArg, defineTool } from "../tool";

const contactId = z.string().meta({ description: "Kontakt-ID (con_…)" });
const limit = z.number().int().min(1).max(100).optional().meta({ description: "Standard 20" });

async function visibleContact(convex: Parameters<typeof loadContact>[0], id: string) {
  const raw = rawId("contacts", id);
  if (!(await convex.query(api.contactsApi.get, { id: raw }))) throw new ApiProblem("not_found");
  return raw;
}

/** F02 §7.2 / 06 §3.2 contact tools (this slice). Restricted contacts are invisible to MCP. */
export const contactTools = [
  defineTool({
    name: "contact_search",
    title: "Kontakte suchen",
    description:
      "Sucht Kontakte (Name, Nummer, Ort, E-Mail) mit Filtern role/status oder exakt per email/vat_id/number. Liefert kompakte Zeilen (ID, Nummer, Name, Ort, E-Mail, USt-IdNr-Status). Nutze die ID für contact_get.",
    kind: "read",
    scopes: ["contacts:read"],
    input: z.object({
      query: z.string().max(200).optional(),
      role: z.enum(CONTACT_ROLES).optional(),
      status: z.enum(["lead", "active", "archived", "all"]).optional(),
      email: z.string().max(320).optional(),
      vat_id: z.string().max(20).optional(),
      number: z.string().max(40).optional(),
      limit,
      cursor: z.string().max(2000).optional(),
    }),
    handler: async (a, { convex }) => {
      const page = await convex.query(api.contactsApi.list, {
        paginationOpts: { numItems: a.limit ?? 20, cursor: a.cursor ?? null },
        ...(a.query ? { q: a.query } : {}),
        ...(a.role ? { role: a.role } : {}),
        ...(a.status ? { status: a.status } : {}),
        ...(a.email ? { email: a.email } : {}),
        ...(a.vat_id ? { vatId: a.vat_id } : {}),
        ...(a.number ? { number: a.number } : {}),
      });
      return {
        data: page.page.map((r) =>
          contactSearchRow(r.contact as unknown as ContactWireRecord, {
            city: r.addresses.find((x) => x.type === "billing" && x.isDefault)?.address.city ?? null,
            email: r.channels.find((x) => x.type === "email" && x.isPrimary)?.value ?? r.channels[0]?.value ?? null,
          }),
        ),
        next_cursor: page.isDone ? null : page.continueCursor,
      };
    },
  }),
  defineTool({
    name: "contact_get",
    title: "Kontakt abrufen",
    description: "Vollständiger Kontakt inkl. Anschriften, Kanälen, Personen und USt-IdNr-Status.",
    kind: "read",
    scopes: ["contacts:read"],
    input: z.object({ id: contactId }),
    handler: async ({ id }, { convex }) => loadContact(convex, rawId("contacts", id), new Set(CONTACT_EXPANDS)),
  }),
  defineTool({
    name: "contact_upsert",
    title: "Kontakt anlegen oder ändern",
    description:
      "Mit `id`: ändert die übergebenen Felder (version Pflicht). Ohne `id`: sucht per E-Mail, USt-IdNr und Nummer nach einem vorhandenen Kontakt und aktualisiert ihn (matched_existing: true), sonst legt er einen neuen an. Bei mehreren Treffern den Nutzer fragen. Erfinde niemals USt-IdNr oder Steuernummern.",
    kind: "write",
    scopes: ["contacts:write"],
    fieldMapper: contactFieldMapper,
    input: z.object({
      id: contactId.optional(),
      version: z.number().int().min(1).optional(),
      contact: z.record(z.string(), z.unknown()).meta({
        description:
          "Felder wie bei POST/PATCH /contacts (snake_case): kind, organization_name, first_name, last_name, vat_id, payment_terms, billing_address, channels …",
      }),
    }),
    handler: async ({ id, version, contact }, { convex }) => {
      if (id) {
        const fields = contactPatchWire.safeParse(contact);
        if (!fields.success) throw new ApiProblem("validation_failed", { detail: fields.error.issues[0]?.message });
        if (version === undefined) {
          throw new ApiProblem("validation_failed", {
            errors: [{ code: "version_required", field: "version", message: "Bitte version aus contact_get angeben." }],
          });
        }
        const raw = rawId("contacts", id);
        const r = await convex.mutation(api.contactsApi.patch, {
          id: raw,
          version,
          values: contactPatchToForm(fields.data),
        });
        return { contact: await loadContact(convex, raw), matched_existing: true, warnings: r.warnings };
      }
      const body = contactCreateWire.safeParse(contact);
      if (!body.success) throw new ApiProblem("validation_failed", { detail: body.error.issues[0]?.message });
      const { kind: _k, billing_address: _a, channels: _c, ...fields } = body.data;
      const r = await convex.mutation(api.contactsApi.upsert, {
        match: ["vat_id", "email", "number"],
        matchValues: matchValues(body.data),
        values: contactCreateToForm(body.data),
        patch: contactPatchToForm(fields),
      });
      return {
        contact: await loadContact(convex, r.id),
        matched_existing: !r.created,
        matched_by: r.matchedBy,
        warnings: r.warnings,
      };
    },
  }),
  defineTool({
    name: "contact_add_address",
    title: "Anschrift hinzufügen",
    description: "Fügt eine Rechnungs-, Liefer- oder sonstige Anschrift hinzu.",
    kind: "write",
    scopes: ["contacts:write"],
    input: z.object({
      id: contactId,
      type: z.enum(ADDRESS_TYPES),
      is_default: z.boolean().optional(),
      address: addressWire,
    }),
    handler: async ({ id, type, is_default, address }, { convex }) => {
      const raw = await visibleContact(convex, id);
      const addressId = await convex.mutation(api.contacts.saveAddress, {
        contactId: raw as never,
        values: { type, isDefault: is_default ?? false, ...addressToForm(address, "DE") },
      });
      return {
        address_id: encodeId("contactAddresses", addressId),
        contact: await loadContact(convex, raw, new Set(["addresses"])),
      };
    },
  }),
  defineTool({
    name: "contact_add_channel",
    title: "Kommunikationskanal hinzufügen",
    description: "Fügt E-Mail, Telefon, Mobil, Fax oder Web hinzu (is_invoice_email für den Rechnungsversand).",
    kind: "write",
    scopes: ["contacts:write"],
    input: z.object({ id: contactId, channel: channelWire }),
    handler: async ({ id, channel }, { convex }) => {
      const raw = await visibleContact(convex, id);
      const channelId = await convex.mutation(api.contacts.saveChannel, {
        contactId: raw as never,
        values: channelToForm(channel),
      });
      return {
        channel_id: encodeId("contactChannels", channelId),
        contact: await loadContact(convex, raw, new Set(["channels"])),
      };
    },
  }),
  defineTool({
    name: "contact_add_note",
    title: "Notiz, Anruf oder Aufgabe erfassen",
    description: "Neuer Eintrag im Verlauf des Kontakts. Aufgaben brauchen due_on (YYYY-MM-DD).",
    kind: "write",
    scopes: ["contacts:write"],
    input: z.object({
      id: contactId,
      kind: z.enum(ACTIVITY_KINDS),
      text: z.string().min(1).max(10_000),
      due_on: z.string().optional(),
    }),
    handler: async ({ id, kind, text, due_on }, { convex }) => {
      const raw = await visibleContact(convex, id);
      const activityId = await convex.mutation(api.contacts.addActivity, {
        contactId: raw as never,
        values: { kind, text, dueOn: due_on ?? "" },
      });
      return { activity_id: encodeId("contactActivities", String(activityId)) };
    },
  }),
  defineTool({
    name: "contact_check_vat_id",
    title: "USt-IdNr prüfen",
    description:
      "Prüft die USt-IdNr des Kontakts beim BZSt (eVatR, qualifiziert) bzw. bei VIES und speichert den Nachweis. Ein Ergebnis der letzten 24 h wird wiederverwendet, außer force.",
    kind: "write",
    scopes: ["contacts:write"],
    openWorld: true,
    input: z.object({ id: contactId, force: z.boolean().optional() }),
    handler: async ({ id, force }, { convex }) => {
      const raw = await visibleContact(convex, id);
      const r = await convex.action(api.vatIdChecks.check, { contactId: raw as never, ...(force ? { force } : {}) });
      return {
        check_id: encodeId("vatIdChecks", r.checkId),
        status: r.status,
        message: r.message,
        warning: r.warning,
        reused: r.reused,
      };
    },
  }),
  defineTool({
    name: "contact_find_duplicates",
    title: "Mögliche Dubletten",
    description:
      "Paare möglicher Dubletten mit Punktzahl und Gründen. Zusammenführen nur nach Rückfrage (contact_merge).",
    kind: "read",
    scopes: ["contacts:read"],
    input: z.object({}),
    handler: async (_a, { convex }) => ({
      data: (await convex.query(api.contacts.duplicates, {})).map((p) => ({
        score: p.score,
        reasons: p.reasons,
        a: { id: encodeId("contacts", p.a._id), number: p.a.number, name: p.a.displayName },
        b: { id: encodeId("contacts", p.b._id), number: p.b.number, name: p.b.displayName },
      })),
    }),
  }),
  defineTool({
    name: "contact_archive",
    title: "Kontakt archivieren",
    description: "Archiviert einen Kontakt (reversibel). Es gibt kein Löschen über MCP.",
    kind: "write",
    scopes: ["contacts:write"],
    idempotent: true,
    input: z.object({ id: contactId }),
    handler: async ({ id }, { convex }) => {
      const raw = rawId("contacts", id);
      await convex.mutation(api.contactsApi.archive, { id: raw });
      return loadContact(convex, raw);
    },
  }),
  defineTool({
    name: "contact_merge",
    title: "Kontakte zusammenführen ⚠",
    description:
      '⚠ Führt Dubletten in den bleibenden Kontakt zusammen (Anschriften, Kanäle, Verlauf, Kundenpreise, Entwürfe wandern; festgeschriebene Belege bleiben). Erst preview_action {action:"contact_merge", params} aufrufen, die Verschiebeliste zeigen, bestätigen lassen und dann mit confirm_token und denselben params aufrufen.',
    kind: "danger",
    confirmIntent: "contact_merge",
    scopes: ["contacts:write"],
    input: contactMergeWire.extend({ confirm_token: confirmTokenArg }),
    handler: async ({ confirm_token, ...params }, { convex }) => {
      const args = contactMergeArgs(params);
      if (!args) throw new ApiProblem("not_found");
      const moved = await convex.mutation(api.contacts.merge, { ...args, confirmToken: confirm_token });
      return {
        winner: await loadContact(convex, args.values.winnerId),
        merges: moved.map((m) => encodeId("contactMerges", m)),
      };
    },
  }),
];
