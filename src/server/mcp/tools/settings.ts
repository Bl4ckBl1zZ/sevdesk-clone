import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import type { AnyEndpoint } from "../../api/endpoint";
import { settingsResource } from "../../api/resources/settings";
import { defineTool, type ToolContext } from "../tool";

/**
 * Discovery and settings tools (06 §3.1). The settings reads reuse the REST endpoint handlers, so REST and MCP
 * return the same shapes from one implementation (CLAUDE.md rule 5).
 */
function endpoint(operationId: string): AnyEndpoint {
  const e = settingsResource.endpoints.find((x) => x.operationId === operationId);
  if (!e) throw new Error(`unknown endpoint ${operationId}`);
  return e;
}

async function viaRest(operationId: string, ctx: ToolContext, query: Record<string, unknown> = {}) {
  const out = await endpoint(operationId).handler({
    params: {},
    query,
    body: undefined,
    convex: ctx.convex,
    principal: ctx.principal,
    key: ctx.key,
    request: new Request("https://mcp.invalid/"),
    requestId: ctx.principal.requestId,
    ifMatch: null,
  });
  return out.body as Record<string, unknown>;
}

const READ_ANY = [
  "contacts:read",
  "products:read",
  "documents:read",
  "payments:read",
  "vouchers:read",
  "banking:read",
  "accounting:read",
  "reports:read",
  "settings:read",
  "audit:read",
  "projects:read",
] as const;

export const settingsTools = [
  defineTool({
    name: "workspace_overview",
    title: "Überblick",
    description:
      "Der beste erste Aufruf: Unternehmen, Rechtsform, Kleinunternehmer-Status, Soll/Ist, Anzahl Kontakte/Produkte und offene Punkte der Einrichtung.",
    kind: "read",
    scopes: READ_ANY,
    input: z.object({}),
    handler: async (_a, { convex }) => {
      const o = await convex.query(api.settingsApi.workspaceOverview, {});
      return {
        today: o.today,
        company: o.company
          ? {
              name: o.company.name,
              legal_form: o.company.legalForm,
              kleinunternehmer: o.company.kleinunternehmer,
              taxation_method: o.company.taxationMethod,
              setup_completed: o.company.setupCompleted,
            }
          : null,
        counts: { active_contacts: o.counts.activeContacts, active_products: o.counts.activeProducts },
        setup: o.setup,
        note: "Forderungen, Entwürfe und Steuertermine folgen mit den Belegen (F04/F05/F08).",
      };
    },
  }),
  defineTool({
    name: "settings_get_company",
    title: "Unternehmensprofil",
    description: "Unternehmensprofil ohne Geheimnisse (Name, Anschrift, Register, Steuernummern, Vorgaben).",
    kind: "read",
    scopes: ["settings:read"],
    input: z.object({}),
    handler: async (_a, ctx) => viaRest("getCompany", ctx),
  }),
  defineTool({
    name: "settings_list_number_ranges",
    title: "Nummernkreise",
    description: "Nummernkreise mit Format und nächster Nummer (nicht reserviert).",
    kind: "read",
    scopes: ["settings:read"],
    input: z.object({}),
    handler: async (_a, ctx) => viaRest("listNumberRanges", ctx),
  }),
  defineTool({
    name: "settings_list_text_templates",
    title: "Textvorlagen",
    description: "Kopf-, Fuß- und E-Mail-Textvorlagen.",
    kind: "read",
    scopes: ["settings:read"],
    input: z.object({}),
    handler: async (_a, ctx) => viaRest("listTextTemplates", ctx),
  }),
  defineTool({
    name: "settings_get_tax_rates",
    title: "Steuersätze",
    description: "Steuersatzschlüssel mit Satz und Kategorie an einem Datum (Standard heute). Nie Sätze raten.",
    kind: "read",
    scopes: ["settings:read"],
    input: z.object({ date: z.string().optional().meta({ description: "YYYY-MM-DD" }) }),
    handler: async ({ date }, ctx) => viaRest("listTaxRates", ctx, date ? { date } : {}),
  }),
  defineTool({
    name: "settings_list_layouts",
    title: "Layouts",
    description: "Dokument-Layouts mit Standardzuordnung.",
    kind: "read",
    scopes: ["settings:read"],
    input: z.object({}),
    handler: async (_a, ctx) => viaRest("listLayouts", ctx),
  }),
  defineTool({
    name: "settings_list_units",
    title: "Einheiten",
    description: "Einheiten (UN/ECE Rec. 20) für Produkte und Positionen.",
    kind: "read",
    scopes: ["settings:read"],
    input: z.object({}),
    handler: async (_a, ctx) => viaRest("listUnits", ctx),
  }),
  defineTool({
    name: "settings_list_payment_methods",
    title: "Zahlungsarten",
    description: "Zahlungsarten mit Hinweistext.",
    kind: "read",
    scopes: ["settings:read"],
    input: z.object({}),
    handler: async (_a, ctx) => viaRest("listPaymentMethods", ctx),
  }),
];
