import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { encodeId } from "@/domain/api/ids";
import { isoDate, snakeKeys } from "@/domain/schemas/api/common";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";

const anyObject = (id: string, description: string) => z.record(z.string(), z.unknown()).meta({ id, description });
const list = (id: string, item: z.ZodType) => z.object({ data: z.array(item), next_cursor: z.null() }).meta({ id });

const numberRangeOut = z
  .object({
    id: z.string(),
    name: z.string(),
    doc_types: z.array(z.string()),
    format: z.string(),
    reset_policy: z.string(),
    active: z.boolean(),
    is_default: z.boolean(),
    next: z.string(),
    in_use: z.boolean(),
  })
  .meta({ id: "NumberRange" });
const textTemplateOut = z
  .object({
    id: z.string(),
    kind: z.string(),
    doc_types: z.array(z.string()),
    language: z.string(),
    name: z.string(),
    subject: z.string(),
    body: z.string(),
    is_default: z.boolean(),
  })
  .meta({ id: "TextTemplate" });
const layoutOut = z
  .object({
    id: z.string(),
    name: z.string(),
    is_default_for: z.array(z.string()),
    version: z.number().int(),
    template: z.string(),
    accent_color: z.string(),
  })
  .meta({ id: "Layout" });
const unitOut = z
  .object({
    code: z.string(),
    label_de: z.string(),
    label_en: z.string(),
    is_system: z.boolean(),
    archived: z.boolean(),
  })
  .meta({ id: "Unit" });
const paymentMethodOut = z
  .object({
    id: z.string(),
    name: z.string(),
    text: z.string(),
    kind: z.string(),
    is_default: z.boolean(),
    active: z.boolean(),
  })
  .meta({ id: "PaymentMethod" });
const taxRateOut = z
  .object({
    key: z.string(),
    label: z.string(),
    rate_bp: z.number().int(),
    category: z.string(),
    rule_row_id: z.string(),
    date: isoDate,
  })
  .meta({ id: "TaxRate" });

