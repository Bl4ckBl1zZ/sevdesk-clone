import { v } from "convex/values";
import {
  costCenterSchema,
  customFieldDefSchema,
  paymentMethodSchema,
  tagSchema,
  textTemplateSchema,
  unitSchema,
} from "../src/domain/schemas/lookups";
import { mutation, query } from "./functions";
import { parse } from "./lib/parse";
import {
  archiveCostCenter as archiveCostCenterModel,
  archiveCustomFieldDef,
  createCustomFieldDef,
  createUnit as createUnitModel,
  deleteTag as deleteTagModel,
  deleteUnit as deleteUnitModel,
  listCostCenters as listCostCentersModel,
  listCustomFieldDefs,
  listPaymentMethods as listPaymentMethodsModel,
  listTags as listTagsModel,
  listUnits as listUnitsModel,
  saveCostCenter as saveCostCenterModel,
  savePaymentMethod as savePaymentMethodModel,
  saveTag as saveTagModel,
  setUnitArchived,
  updateCustomFieldDef,
  updateUnitLabels,
} from "./model/lookups";
import {
  deleteTextTemplate as deleteTextTemplateModel,
  listTextTemplates as listTextTemplatesModel,
  saveTextTemplate as saveTextTemplateModel,
  seedTextTemplates,
} from "./model/textTemplates";

/**
 * Settings lookups (F01 §3.8–3.9): text templates, units, payment methods, tags, custom fields and cost centres.
 * Reads need `settings.read`, writes `settings.write` (02 §4.3); every write is audited in the model layer.
 */

// ── text templates (SET-080…087) ──────────────────────────────────────────────────────────────────────
export const listTextTemplates = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) =>
    (await listTextTemplatesModel(ctx))
      .map((t) => ({
        templateId: t._id,
        kind: t.kind,
        docTypes: t.docTypes,
        language: t.language,
        name: t.name,
        subject: t.subject ?? "",
        body: t.body,
        isDefault: t.isDefault,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "de")),
});

export const saveTextTemplate = mutation({
  permission: "settings.write",
  args: { values: v.any(), templateId: v.optional(v.id("textTemplates")) },
  handler: async (ctx, { values, templateId }) =>
    saveTextTemplateModel(ctx, parse(textTemplateSchema, values), templateId),
});

export const deleteTextTemplate = mutation({
  permission: "settings.write",
  args: { templateId: v.id("textTemplates") },
  handler: async (ctx, { templateId }) => deleteTextTemplateModel(ctx, templateId),
});

/** SET-086: „Standardvorlagen wiederherstellen“ — inserts missing seeded templates, never overwrites. */
export const restoreDefaultTextTemplates = mutation({
  permission: "settings.write",
  args: {},
  handler: async (ctx) => seedTextTemplates(ctx),
});

// ── units (SET-090/091) ───────────────────────────────────────────────────────────────────────────────
export const listUnits = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) =>
    (await listUnitsModel(ctx))
      .map((u) => ({
        unitId: u._id,
        code: u.code,
        labelDe: u.label.de,
        labelEn: u.label.en,
        isSystem: u.isSystem,
        archivedAt: u.archivedAt ?? null,
      }))
      .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.code.localeCompare(b.code)),
});

export const createUnit = mutation({
  permission: "settings.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) => createUnitModel(ctx, parse(unitSchema, values)),
});

export const updateUnit = mutation({
  permission: "settings.write",
  args: { unitId: v.id("units"), values: v.any() },
  handler: async (ctx, { unitId, values }) => updateUnitLabels(ctx, unitId, parse(unitSchema, values)),
});

export const archiveUnit = mutation({
  permission: "settings.write",
  args: { unitId: v.id("units"), archived: v.boolean() },
  handler: async (ctx, { unitId, archived }) => setUnitArchived(ctx, unitId, archived),
});

export const deleteUnit = mutation({
  permission: "settings.write",
  args: { unitId: v.id("units") },
  handler: async (ctx, { unitId }) => deleteUnitModel(ctx, unitId),
});

// ── payment methods (SET-092/093) ─────────────────────────────────────────────────────────────────────
export const listPaymentMethods = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) =>
    (await listPaymentMethodsModel(ctx)).map((m) => ({
      paymentMethodId: m._id,
      name: m.name,
      text: m.text,
      kind: m.kind,
      isDefault: m.isDefault,
      active: m.active,
    })),
});

export const savePaymentMethod = mutation({
  permission: "settings.write",
  args: { values: v.any(), paymentMethodId: v.optional(v.id("paymentMethods")) },
  handler: async (ctx, { values, paymentMethodId }) =>
    savePaymentMethodModel(ctx, parse(paymentMethodSchema, values), paymentMethodId),
});

// ── tags (SET-094) ────────────────────────────────────────────────────────────────────────────────────
export const listTags = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) =>
    (await listTagsModel(ctx))
      .map((t) => ({ tagId: t._id, name: t.name, color: t.color ?? null, usage: 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, "de")),
});

export const saveTag = mutation({
  permission: "settings.write",
  args: { values: v.any(), tagId: v.optional(v.id("tags")) },
  handler: async (ctx, { values, tagId }) => saveTagModel(ctx, parse(tagSchema, values), tagId),
});

export const deleteTag = mutation({
  permission: "settings.write",
  args: { tagId: v.id("tags") },
  handler: async (ctx, { tagId }) => deleteTagModel(ctx, tagId),
});

// ── custom fields (SET-095/096) ───────────────────────────────────────────────────────────────────────
export const listCustomFields = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) =>
    (await listCustomFieldDefs(ctx))
      .filter((d) => d.archivedAt === undefined)
      .sort((a, b) => a.entity.localeCompare(b.entity) || a.position - b.position)
      .map((d) => ({
        customFieldId: d._id,
        entity: d.entity,
        key: d.key,
        label: d.label,
        type: d.type,
        options: d.options ?? [],
        printOnDocuments: d.printOnDocuments,
        required: d.required ?? false,
        values: 0,
      })),
});

export const createCustomField = mutation({
  permission: "settings.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) => createCustomFieldDef(ctx, parse(customFieldDefSchema, values)),
});

export const updateCustomField = mutation({
  permission: "settings.write",
  args: { customFieldId: v.id("customFieldDefs"), values: v.any() },
  handler: async (ctx, { customFieldId, values }) =>
    updateCustomFieldDef(ctx, customFieldId, parse(customFieldDefSchema, values)),
});

export const archiveCustomField = mutation({
  permission: "settings.write",
  args: { customFieldId: v.id("customFieldDefs") },
  handler: async (ctx, { customFieldId }) => archiveCustomFieldDef(ctx, customFieldId),
});

// ── cost centres (SET-097) ────────────────────────────────────────────────────────────────────────────
export const listCostCenters = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) =>
    (await listCostCentersModel(ctx))
      .map((c) => ({
        costCenterId: c._id,
        number: c.number,
        name: c.name,
        isDefault: c.isDefault,
        archivedAt: c.archivedAt ?? null,
      }))
      .sort((a, b) => a.number.localeCompare(b.number, "de", { numeric: true })),
});

export const saveCostCenter = mutation({
  permission: "settings.write",
  args: { values: v.any(), costCenterId: v.optional(v.id("costCenters")) },
  handler: async (ctx, { values, costCenterId }) =>
    saveCostCenterModel(ctx, parse(costCenterSchema, values), costCenterId),
});

export const archiveCostCenter = mutation({
  permission: "settings.write",
  args: { costCenterId: v.id("costCenters") },
  handler: async (ctx, { costCenterId }) => archiveCostCenterModel(ctx, costCenterId),
});
