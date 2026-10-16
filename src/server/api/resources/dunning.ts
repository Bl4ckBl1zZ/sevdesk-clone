import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { decodeId, encodeId } from "@/domain/api/ids";
import { isoDate, listEnvelope, prefixedId } from "@/domain/schemas/api/common";
import {
  caseActionValues,
  caseActionWire,
  dunningPreviewOut,
  dunningRunOut,
  dunningRunWire,
  exportOut,
  interestOut,
  interestQueryWire,
  interestValues,
  markSentOut,
  markSentWire,
  type PolicyLike,
  policyOut,
  policyPatchWire,
  policyValues,
  policyWire,
  type ReminderViewLike,
  reminderCreateValues,
  reminderCreateWire,
  reminderExportWire,
  reminderFinalizeWire,
  reminderOut,
  reminderWithdrawWire,
  retractWire,
  serializeDunningPreview,
  serializeInterest,
  serializePolicy,
  serializeReminder,
  serializeRunResult,
  zugangWire,
} from "@/domain/schemas/api/dunning";
import type { Scope } from "@/domain/schemas/scopes";
import type { KeyInfo } from "../auth";
import type { ConvexCaller } from "../backend";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";
import { idParams, rawId, requireVersion } from "./shared";

/**
 * F05 §7.1 Mahnwesen (05 §4.4): reminders (`rem_…`), the dunning run, case actions, the manual Zugang, policies and
 * the § 288 calculator. Handlers only map wire ⇄ Convex (convex/dunning.ts); every rule lives in
 * src/domain/dunning and convex/model/dunning.ts. **Nothing is sent**: a finalised reminder is exported and marked
 * sent like every document (F04 SND-16/17). The `confirm_token` of `GET /dunning/preview` is the plan digest — the
 * run fails with `preview_outdated` if the evaluation changed since (DUN-031).
 */

const TAG = "Mahnwesen";

const notFound = () => new ApiProblem("not_found", { detail: "Mahnung nicht gefunden." });

function requireScope(key: KeyInfo, scope: Scope) {
  if (!key.scopes.includes(scope)) throw new ApiProblem("insufficient_scope", { extra: { required_scope: scope } });
}

export async function loadReminder(convex: ConvexCaller, id: string) {
  const r = await convex.query(api.dunning.reminder, { id: id as never });
  if (!r) throw notFound();
  return serializeReminder(r.reminder as ReminderViewLike);
}

/** `inv_…` list → raw ids (422 on a malformed entry). */
export function rawInvoiceIds(ids: readonly string[] | undefined, field = "invoice_ids"): string[] | undefined {
  if (!ids) return undefined;
  return ids.map((id, i) => {
    const raw = decodeId("invoices", id);
    if (!raw) {
      throw new ApiProblem("validation_failed", {
        errors: [{ code: "invalid", field: `${field}[${i}]`, message: "Erwartet eine Rechnungs-ID (inv_…)." }],
      });
    }
    return raw;
  });
}

export async function previewWire(convex: ConvexCaller, opts: { date?: string; invoiceIds?: string[] }) {
  const p = await convex.query(api.dunning.preview, {
    ...(opts.date ? { date: opts.date } : {}),
    ...(opts.invoiceIds ? { invoiceIds: opts.invoiceIds } : {}),
  });
  return { digest: p.digest, wire: serializeDunningPreview(p, p.today) };
}

const reminderParams = idParams("reminders");
const invoiceParams = idParams("invoices");