/** 05 §4.8 / F01 §7.1 settings reads (writes stay in the UI in this slice). */
export const settingsResource = defineResource("settings", "Einstellungen (lesend)", [
  defineEndpoint({
    method: "GET",
    path: "/settings/company",
    operationId: "getCompany",
    summary: "Unternehmensprofil",
    description: "Vollständiges Profil ohne Geheimnisse und ohne die Owner-Einstellungen der Einrichtung.",
    tag: "Einstellungen",
    scope: "settings:read",
    response: { status: 200, schema: anyObject("Company", "Unternehmensprofil (snake_case)"), description: "Profil" },
    errors: ["setup_incomplete"],
    handler: async ({ convex }) => {
      const p = await convex.query(api.settingsApi.company, {});
      if (!p) throw new ApiProblem("setup_incomplete");
      return { body: { object: "company", ...(snakeKeys(p) as Record<string, unknown>) } };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/settings/company/public",
    operationId: "getCompanyPublic",
    summary: "Öffentliche Unternehmensdaten",
    description: "Für Website-Impressum/Footer (SET-021): Scope `company:public` oder `settings:read`.",
    tag: "Einstellungen",
    scope: ["company:public", "settings:read"],
    response: {
      status: 200,
      schema: anyObject("CompanyPublic", "Name, Anschrift, Kontakt, USt-IdNr, Register, Vertretung"),
      description: "Öffentliche Angaben",
    },
    errors: ["setup_incomplete"],
    handler: async ({ convex }) => {
      const p = await convex.query(api.settingsApi.companyPublic, {});
      if (!p) throw new ApiProblem("setup_incomplete");
      return { body: { object: "company_public", ...(snakeKeys(p) as Record<string, unknown>) } };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/settings/number-ranges",
    operationId: "listNumberRanges",
    summary: "Nummernkreise",
    tag: "Einstellungen",
    scope: "settings:read",
    response: { status: 200, schema: list("NumberRangeList", numberRangeOut), description: "Nummernkreise" },
    handler: async ({ convex }) => ({
      body: {
        data: (await convex.query(api.settings.listNumberRanges, {})).map((r) => ({
          id: encodeId("numberRanges", r.rangeId),
          name: r.name,
          doc_types: r.docTypes,
          format: r.format,
          reset_policy: r.resetPolicy,
          active: r.active,
          is_default: r.isDefault,
          next: r.next,
          in_use: r.inUse,
        })),
        next_cursor: null,
      },
    }),
  }),
  defineEndpoint({
    method: "GET",
    path: "/settings/text-templates",
    operationId: "listTextTemplates",
    summary: "Textvorlagen",
    tag: "Einstellungen",
    scope: "settings:read",
    response: { status: 200, schema: list("TextTemplateList", textTemplateOut), description: "Textvorlagen" },
    handler: async ({ convex }) => ({
      body: {
        data: (await convex.query(api.lookups.listTextTemplates, {})).map((t) => ({
          id: encodeId("textTemplates", t.templateId),
          kind: t.kind,
          doc_types: t.docTypes,
          language: t.language,
          name: t.name,
          subject: t.subject,
          body: t.body,
          is_default: t.isDefault,
        })),
        next_cursor: null,
      },
    }),
  }),
  defineEndpoint({
    method: "GET",
    path: "/settings/layouts",
    operationId: "listLayouts",
    summary: "Layouts",
    tag: "Einstellungen",
    scope: "settings:read",
    response: { status: 200, schema: list("LayoutList", layoutOut), description: "Layouts" },
    handler: async ({ convex }) => ({
      body: {
        data: (await convex.query(api.settings.listLayoutsWithDefaults, {})).map((l) => ({
          id: encodeId("layouts", l.layoutId),
          name: l.name,
          is_default_for: l.isDefaultFor,
          version: l.version,
          template: l.template,
          accent_color: l.accentColor,
        })),
        next_cursor: null,
      },
    }),
  }),
  defineEndpoint({
    method: "GET",
    path: "/settings/units",
    operationId: "listUnits",
    summary: "Einheiten",
    tag: "Einstellungen",
    scope: "settings:read",
    response: { status: 200, schema: list("UnitList", unitOut), description: "Einheiten (UN/ECE Rec. 20)" },
    handler: async ({ convex }) => ({
      body: {
        data: (await convex.query(api.lookups.listUnits, {})).map((u) => ({
          code: u.code,
          label_de: u.labelDe,
          label_en: u.labelEn,
          is_system: u.isSystem,
          archived: u.archivedAt !== null,
        })),
        next_cursor: null,
      },
    }),
  }),
  defineEndpoint({
    method: "GET",
    path: "/settings/payment-methods",
    operationId: "listPaymentMethods",
    summary: "Zahlungsarten",
    tag: "Einstellungen",
    scope: "settings:read",
    response: { status: 200, schema: list("PaymentMethodList", paymentMethodOut), description: "Zahlungsarten" },
    handler: async ({ convex }) => ({
      body: {
        data: (await convex.query(api.lookups.listPaymentMethods, {})).map((m) => ({
          id: encodeId("paymentMethods", m.paymentMethodId),
          name: m.name,
          text: m.text,
          kind: m.kind,
          is_default: m.isDefault,
          active: m.active,
        })),
        next_cursor: null,
      },
    }),
  }),
  defineEndpoint({
    method: "GET",
    path: "/settings/tax-rates",
    operationId: "listTaxRates",
    summary: "Steuersätze am Stichtag",
    description: "Steuersatzschlüssel mit Kategorie und Satz zum Datum (Standard: heute, Europe/Berlin).",
    tag: "Einstellungen",
    scope: "settings:read",
    query: z.object({ date: isoDate.optional() }),
    response: { status: 200, schema: list("TaxRateList", taxRateOut), description: "Steuersätze" },
    errors: ["validation_failed"],
    handler: async ({ convex, query }) => ({
      body: {
        data: (await convex.query(api.settingsApi.taxRates, query.date ? { date: query.date } : {})).map((r) => ({
          key: r.key,
          label: r.label,
          rate_bp: r.rateBp,
          category: r.category,
          rule_row_id: r.ruleRowId,
          date: r.date,
        })),
        next_cursor: null,
      },
    }),
  }),
]);
