import "server-only";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { z } from "zod";
import { prefixedId } from "@/domain/schemas/api/common";
import {
  type InboxDetailRecord,
  type InboxRowRecord,
  inboxItemList,
  inboxItemOut,
  inboxListQuery,
  inboxRejectWire,
  inboxUploadOut,
  inboxUploadWire,
  serializeInboxItem,
  serializeInboxRow,
} from "@/domain/schemas/api/inbox";
import { CAPTURE_MESSAGES, MAX_UPLOAD_BYTES } from "@/domain/vouchers/capture";
import type { ConvexCaller } from "../backend";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";

/**
 * F06 §7.1 receipt inbox (05 §4.5 `/inbox-items`). Upload = one inbox item per file (INB-001); classification runs
 * asynchronously (status `new` → `processing` → `needs_review`). Thin wire ⇄ Convex mapping: sniffing, hashing,
 * duplicates and the pipeline live in convex/inbox.ts, convex/model/inbox.ts and src/domain. No URL fetching (SEC-06).
 */

type IId = Id<"inboxItems">;
const params = z.object({ id: prefixedId("inboxItems") });

export async function loadInboxItem(convex: ConvexCaller, raw: string): Promise<InboxDetailRecord> {
  try {
    const d = await convex.query(api.inbox.get, { id: raw as IId });
    if (!d) throw new ApiProblem("not_found", { detail: "Posteingangs-Eintrag nicht gefunden." });
    return d as unknown as InboxDetailRecord;
  } catch (e) {
    if (e instanceof ApiProblem) throw e;
    if (
      (e as { data?: { code?: string } }).data?.code === "not_found" ||
      /ArgumentValidationError|Validator/.test(String(e))
    ) {
      throw new ApiProblem("not_found", { detail: "Posteingangs-Eintrag nicht gefunden." });
    }
    throw e;
  }
}

export const inboxItemWire = async (convex: ConvexCaller, raw: string) =>
  serializeInboxItem(await loadInboxItem(convex, raw));

/** multipart `file` / `file[]` parts → Convex file storage → one `inbox.ingest` per file (≤ 20 MB each, INB-001). */
async function ingestMultipart(convex: ConvexCaller, form: FormData, note: string | undefined): Promise<string[]> {
  const files = [...form.entries()]
    .filter(([k, v]) => (k === "file" || k === "file[]" || k === "files" || k === "files[]") && typeof v !== "string")
    .map(([, v]) => v as File);
  if (files.length === 0 || files.length > 100) {
    throw new ApiProblem("validation_failed", {
      errors: [{ code: "invalid", field: "file", message: "Bitte 1 bis 100 Dateien im Feld „file“ senden." }],
    });
  }
  const tooLarge = files.find((f) => f.size > MAX_UPLOAD_BYTES);
  if (tooLarge) {
    throw new ApiProblem("validation_failed", {
      errors: [
        { code: "file_too_large", field: "file", message: `${tooLarge.name}: ${CAPTURE_MESSAGES.tooLarge(20)}` },
      ],
    });
  }
  const ids: string[] = [];
  for (const f of files) {
    const url = await convex.mutation(api.inbox.generateUploadUrl, {});
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": f.type || "application/octet-stream" },
      body: f,
    });
    if (!res.ok) throw new Error(`Upload in den Dateispeicher fehlgeschlagen (${res.status}).`);
    const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
    const r = await convex.action(api.inbox.ingest, {
      files: [{ storageId, name: f.name || "beleg" }],
      ...(note ? { note } : {}),
    });
    ids.push(r.id);
  }
  return ids;
}

