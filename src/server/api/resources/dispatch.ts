import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { DOCUMENT_ID_PREFIXES, encodeDocumentId, encodeId } from "@/domain/api/ids";
import type { SalesDocType } from "@/domain/documents/snapshot";
import { prefixedId } from "@/domain/schemas/api/common";
import {
  type DispatchIdType,
  decodeDispatchId,
  documentExportOut,
  documentExportWire,
  documentMarkSentOut,
  documentMarkSentWire,
  documentRetractWire,
  exportRequest,
  type FinalizeCheckLike,
  finalizeArgs,
  finalizePreviewOut,
  finalizePreviewWire,
  type MarkSentArgs,
  type MarkSentPreviewLike,
  markSentArgs,
  serializeFinalizeCheck,
  serializeMarkSentPreview,
} from "@/domain/schemas/api/dispatch";
import { documentFieldMapper, finalizeWire } from "@/domain/schemas/api/documents";
import type { Scope } from "@/domain/schemas/scopes";
import type { KeyInfo } from "../auth";
import type { ConvexCaller } from "../backend";
import { type AnyEndpoint, defineEndpoint } from "../endpoint";
import { ApiProblem } from "../http";
import { rawId } from "./shared";

/**
 * Finalise preview, finalisation, export and „Als versendet markieren“ for every sales document (F04 §7.1/§7.2,
 * SND-07/16/17/18/24). One implementation for REST (`/{type}/{id}/preview|export|mark-sent|…/retract`, corrections
 * also `finalize`) and the MCP tools `document_preview` / `document_finalize` / `document_export` /
 * `document_mark_sent`. Handlers only map wire ⇄ Convex (convex/invoices.ts, convex/documentArtifacts.ts); every
 * rule runs in the Convex model. **Nothing transmits a document** (EC-189).
 */

/** Stored types behind each id prefix (`inv_` = the invoice family incl. proforma and Storno). */
export const TYPES_BY_ID: Readonly<Record<DispatchIdType, readonly SalesDocType[]>> = {
  quote: ["quote"],
  order_confirmation: ["order_confirmation"],
  delivery_note: ["delivery_note"],
  invoice: ["invoice", "proforma", "advance_invoice", "partial_invoice", "final_invoice", "cancellation"],
  correction: ["correction"],
  reminder: ["reminder"],
};

const LABEL: Readonly<Record<DispatchIdType, string>> = {
  quote: "Angebot",
  order_confirmation: "Auftragsbestätigung",
  delivery_note: "Lieferschein",
  invoice: "Rechnung",
  correction: "Rechnungskorrektur",
  reminder: "Mahnung",
};

export interface ResolvedDoc {
  id: string;
  idType: DispatchIdType;
  wireId: string;
  type: SalesDocType;
  status: string;
  version: number;
  number: string | null;
}

/** Raw id + family → the document (404 when unknown or of another family). */
export async function loadHead(convex: ConvexCaller, id: string, idType: DispatchIdType): Promise<ResolvedDoc> {
  const h = await convex.query(api.documentsApi.head, { id });
  if (!h || !(TYPES_BY_ID[idType] as readonly string[]).includes(h.type)) {
    throw new ApiProblem("not_found", { detail: `${LABEL[idType]} nicht gefunden.` });
  }
  return {
    id,
    idType,
    wireId: encodeDocumentId(idType, id),
    type: h.type as SalesDocType,
    status: h.status,
    version: h.version,
    number: h.number,
  };
}

/** A prefixed id of any family (MCP); `allowed` restricts the families. */
export async function resolveDispatchDoc(
  convex: ConvexCaller,
  wireId: string,
  allowed: readonly DispatchIdType[] = Object.keys(TYPES_BY_ID) as DispatchIdType[],
): Promise<ResolvedDoc> {
  const d = decodeDispatchId(wireId);
  if (!d || !allowed.includes(d.idType)) {
    throw new ApiProblem("not_found", {
      detail: `Unbekannte Beleg-ID. Erwartet ${allowed.map((t) => `${DOCUMENT_ID_PREFIXES[t]}…`).join(", ")}.`,
    });
  }
  return loadHead(convex, d.id, d.idType);
}

