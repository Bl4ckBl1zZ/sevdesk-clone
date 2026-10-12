import type { TextTemplateValues } from "../../src/domain/schemas/lookups";
import { DEFAULT_TEXT_TEMPLATES } from "../../src/domain/templates/defaults";
import { defaultsToClear, prepareTextTemplate } from "../../src/domain/templates/validate";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedDelete, auditedInsert, auditedPatch } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Text templates (03 §1, F01 SET-080…087). Bodies are sanitised and placeholder-checked on every write path
 * (SET-081/082); at most one default per (kind, document type, language) — saving a default clears overlapping
 * defaults (SET-080). Seeds (SET-086) are inserted on setup completion and by „Standardvorlagen wiederherstellen“.
 */
export async function listTextTemplates(ctx: ReadCtx): Promise<Doc<"textTemplates">[]> {
  return ctx.db.query("textTemplates").collect();
}

async function customFieldKeys(ctx: ReadCtx) {
  const defs = await ctx.db.query("customFieldDefs").collect();
  const keys = (entity: Doc<"customFieldDefs">["entity"]) =>
    defs.filter((d) => d.entity === entity && d.archivedAt === undefined).map((d) => d.key);
  return { contact: keys("contact"), document: keys("document") };
}

async function clearOverlappingDefaults(
  ctx: ModelCtx,
  candidate: { id: string; kind: string; language: string; docTypes: readonly string[] },
) {
  const all = await listTextTemplates(ctx);
  const ids = defaultsToClear(
    all.map((t) => ({
      id: t._id as string,
      kind: t.kind,
      language: t.language,
      docTypes: t.docTypes,
      isDefault: t.isDefault,
    })),
    candidate,
  );
  for (const id of ids) {
    const t = all.find((x) => x._id === id);
    await auditedPatch(
      ctx,
      "textTemplates",
      id as Id<"textTemplates">,
      { isDefault: false },
      {
        action: "settings.text_template.update",
        label: t?.name ?? id,
      },
    );
  }
}

export async function saveTextTemplate(
  ctx: ModelCtx,
  values: TextTemplateValues,
  templateId?: Id<"textTemplates">,
): Promise<Id<"textTemplates">> {
  const prepared = prepareTextTemplate(values, await customFieldKeys(ctx));
  if (!prepared.ok) {
    throw appError("invalid_input", prepared.error.message, {
      reason: prepared.error.code,
      field: String(prepared.error.params?.field ?? "body"),
    });
  }
  const t = prepared.value;
  const row = {
    kind: t.kind,
    docTypes: [...values.docTypes],
    language: t.language,
    name: t.name,
    subject: t.subject,
    body: t.body,
    isDefault: t.isDefault,
  };
  if (templateId) {
    const existing = await ctx.db.get(templateId);
    if (!existing) throw appError("not_found");
    if (t.isDefault) await clearOverlappingDefaults(ctx, { id: templateId, ...row });
    await auditedPatch(ctx, "textTemplates", templateId, row, {
      action: "settings.text_template.update",
      label: t.name,
    });
    return templateId;
  }
  if (t.isDefault) await clearOverlappingDefaults(ctx, { id: "", ...row });
  const { subject, ...rest } = row;
  return auditedInsert(
    ctx,
    "textTemplates",
    { ...rest, ...(subject ? { subject } : {}) },
    {
      action: "settings.text_template.create",
      label: t.name,
    },
  );
}

export async function deleteTextTemplate(ctx: ModelCtx, templateId: Id<"textTemplates">): Promise<void> {
  const t = await ctx.db.get(templateId);
  if (!t) throw appError("not_found");
  // Templates are copied into drafts and frozen at finalisation (SET-084), so deleting one never changes a document.
  await auditedDelete(ctx, "textTemplates", templateId, { action: "settings.text_template.delete", label: t.name });
}

/**
 * SET-086: inserts the seeded default for every (kind, document type, language) that has no template yet.
 * Idempotent; returns the number of inserted templates.
 */
export async function seedTextTemplates(ctx: ModelCtx): Promise<number> {
  const all = await listTextTemplates(ctx);
  let inserted = 0;
  for (const seed of DEFAULT_TEXT_TEMPLATES) {
    const covered = all.some(
      (t) =>
        t.kind === seed.kind &&
        t.language === seed.language &&
        t.docTypes.some((d) => (seed.docTypes as readonly string[]).includes(d)),
    );
    if (covered) continue;
    const hasDefault = all.some(
      (t) =>
        t.isDefault &&
        t.kind === seed.kind &&
        t.language === seed.language &&
        t.docTypes.some((d) => (seed.docTypes as readonly string[]).includes(d)),
    );
    await auditedInsert(
      ctx,
      "textTemplates",
      {
        kind: seed.kind,
        docTypes: [...seed.docTypes],
        language: seed.language,
        name: seed.name,
        ...(seed.subject ? { subject: seed.subject } : {}),
        body: seed.body,
        isDefault: !hasDefault,
      },
      { action: "settings.text_template.create", label: seed.name },
    );
    inserted += 1;
  }
  return inserted;
}