export const inboxResource = defineResource("inbox-items", "Posteingang (Belege, E-Rechnungen)", [
  defineEndpoint({
    method: "POST",
    path: "/inbox-items",
    operationId: "createInboxItems",
    summary: "Beleg hochladen",
    description:
      "Lädt Belege in den Posteingang: JSON `{ files: [{ filename, content_base64 }], note? }` (≤ 10 MB Base64 je Datei) oder `multipart/form-data` mit `file`-Teilen (≤ 20 MB je Datei). Erlaubt sind PDF, JPG, PNG, HEIC, WebP, TIFF, XML (XRechnung/ZUGFeRD) und .eml — erkannt am Dateiinhalt. Jede Datei wird ein eigener Eintrag; die Erkennung (XML → ZUGFeRD → OCR → manuell) läuft danach im Hintergrund und erzeugt immer einen Belegentwurf. URLs werden nicht abgerufen.",
    tag: "Posteingang",
    scope: "vouchers:write",
    body: inboxUploadWire,
    multipart: true,
    response: { status: 201, schema: inboxUploadOut, description: "Die angelegten Einträge mit Status" },
    errors: ["validation_failed"],
    handler: async ({ convex, body, form }) => {
      let ids: string[];
      if (form) {
        ids = await ingestMultipart(convex, form, body.note);
      } else {
        if (!body.files?.length) {
          throw new ApiProblem("validation_failed", {
            errors: [{ code: "invalid", field: "files", message: "Bitte mindestens eine Datei senden." }],
          });
        }
        ids = [];
        for (const f of body.files) {
          const r = await convex.action(api.inbox.ingestBase64, {
            files: [{ filename: f.filename, contentBase64: f.content_base64 }],
            ...(body.note ? { note: body.note } : {}),
          });
          ids.push(r.id);
        }
      }
      const data = [];
      for (const id of ids) data.push(await inboxItemWire(convex, id));
      return { status: 201, body: { data } };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/inbox-items",
    operationId: "listInboxItems",
    summary: "Posteingang auflisten",
    description:
      "Neueste zuerst (höchstens 200). `status` wie die Filter der App: all, new, needs_review, einvoice, faulty, duplicate, rejected, older_than_10_days.",
    tag: "Posteingang",
    scope: "vouchers:read",
    query: inboxListQuery,
    response: { status: 200, schema: inboxItemList, description: "Die Einträge" },
    handler: async ({ convex, query }) => {
      const rows = await convex.query(api.inbox.list, {
        ...(query.status ? { filter: query.status } : {}),
        ...(query.source ? { source: query.source } : {}),
        ...(query.classification ? { classification: query.classification } : {}),
        limit: query.limit,
      });
      return {
        body: { data: rows.map((r) => serializeInboxRow(r as unknown as InboxRowRecord)), next_cursor: null },
      };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/inbox-items/{id}",
    operationId: "getInboxItem",
    summary: "Posteingangs-Eintrag abrufen",
    description:
      "Status, Hinweise, Dateien (mit SHA-256), E-Rechnungs-Prüfergebnis (BMF-Kategorie und Regeln) und der verknüpfte Belegentwurf (`voucher_id`).",
    tag: "Posteingang",
    scope: "vouchers:read",
    params,
    response: { status: 200, schema: inboxItemOut, description: "Der Eintrag" },
    errors: ["not_found"],
    handler: async ({ convex, params }) => ({ body: await inboxItemWire(convex, params.id.slice(4)) }),
  }),
  defineEndpoint({
    method: "POST",
    path: "/inbox-items/{id}/reject",
    operationId: "rejectInboxItem",
    summary: "Posteingangs-Eintrag ablehnen",
    description:
      "Mit Grund (INB-010). Ein Belegentwurf wird gelöscht, die Dateien bleiben archiviert; Aufbewahrung 90 Tage (no_business_document) bzw. 6 Jahre.",
    tag: "Posteingang",
    scope: "vouchers:write",
    params,
    body: inboxRejectWire,
    response: { status: 200, schema: inboxItemOut, description: "Der abgelehnte Eintrag" },
    errors: ["not_found", "validation_failed"],
    handler: async ({ convex, params, body }) => {
      const raw = params.id.slice(4);
      await loadInboxItem(convex, raw);
      await convex.mutation(api.inbox.reject, {
        id: raw as IId,
        reason: body.reason,
        ...(body.text ? { text: body.text } : {}),
      });
      return { body: await inboxItemWire(convex, raw) };
    },
  }),
]);