const LETTERS: readonly string[] = ["quote", "order_confirmation", "delivery_note", "proforma"];

/**
 * Scopes for finalising beyond `invoices:finalize` (F04 §7.1): letters and proforma also `documents:write`,
 * corrections also `invoices:cancel`. Throws 403 with `required_scope`.
 */
export function requireFinalizeScopes(key: KeyInfo, type: string): void {
  const need: Scope[] = ["invoices:finalize"];
  if (LETTERS.includes(type)) need.push("documents:write");
  if (type === "correction") need.push("invoices:cancel");
  if (need.some((s) => !key.scopes.includes(s))) {
    throw new ApiProblem("insufficient_scope", { extra: { required_scope: need.join(" ") } });
  }
}

// ── shared handlers (REST + MCP) ──────────────────────────────────────────────────────────────────────────────────

/** Finalise preview of a draft (DOC-42): same validation as the pipeline; writes nothing. */
export async function finalizePreviewOf(
  convex: ConvexCaller,
  doc: ResolvedDoc,
  w: z.output<typeof finalizePreviewWire>,
) {
  if (doc.idType === "reminder") {
    throw new ApiProblem("validation_failed", {
      errors: [
        {
          code: "reminder_finalize",
          field: "id",
          message:
            "Mahnungen werden über den Mahnlauf (dunning_run, mode finalize) oder REST /reminders/{id}/finalize fertiggestellt.",
        },
      ],
    });
  }
  const { id: _id, version: _v, ...options } = finalizeArgs(doc.id, { version: doc.version, ...w });
  const c = (await convex.query(api.invoices.finalizeCheck, { id: doc.id as never, ...options })) as FinalizeCheckLike;
  if (c.check === null) {
    throw new ApiProblem("immutable_record", { detail: "Nur Entwürfe können fertiggestellt werden." });
  }
  return { wire: serializeFinalizeCheck(doc.wireId, c), version: c.version, options };
}

/** Export (SND-16): 5-minute tailnet links to the archived files; audited `document.export`. */
export async function exportDocument(convex: ConvexCaller, doc: ResolvedDoc, w: z.output<typeof documentExportWire>) {
  const r = await convex.action(api.documentArtifacts.exportFiles, { id: doc.id as never, request: exportRequest(w) });
  return {
    files: r.files.map((f) => ({
      artifact_id: encodeId("documentArtifacts", f.artifactId),
      name: f.name,
      url: f.url,
      sha256: f.sha256,
      mime: f.mime,
    })),
    zip_name: r.zipName,
  };
}

/** Wire → `invoices.markSent` arguments (422 on a malformed artifact id). */
export function markSentArgsOrThrow(doc: ResolvedDoc, w: z.output<typeof documentMarkSentWire>): MarkSentArgs {
  const { args, issues } = markSentArgs(doc.id, w);
  if (issues.length > 0) {
    throw new ApiProblem("validation_failed", {
      errors: issues.map((i) => ({ code: "mark_sent_artifact_unknown", field: i.field, message: i.message })),
    });
  }
  return args;
}

export async function markSentPreviewOf(convex: ConvexCaller, args: MarkSentArgs) {
  const p = (await convex.query(api.invoices.markSentPreview, args as never)) as MarkSentPreviewLike;
  return serializeMarkSentPreview(p);
}

export async function markSentDocument(convex: ConvexCaller, args: MarkSentArgs, confirmToken?: string) {
  const r = await convex.mutation(api.invoices.markSent, {
    ...(args as never as { id: never; values: unknown }),
    ...(confirmToken ? { confirmToken } : {}),
  });
  return {
    send_log_id: encodeId("sendLog", r.sendLogId),
    first_effective: r.firstEffective,
    warnings: r.warnings,
  };
}

