import { v } from "convex/values";
import { textTemplateSchema } from "../src/domain/schemas/lookups";
import { mutation, query } from "./functions";
import { parse } from "./lib/parse";
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
