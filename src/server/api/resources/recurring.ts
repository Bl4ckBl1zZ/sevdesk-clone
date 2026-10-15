import "server-only";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { z } from "zod";
import { decodeId, encodeId } from "@/domain/api/ids";
import { prefixedId } from "@/domain/schemas/api/common";
import type { WireIssue } from "@/domain/schemas/api/documents";
import {
  type OccurrenceRecord,
  occurrencesOut,
  type RecurringCreateWire,
  type RecurringPatchWire,
  recurringCreateWire,
  recurringList,
  recurringOut,
  recurringPatchWire,
  resumeWire,
  runNowOut,
  serializeOccurrence,
  serializeTemplate,
  type TemplateRecord,
  wireToTemplate,
} from "@/domain/schemas/api/recurring";
import type { DraftValues } from "@/domain/schemas/documents";
import type { RecurringTemplateValues } from "@/domain/schemas/recurring";
import type { ConvexCaller } from "../backend";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";
import { linesToDraft } from "./documents";
import { rawId, requireVersion, versionField } from "./shared";

/**
 * F04 §7.1 recurring invoice templates (05 §4.3 `/recurring-invoices`). Thin wire ⇄ Convex mapping; the schedule,
 * generation and automation rules live in src/domain/recurring and convex/model/recurring.ts. Templates never send
 * (REC-16); enabling `automation.finalize` needs `invoices:finalize` on the key and a one-time confirmation in the app.
 */

type TplId = Id<"recurringTemplates">;
const params = z.object({ id: prefixedId("recurringTemplates") });

function invalid(issues: readonly WireIssue[]): never {
  throw new ApiProblem("validation_failed", {
    errors: issues.map((i) => ({ code: "invalid", field: i.field, message: i.message })),
  });
}

export async function loadTemplate(convex: ConvexCaller, id: string) {
  const t = await convex.query(api.recurring.get, { id: id as TplId });
  if (!t) throw new ApiProblem("not_found", { detail: "Vorlage nicht gefunden." });
  return t;
}

export const templateWire = (t: Awaited<ReturnType<typeof loadTemplate>>) =>
  serializeTemplate(t as unknown as TemplateRecord);

/** Wire body → shared template values (create, or a patch merged onto the stored template). */
async function toValues(
  convex: ConvexCaller,
  body: Omit<RecurringPatchWire, "version">,
  base?: { values: RecurringTemplateValues },
): Promise<RecurringTemplateValues> {
  const issues: WireIssue[] = [];
  const contactId = body.contact_id ? decodeId("contacts", body.contact_id) : (base?.values.draft.contactId ?? null);
  if (body.contact_id && !contactId) invalid([{ field: "contact_id", message: "Unbekannte Kontakt-ID." }]);
  const defaults = await convex.query(
    api.invoices.draftDefaults,
    contactId ? { contactId: contactId as Id<"contacts"> } : {},
  );
  const priceMode = body.price_mode ?? base?.values.draft.priceMode ?? defaults.priceMode;
  const currency = body.currency ?? base?.values.draft.currency ?? defaults.currency;
  const referenceDate = body.schedule?.first_date ?? base?.values.schedule.firstDate ?? defaults.today;
  const lines: DraftValues["lines"] = body.lines
    ? await linesToDraft(
        convex,
        body.lines,
        { ...(contactId ? { contactId } : {}), referenceDate, priceMode, currency },
        issues,
      )
    : (base?.values.draft.lines ?? []);
  const { values, issues: more } = wireToTemplate(
    { ...body, lines },
    {
      currency: defaults.currency,
      language: defaults.language,
      priceMode: defaults.priceMode,
      paymentTerms: defaults.paymentTerms,
    },
    base?.values,
  );
  issues.push(...more);
  if (issues.length > 0) invalid(issues);
  return {
    ...values,
    draft: {
      ...values.draft,
      ...(defaults.paymentMethodId && !values.draft.paymentMethodId
        ? { paymentMethodId: defaults.paymentMethodId }
        : {}),
      ...(defaults.bankAccountId && !values.draft.bankAccountId ? { bankAccountId: defaults.bankAccountId } : {}),
    },
  };
}