// ── REST endpoints ────────────────────────────────────────────────────────────────────────────────────────────────

export interface DispatchResource {
  /** URL segment below /api/v1. */
  path: string;
  idType: DispatchIdType;
  tag: string;
  singular: string;
  schemaPrefix: string;
  /** `/{path}/{id}/finalize` is registered here (corrections); the letters/invoices have theirs already. */
  finalize?: boolean;
}

const markSentPreviewOut = z
  .object({
    number: z.string().nullable(),
    status_before: z.string(),
    status_after: z.string(),
    first_effective: z.boolean(),
    sent_on: z.string().nullable(),
    zugang: z.string().nullable(),
    einvoice_handed_over_electronically: z.boolean(),
    errors: z.array(z.object({ code: z.string(), message: z.string(), rule: z.string() })),
    warnings: z.array(z.object({ code: z.string(), message: z.string(), rule: z.string() })),
  })
  .meta({ id: "DocumentMarkSentPreview" });

const retractOut = z.object({ id: z.string(), status: z.string() }).meta({ id: "DocumentMarkSentRetractResult" });
const markSentResponse = z.union([documentMarkSentOut, markSentPreviewOut]).meta({ id: "DocumentMarkSentResponse" });
const finalizedOut = z
  .object({ id: z.string(), number: z.string(), status: z.string(), artifact_status: z.string() })
  .meta({ id: "DocumentFinalizeResult" });