const listQ = z.object({
  status: z.enum(["draft", "finalized", "sent", "cancelled"]).optional(),
  invoice_id: prefixedId("invoices").optional(),
  contact_id: prefixedId("contacts").optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const caseOut = z
  .object({
    invoice_id: z.string(),
    status: z.string().nullable().meta({ description: "active, paused, closed, handed_over …; null ohne Mahnfall" }),
    level: z.number().int(),
    paused_until: isoDate.nullable(),
    disputed: z.boolean(),
    blocked: z.boolean(),
    zugang: isoDate.nullable(),
  })
  .meta({ id: "DunningCase" });

async function caseWire(convex: ConvexCaller, invoiceId: string, wireId: string) {
  const f = await convex.query(api.dunning.forInvoice, { invoiceId: invoiceId as never });
  if (!f) throw new ApiProblem("not_found");
  return {
    invoice_id: wireId,
    status: f.case?.status ?? null,
    level: f.case?.currentLevel ?? 0,
    paused_until: f.case?.pausedUntil ?? null,
    disputed: f.disputed !== null,
    blocked: f.blocked !== null,
    zugang: f.zugang?.date ?? null,
  };
}

async function policiesWire(convex: ConvexCaller) {
  const s = await convex.query(api.dunning.settings, {});
  return s.policies.map((p) => serializePolicy(p as unknown as PolicyLike));
}

async function policyWireById(convex: ConvexCaller, id: string) {
  const p = (await policiesWire(convex)).find((x) => x.id === encodeId("dunningPolicies", id));
  if (!p) throw new ApiProblem("not_found", { detail: "Mahnrichtlinie nicht gefunden." });
  return p;
}

const REMINDER_ERRORS = [
  "not_found",
  "validation_failed",
  "conflict",
  "illegal_transition",
  "immutable_record",
  "version_conflict",
  "setup_incomplete",
] as const;

export const dunningResource = defineResource("dunning", "Mahnwesen: Mahnungen, Mahnlauf, Mahnfälle, Richtlinien", [
  defineEndpoint({
    method: "GET",
    path: "/reminders",
    operationId: "listReminders",
    summary: "Mahnungen auflisten",
    description: "Neueste zuerst; Filter status, invoice_id, contact_id.",
    tag: TAG,
    scope: "documents:read",
    query: listQ,
    response: { status: 200, schema: listEnvelope(reminderOut, "ReminderList"), description: "Mahnungen" },
    handler: async ({ convex, query }) => {
      const rows = await convex.query(api.dunning.list, {
        ...(query.status ? { status: query.status } : {}),
        ...(query.invoice_id ? { invoiceId: rawId("invoices", query.invoice_id) as never } : {}),
        ...(query.contact_id ? { contactId: rawId("contacts", query.contact_id) as never } : {}),
        limit: query.limit,
      });
      return { body: { data: rows.map((r) => serializeReminder(r as ReminderViewLike)), next_cursor: null } };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/reminders/{id}",
    operationId: "getReminder",
    summary: "Mahnung abrufen",
    tag: TAG,
    scope: "documents:read",
    params: reminderParams,
    response: { status: 200, schema: reminderOut, description: "Die Mahnung" },
    errors: ["not_found"],
    handler: async ({ convex, params }) => ({ body: await loadReminder(convex, rawId("reminders", params.id)) }),
  }),
  defineEndpoint({
    method: "POST",
    path: "/invoices/{id}/reminders",
    operationId: "createReminder",
    summary: "Mahnung erstellen (Entwurf)",
    description:
      "DUN-008: Entwurf der nächsten (oder angegebenen) Mahnstufe, vorbelegt aus der Mahnrichtlinie; Beträge überschreibbar. `finalize: true` stellt sofort fertig (braucht zusätzlich invoices:finalize). Versendet wird nichts.",
    tag: TAG,
    scope: "dunning:write",
    params: invoiceParams,
    body: reminderCreateWire,
    response: { status: 201, schema: reminderOut, description: "Der Mahnungsentwurf bzw. die fertiggestellte Mahnung" },
    errors: [...REMINDER_ERRORS, "insufficient_scope"],
    handler: async ({ convex, params, body, key }) => {
      const { finalize, ...rest } = body;
      if (finalize) requireScope(key, "invoices:finalize");
      const r = await convex.mutation(api.dunning.createReminder, {
        invoiceId: rawId("invoices", params.id) as never,
        values: reminderCreateValues(rest),
      });
      if (finalize) {
        await convex.mutation(api.dunning.finalize, {
          id: r.id,
          ...(rest.acknowledge_warnings ? { acknowledgeWarnings: rest.acknowledge_warnings } : {}),
        });
      }
      const wireId = encodeId("reminders", r.id);
      return {
        status: 201,
        body: await loadReminder(convex, r.id),
        headers: { Location: `/api/v1/reminders/${wireId}` },
      };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/reminders/{id}/finalize",
    operationId: "finalizeReminder",
    summary: "Mahnung fertigstellen",
    description:
      "DUN-004: vergibt die Nummer (MA-…), erzeugt das PDF/A und den Hash; prüft die Beträge erneut (EC-DUN-*). Warnungen (z. B. `not_in_default`) mit `acknowledge_warnings` bestätigen. Danach exportieren und als versendet markieren.",
    tag: TAG,
    scope: "invoices:finalize",
    params: reminderParams,
    body: reminderFinalizeWire,
    idempotency: "required",
    response: { status: 200, schema: reminderOut, description: "Die fertiggestellte Mahnung" },
    errors: [...REMINDER_ERRORS, "idempotency_key_required"],
    handler: async ({ convex, params, body, ifMatch }) => {
      const id = rawId("reminders", params.id);
      const version = ifMatch !== null && /^\d+$/.test(ifMatch) ? Number(ifMatch) : body.version;
      await convex.mutation(api.dunning.finalize, {
        id: id as never,
        ...(version !== undefined ? { version } : {}),
        ...(body.acknowledge_warnings ? { acknowledgeWarnings: body.acknowledge_warnings } : {}),
      });
      return { body: await loadReminder(convex, id) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/reminders/{id}/withdraw",
    operationId: "withdrawReminder",
    summary: "Mahnung gegenstandslos",
    description:
      "DUN-009: ein Entwurf wird gelöscht (204), eine fertiggestellte Mahnung bleibt mit Status „gegenstandslos“ archiviert. Ein Hinweisschreiben (`void_notice`) ist noch nicht verfügbar.",
    tag: TAG,
    scope: "dunning:write",
    params: reminderParams,
    body: reminderWithdrawWire,
    response: { status: 200, schema: reminderOut, description: "Die Mahnung (204 bei einem gelöschten Entwurf)" },
    errors: [...REMINDER_ERRORS],
    handler: async ({ convex, params, body }) => {
      const id = rawId("reminders", params.id);
      await convex.mutation(api.dunning.withdraw, { id: id as never, values: { reason: body.reason } });
      const r = await convex.query(api.dunning.reminder, { id: id as never });
      if (!r) return { status: 204 };
      return { body: serializeReminder(r.reminder as ReminderViewLike) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/reminders/{id}/export",
    operationId: "exportReminder",
    summary: "Mahnung exportieren",
    description:
      "F04 SND-16: kurzlebige Links (nur im Tailnet) zu den archivierten Dateien; das Original solange nicht markiert, danach „Kopie“ (Original erneut nur mit reason). Ändert keinen Status.",
    tag: TAG,
    scope: "documents:read",
    params: reminderParams,
    body: reminderExportWire,
    response: { status: 200, schema: exportOut, description: "Die Dateien" },
    errors: ["not_found", "artifacts_not_ready", "immutable_record", "conflict"],
    handler: async ({ convex, params, body }) => {
      const id = rawId("reminders", params.id);
      await loadReminder(convex, id);
      const r = await convex.action(api.documentArtifacts.exportFiles, {
        id: id as never,
        request: {
          entry: "default",
          ...(body.original ? { original: true } : {}),
          ...(body.reason ? { reason: body.reason } : {}),
        },
      });
      return {
        body: {
          files: r.files.map((f) => ({
            artifact_id: encodeId("documentArtifacts", f.artifactId),
            name: f.name,
            url: f.url,
            sha256: f.sha256,
            mime: f.mime,
          })),
        },
      };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/reminders/{id}/mark-sent",
    operationId: "markReminderSent",
    summary: "Mahnung als versendet markieren",
    description:
      "F04 SND-07/17: nachdem der Inhaber die Mahnung selbst versendet hat. Der Zugang (PAY-052) folgt aus Versanddatum und Kanal (Post: +3 Tage). Keine Route versendet etwas.",
    tag: TAG,
    scope: "invoices:send",
    params: reminderParams,
    body: markSentWire,
    response: { status: 200, schema: markSentOut, description: "Der Versandeintrag" },
    errors: ["not_found", "validation_failed", "conflict", "illegal_transition"],
    handler: async ({ convex, params, body }) => {
      const id = rawId("reminders", params.id);
      await loadReminder(convex, id);
      const artifactIds = body.artifacts.map((a, i) => {
        const raw = decodeId("documentArtifacts", a);
        if (!raw) {
          throw new ApiProblem("validation_failed", {
            errors: [{ code: "invalid", field: `artifacts[${i}]`, message: "Erwartet eine Datei-ID (art_…)." }],
          });
        }
        return raw;
      });
      const r = await convex.mutation(api.invoices.markSent, {
        id: id as never,
        values: {
          sentOn: body.sent_on,
          channel: body.channel,
          ...(body.note ? { note: body.note } : {}),
          artifactIds,
        },
      });
      return {
        body: {
          send_log_id: encodeId("sendLog", r.sendLogId),
          first_effective: r.firstEffective,
          warnings: r.warnings,
        },
      };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/reminders/{id}/mark-sent/{sendLogId}/retract",
    operationId: "retractReminderMark",
    summary: "Versandmarkierung zurücknehmen",
    description:
      "F04 SND-18 mit Grund. Gesperrt, sobald die Mahnung Grundlage einer Folgestufe, der Verzugspauschale oder des Verzugsbeginns ist (EC-DUN-24).",
    tag: TAG,
    scope: "invoices:send",
    params: z.object({ id: prefixedId("reminders"), sendLogId: prefixedId("sendLog") }),
    body: retractWire,
    response: { status: 200, schema: reminderOut, description: "Die Mahnung" },
    errors: ["not_found", "validation_failed", "conflict"],
    handler: async ({ convex, params, body }) => {
      const id = rawId("reminders", params.id);
      await convex.mutation(api.invoices.retractMark, {
        id: id as never,
        values: { retractsId: rawId("sendLog", params.sendLogId), reason: body.reason },
      });
      return { body: await loadReminder(convex, id) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/reminders/{id}/zugang",
    operationId: "overrideReminderZugang",
    summary: "Zugang der Mahnung manuell setzen",
    description: "PAY-052 (EC-DUE-09): z. B. laut Rückschein; mit Begründung, auditiert.",
    tag: TAG,
    scope: "dunning:write",
    params: reminderParams,
    body: zugangWire,
    response: { status: 200, schema: reminderOut, description: "Die Mahnung" },
    errors: ["not_found", "validation_failed", "conflict"],
    handler: async ({ convex, params, body }) => {
      const id = rawId("reminders", params.id);
      await loadReminder(convex, id);
      await convex.mutation(api.dunning.overrideZugang, { id: id as never, values: body });
      return { body: await loadReminder(convex, id) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/invoices/{id}/zugang",
    operationId: "overrideInvoiceZugang",
    summary: "Zugang der Rechnung manuell setzen",
    description:
      "PAY-052 (EC-DUE-09): z. B. laut Rückschein; mit Begründung, auditiert. Beeinflusst den Verzugsbeginn.",
    tag: TAG,
    scope: "dunning:write",
    params: invoiceParams,
    body: zugangWire,
    response: { status: 200, schema: caseOut, description: "Mahnstatus der Rechnung" },
    errors: ["not_found", "validation_failed", "conflict"],
    handler: async ({ convex, params, body }) => {
      const id = rawId("invoices", params.id);
      await convex.mutation(api.dunning.overrideZugang, { id: id as never, values: body });
      return { body: await caseWire(convex, id, params.id) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/invoices/{id}/dunning",
    operationId: "dunningCaseAction",
    summary: "Mahnfall pausieren, fortsetzen, bestreiten, sperren, übergeben",
    description:
      "DUN-002/034/042/043: `pause` (until), `resume`, `dispute` (reason, stoppt das Mahnen), `block`/`unblock`, `hand_over` (partner; Inkasso/Anwalt, beendet das Mahnen).",
    tag: TAG,
    scope: "dunning:write",
    params: invoiceParams,
    body: caseActionWire,
    response: { status: 200, schema: caseOut, description: "Mahnstatus der Rechnung" },
    errors: ["not_found", "validation_failed", "conflict", "illegal_transition"],
    handler: async ({ convex, params, body }) => {
      const id = rawId("invoices", params.id);
      await convex.mutation(api.dunning.caseAction, { invoiceId: id as never, values: caseActionValues(body) });
      return { body: await caseWire(convex, id, params.id) };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/dunning/preview",
    operationId: "previewDunningRun",
    summary: "Mahnlauf-Vorschau",
    description:
      "DUN-031: was der Lauf heute täte (Entwurf, Fertigstellen, Erinnerung, Überspringen mit Grund). `confirm_token` bindet genau diesen Plan für POST /dunning/run; für ein anderes Datum als heute (`date`) ist er null.",
    tag: TAG,
    scope: "payments:read",
    query: z.object({
      date: isoDate.optional(),
      invoice_ids: z.string().max(10_000).optional().meta({ description: "Kommagetrennt (inv_…)" }),
    }),
    response: { status: 200, schema: dunningPreviewOut, description: "Die Vorschau" },
    errors: ["validation_failed"],
    handler: async ({ convex, query }) => {
      const ids = query.invoice_ids
        ? rawInvoiceIds(
            query.invoice_ids
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        : undefined;
      const p = await previewWire(convex, {
        ...(query.date ? { date: query.date } : {}),
        ...(ids ? { invoiceIds: ids } : {}),
      });
      return { body: p.wire };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/dunning/run",
    operationId: "runDunning",
    summary: "Mahnlauf ausführen",
    description:
      "DUN-030/031: legt Entwürfe an (`mode: drafts`) oder stellt laut Richtlinie fertig (`mode: finalize`, braucht zusätzlich invoices:finalize). `confirm_token` aus GET /dunning/preview mit denselben `invoice_ids`; hat sich der Plan seither geändert → 409 `preview_outdated`. `dry_run: true` liefert die Vorschau. Versendet wird nie etwas.",
    tag: TAG,
    scope: "dunning:write",
    body: dunningRunWire,
    response: {
      status: 201,
      schema: z.union([dunningRunOut, dunningPreviewOut]),
      description: "Ergebnis (201) oder Vorschau (200)",
    },
    errors: ["validation_failed", "preview_outdated", "insufficient_scope"],
    handler: async ({ convex, body }) => {
      const invoiceIds = rawInvoiceIds(body.invoice_ids);
      if (body.dry_run)
        return { status: 200, body: (await previewWire(convex, invoiceIds ? { invoiceIds } : {})).wire };
      if (!body.confirm_token) {
        throw new ApiProblem("validation_failed", {
          errors: [
            {
              code: "required",
              field: "confirm_token",
              message: "Bitte zuerst GET /dunning/preview aufrufen und dessen confirm_token übergeben.",
            },
          ],
        });
      }
      const r = await convex.mutation(api.dunning.run, {
        mode: body.mode,
        ...(invoiceIds ? { invoiceIds: invoiceIds as never } : {}),
        expectedDigest: body.confirm_token,
      });
      return { status: 201, body: serializeRunResult(r) };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/dunning/interest",
    operationId: "calculateInterest",
    summary: "Verzugszinsen berechnen",
    description:
      "DUN-022/MAHN-02: § 288 BGB mit den Basiszinssätzen je Halbjahr (Segmente), Tage inklusive, einmal kaufmännisch gerundet.",
    tag: TAG,
    scope: "payments:read",
    query: interestQueryWire,
    response: { status: 200, schema: interestOut, description: "Die Berechnung" },
    errors: ["validation_failed"],
    handler: async ({ convex, query }) => ({
      body: serializeInterest(await convex.query(api.dunning.interest, { values: interestValues(query) })),
    }),
  }),
  defineEndpoint({
    method: "GET",
    path: "/dunning-policies",
    operationId: "listDunningPolicies",
    summary: "Mahnrichtlinien",
    description:
      "DUN-001: Stufen, Fristen, Gebühren, Zinsen, Automatik. Solange keine gespeichert ist, erscheinen die Standardrichtlinien mit `id: null, seeded: true`; das erste POST speichert sie mit.",
    tag: TAG,
    scope: "payments:read",
    response: { status: 200, schema: listEnvelope(policyOut, "DunningPolicyList"), description: "Richtlinien" },
    handler: async ({ convex }) => ({ body: { data: await policiesWire(convex), next_cursor: null } }),
  }),
  defineEndpoint({
    method: "POST",
    path: "/dunning-policies",
    operationId: "createDunningPolicy",
    summary: "Mahnrichtlinie anlegen",
    description: "Braucht dunning:manage (ändert, was der tägliche Lauf ohne weitere Bestätigung tut).",
    tag: TAG,
    scope: "dunning:manage",
    body: policyWire,
    response: { status: 201, schema: policyOut, description: "Die Richtlinie mit Warnungen" },
    errors: ["validation_failed"],
    handler: async ({ convex, body }) => {
      const r = await convex.mutation(api.dunning.createPolicy, { values: policyValues(body) });
      return {
        status: 201,
        body: await policyWireById(convex, r.id),
        headers: { Location: `/api/v1/dunning-policies/${encodeId("dunningPolicies", r.id)}` },
      };
    },
  }),
  defineEndpoint({
    method: "PATCH",
    path: "/dunning-policies/{id}",
    operationId: "updateDunningPolicy",
    summary: "Mahnrichtlinie ändern",
    description: "Vollständiger Stand der Richtlinie; Version per If-Match oder `version`.",
    tag: TAG,
    scope: "dunning:manage",
    params: idParams("dunningPolicies"),
    body: policyPatchWire,
    response: { status: 200, schema: policyOut, description: "Die Richtlinie mit Warnungen" },
    errors: ["not_found", "validation_failed", "version_conflict"],
    handler: async ({ convex, params, body, ifMatch }) => {
      const id = rawId("dunningPolicies", params.id);
      const { version: v, ...rest } = body;
      const version = requireVersion(ifMatch, v);
      await convex.mutation(api.dunning.updatePolicy, { id: id as never, version, values: policyValues(rest) });
      return { body: await policyWireById(convex, id) };
    },
  }),
]);