export async function createTemplateWire(convex: ConvexCaller, body: RecurringCreateWire) {
  const values = await toValues(convex, body);
  const { id } = await convex.mutation(api.recurring.create, { values });
  return templateWire(await loadTemplate(convex, id));
}

export async function patchTemplateWire(
  convex: ConvexCaller,
  id: string,
  version: number | undefined,
  body: Omit<RecurringPatchWire, "version">,
) {
  const t = await loadTemplate(convex, id);
  const base = {
    name: t.name,
    ...(t.contractReference ? { contractReference: t.contractReference } : {}),
    draft: t.draft as RecurringTemplateValues["draft"],
    schedule: {
      interval: t.schedule.interval,
      firstDate: t.schedule.firstDate,
      ...(t.schedule.endDate ? { endDate: t.schedule.endDate } : {}),
      ...(t.schedule.maxCount !== undefined ? { maxCount: t.schedule.maxCount } : {}),
      billing: t.schedule.billing,
      periodTextEnabled: t.schedule.periodTextEnabled,
    },
    automation: t.automation,
  } as unknown as RecurringTemplateValues;
  const values = await toValues(convex, body, { values: base });
  await convex.mutation(api.recurring.update, { id: id as TplId, version: version ?? t.version, values });
  return templateWire(await loadTemplate(convex, id));
}

export async function occurrencesWire(convex: ConvexCaller, id: string, count: number) {
  const rows = (await convex.query(api.recurring.occurrences, { id: id as TplId, count })) ?? [];
  return { data: (rows as OccurrenceRecord[]).map(serializeOccurrence) };
}

const STATES = ["active", "paused", "ended"] as const;