export function dispatchEndpoints(res: DispatchResource): AnyEndpoint[] {
  const base = `/${res.path}`;
  const params = z.object({
    id: z
      .string()
      .regex(
        new RegExp(`^${DOCUMENT_ID_PREFIXES[res.idType]}[0-9a-zA-Z]{16,64}$`),
        `Erwartet eine ID mit Präfix ${DOCUMENT_ID_PREFIXES[res.idType]}.`,
      )
      .meta({ description: `${res.singular} (${DOCUMENT_ID_PREFIXES[res.idType]}…)` }),
  });
  const load = (convex: ConvexCaller, wireId: string) => resolveDispatchDoc(convex, wireId, [res.idType]);
  const out: AnyEndpoint[] = [];
  if (res.idType !== "reminder") {
    out.push(
      defineEndpoint({
        method: "POST",
        path: `${base}/{id}/preview`,
        operationId: `preview${res.schemaPrefix}`,
        summary: `${res.singular} prüfen (Fertigstellungs-Vorschau)`,
        description:
          "DOC-42: Prüfung eines Entwurfs mit den gewünschten Fertigstellungs-Optionen — Fehler/Warnungen mit Regel-ID, Summen, Steuerfall mit Begründung, ER-03-Entscheidung und Format. Schreibt nichts. `confirm_token` ist nur für MCP (REST: null).",
        tag: res.tag,
        scope: "documents:read",
        params,
        body: finalizePreviewWire,
        response: { status: 200, schema: finalizePreviewOut, description: "Das Prüfergebnis" },
        errors: ["not_found", "immutable_record", "validation_failed"],
        handler: async ({ convex, params: p, body }) => {
          const doc = await load(convex, p.id);
          const r = await finalizePreviewOf(convex, doc, body);
          return { body: { ...r.wire, confirm_token: null } };
        },
      }),
    );
  }
  if (res.finalize) {
    out.push(
      defineEndpoint({
        method: "POST",
        path: `${base}/{id}/finalize`,
        operationId: `finalize${res.schemaPrefix}`,
        summary: `${res.singular} fertigstellen`,
        description:
          "Vergibt die Nummer, friert den Inhalt ein und erzeugt PDF/E-Rechnung (F04 §4.6). Rechnungskorrekturen brauchen invoices:finalize und invoices:cancel. `Idempotency-Key` ist Pflicht.",
        tag: res.tag,
        scope: "invoices:finalize",
        params,
        body: finalizeWire,
        idempotency: "required",
        response: { status: 200, schema: finalizedOut, description: "Der fertiggestellte Beleg" },
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
        handler: async ({ convex, key, params: p, body }) => {
          const doc = await load(convex, p.id);
          requireFinalizeScopes(key, doc.type);
          const r = await convex.action(api.invoices.finalize, finalizeArgs(doc.id, body) as never);
          return { body: { id: doc.wireId, number: r.number, status: "finalized", artifact_status: "pending" } };
        },
      }),
    );
  }
  out.push(
    defineEndpoint({
      method: "POST",
      path: `${base}/{id}/export`,
      operationId: `export${res.schemaPrefix}`,
      summary: `${res.singular} exportieren`,
      description:
        "SND-16: kurzlebige Links (5 min, nur im Tailnet) zu den archivierten Dateien; das Original solange nicht als versendet markiert, danach die „Kopie“ (Original erneut nur mit `reason`). Ändert keinen Status; protokolliert `document.export`. Versendet nichts.",
      tag: res.tag,
      scope: "documents:read",
      params,
      body: documentExportWire,
      response: { status: 200, schema: documentExportOut, description: "Die Dateien" },
      errors: ["not_found", "artifacts_not_ready", "immutable_record", "conflict", "validation_failed"],
      handler: async ({ convex, params: p, body }) => ({
        body: await exportDocument(convex, await load(convex, p.id), body),
      }),
    }),
    defineEndpoint({
      method: "POST",
      path: `${base}/{id}/mark-sent`,
      operationId: `markSent${res.schemaPrefix}`,
      summary: `${res.singular} als versendet markieren`,
      description:
        "SND-07/17: nachdem der Inhaber die Dateien selbst übergeben hat (E-Mail, Post, persönlich, Upload-Portal, Sonstiges). ER-03 wird geprüft; der erste wirksame Eintrag setzt Status, Versanddatum und Zugang. `?dry_run=true` prüft nur. `Idempotency-Key` ist Pflicht. Keine Route versendet etwas.",
      tag: res.tag,
      scope: "invoices:send",
      params,
      query: z.object({ dry_run: z.enum(["true", "false"]).optional() }),
      body: documentMarkSentWire,
      idempotency: "required",
      response: {
        status: 200,
        schema: markSentResponse,
        description: "Der Versandeintrag (dry_run: das Prüfergebnis)",
      },
      errors: ["not_found", "validation_failed", "conflict", "illegal_transition", "idempotency_key_required"],
      handler: async ({ convex, params: p, query, body }) => {
        const doc = await load(convex, p.id);
        const args = markSentArgsOrThrow(doc, body);
        if (query.dry_run === "true") return { body: await markSentPreviewOf(convex, args) };
        return { body: await markSentDocument(convex, args) };
      },
    }),
    defineEndpoint({
      method: "POST",
      path: `${base}/{id}/mark-sent/{sendLogId}/retract`,
      operationId: `retractMark${res.schemaPrefix}`,
      summary: "Versandmarkierung zurücknehmen",
      description:
        "SND-18 mit Grund (≥ 10 Zeichen); hängt eine Rücknahme an, nichts wird geändert oder gelöscht. Gesperrt, solange eine Folgehandlung (z. B. Mahnung) auf der Markierung beruht. `Idempotency-Key` ist Pflicht. Nicht über MCP.",
      tag: res.tag,
      scope: "invoices:send",
      params: params.extend({ sendLogId: prefixedId("sendLog") }),
      body: documentRetractWire,
      idempotency: "required",
      response: { status: 200, schema: retractOut, description: "Status nach der Rücknahme" },
      errors: ["not_found", "validation_failed", "conflict", "idempotency_key_required"],
      handler: async ({ convex, params: p, body }) => {
        const doc = await load(convex, p.id);
        const r = await convex.mutation(api.invoices.retractMark, {
          id: doc.id as never,
          values: { retractsId: rawId("sendLog", p.sendLogId), reason: body.reason },
        });
        return { body: { id: doc.wireId, status: r.status } };
      },
    }),
  );
  return out;
}