export const recurringResource = defineResource("recurring", "Wiederkehrende Rechnungen", [
  defineEndpoint({
    method: "GET",
    path: "/recurring-invoices",
    operationId: "listRecurringInvoices",
    summary: "Vorlagen wiederkehrender Rechnungen auflisten",
    description: "Aktive (Standard), pausierte oder beendete Vorlagen mit nächstem Termin, Betrag und Automatik.",
    tag: "Wiederkehrende Rechnungen",
    scope: "documents:read",
    query: z.object({ state: z.enum(STATES).optional().meta({ description: "active, paused oder ended" }) }),
    response: { status: 200, schema: recurringList, description: "Die Vorlagen" },
    handler: async ({ convex, query }) => {
      const r = await convex.query(api.recurring.list, { tab: query.state ?? "active" });
      return {
        body: { data: r.rows.map((t) => serializeTemplate(t as unknown as TemplateRecord)), next_cursor: null },
      };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/recurring-invoices",
    operationId: "createRecurringInvoice",
    summary: "Vorlage anlegen",
    description:
      "Rechnungsinhalt (Kunde, Positionen mit vat_rate_key, Texte, Zahlungsziel, Vertragsreferenz BT-12) + Zeitplan + Automatik. `automation.finalize: true` braucht zusätzlich invoices:finalize und wirkt erst nach einmaliger Bestätigung in der App; versendet wird nie (die Rechnung erscheint als Aufgabe „Exportieren und versenden“).",
    tag: "Wiederkehrende Rechnungen",
    scope: "documents:write",
    body: recurringCreateWire,
    response: { status: 201, schema: recurringOut, description: "Die Vorlage" },
    errors: ["not_found", "validation_failed"],
    handler: async ({ convex, body }) => {
      const t = await createTemplateWire(convex, body);
      return { status: 201, body: t, headers: { Location: `/api/v1/recurring-invoices/${t.id}` } };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/recurring-invoices/{id}",
    operationId: "getRecurringInvoice",
    summary: "Vorlage abrufen",
    description: "Vorlage mit Positionen, Zeitplan, Automatik und den erzeugten Rechnungen.",
    tag: "Wiederkehrende Rechnungen",
    scope: "documents:read",
    params,
    response: { status: 200, schema: recurringOut, description: "Die Vorlage" },
    errors: ["not_found"],
    handler: async ({ convex, params: p }) => ({
      body: templateWire(await loadTemplate(convex, rawId("recurringTemplates", p.id))),
    }),
  }),
  defineEndpoint({
    method: "PATCH",
    path: "/recurring-invoices/{id}",
    operationId: "updateRecurringInvoice",
    summary: "Vorlage ändern",
    description:
      "Änderungen wirken nur auf künftige Rechnungen (REC-11). Nach der ersten erzeugten Rechnung sind erste Rechnung, Intervall und Abrechnung fest. `If-Match` oder `version`.",
    tag: "Wiederkehrende Rechnungen",
    scope: "documents:write",
    params,
    body: recurringPatchWire.extend({ version: versionField }),
    response: { status: 200, schema: recurringOut, description: "Die Vorlage" },
    errors: ["not_found", "validation_failed", "version_conflict", "conflict"],
    handler: async ({ convex, params: p, body, ifMatch }) => {
      const { version, ...fields } = body;
      const v = requireVersion(ifMatch, version);
      return { body: await patchTemplateWire(convex, rawId("recurringTemplates", p.id), v, fields) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/recurring-invoices/{id}/run-now",
    operationId: "runRecurringInvoiceNow",
    summary: "Jetzt erzeugen",
    description:
      "Erzeugt den nächsten Termin sofort (gleiche Regeln) und rückt den Zeitplan vor (REC-12). Mit aktiver Automatik und invoices:finalize wird fertiggestellt, sonst bleibt ein Entwurf.",
    tag: "Wiederkehrende Rechnungen",
    scope: "documents:write",
    params,
    response: { status: 200, schema: runNowOut, description: "Erzeugte Rechnungen" },
    errors: ["not_found", "conflict"],
    handler: async ({ convex, params: p }) => {
      const r = await convex.action(api.recurring.runNow, { id: rawId("recurringTemplates", p.id) as TplId });
      return {
        body: { created: r.created, finalized: r.finalized, documents: r.ids.map((d) => encodeId("invoices", d)) },
      };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/recurring-invoices/{id}/pause",
    operationId: "pauseRecurringInvoice",
    summary: "Vorlage pausieren",
    tag: "Wiederkehrende Rechnungen",
    scope: "documents:write",
    params,
    response: { status: 200, schema: recurringOut, description: "Die Vorlage" },
    errors: ["not_found"],
    handler: async ({ convex, params: p }) => {
      const id = rawId("recurringTemplates", p.id);
      await convex.mutation(api.recurring.pause, { id: id as TplId });
      return { body: templateWire(await loadTemplate(convex, id)) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/recurring-invoices/{id}/resume",
    operationId: "resumeRecurringInvoice",
    summary: "Vorlage fortsetzen",
    description:
      "`catch_up: true` = verpasste Termine nachberechnen (mehr als catchUpAutoMax → Entwürfe ohne Automatik); `false` = überspringen (protokolliert), nächster Termin = erster künftiger.",
    tag: "Wiederkehrende Rechnungen",
    scope: "documents:write",
    params,
    body: resumeWire,
    response: { status: 200, schema: recurringOut, description: "Die Vorlage" },
    errors: ["not_found", "conflict"],
    handler: async ({ convex, params: p, body }) => {
      const id = rawId("recurringTemplates", p.id);
      await convex.mutation(api.recurring.resume, { id: id as TplId, catchUp: body.catch_up });
      return { body: templateWire(await loadTemplate(convex, id)) };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/recurring-invoices/{id}/occurrences",
    operationId: "listRecurringOccurrences",
    summary: "Nächste Termine",
    description:
      "Die nächsten Termine (Standard 12) mit Leistungszeitraum, erwartetem Betrag, Steuersätzen am Leistungsdatum, ER-03-Entscheidung und Hinweisen (REC-13).",
    tag: "Wiederkehrende Rechnungen",
    scope: "documents:read",
    params,
    query: z.object({ count: z.coerce.number().int().min(1).max(60).default(12) }),
    response: { status: 200, schema: occurrencesOut, description: "Die Termine" },
    errors: ["not_found"],
    handler: async ({ convex, params: p, query }) => ({
      body: await occurrencesWire(convex, rawId("recurringTemplates", p.id), query.count),
    }),
  }),
]);
