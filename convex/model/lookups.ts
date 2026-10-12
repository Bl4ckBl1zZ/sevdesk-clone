import { validateCostCenter } from "../../src/domain/lookups/cost-centers";
import { checkCustomFieldChange, validateCustomFieldDef } from "../../src/domain/lookups/custom-fields";
import {
  checkActivatePaymentMethod,
  SEED_PAYMENT_METHODS,
  validatePaymentMethods,
} from "../../src/domain/lookups/payment-methods";
import { validateTag } from "../../src/domain/lookups/tags";
import { checkDeleteUnit, SEED_UNITS, validateUnit } from "../../src/domain/lookups/units";
import type { Issue } from "../../src/domain/result";
import type {
  CostCenterValues,
  CustomFieldDefValues,
  PaymentMethodFormValues,
  TagValues,
  UnitValues,
} from "../../src/domain/schemas/lookups";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedDelete, auditedInsert, auditedPatch } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Settings lookups (03 §1, F01 SET-090…097): units, payment methods, tags, custom field definitions and cost
 * centres. Domain rules in src/domain/lookups; every write is audited (`settings.<lookup>.<verb>`).
 *
 * Usage counts: products, contacts, documents and vouchers arrive in P1/P2. Until then nothing can reference a unit,
 * tag or custom field, so the counts are 0; the features that add the references extend `unitUsageCount` and
 * `customFieldValueCount` (and tag removal on delete) in the same PR.
 */
const invalid = (e: Issue) => appError("invalid_input", e.message, { reason: e.code, ...e.params });

// ── units ─────────────────────────────────────────────────────────────────────────────────────────────
export async function listUnits(ctx: ReadCtx): Promise<Doc<"units">[]> {
  return ctx.db.query("units").collect();
}

export async function unitUsageCount(_ctx: ReadCtx, _code: string): Promise<number> {
  return 0;
}

export async function seedUnits(ctx: ModelCtx): Promise<number> {
  const existing = new Set((await listUnits(ctx)).map((u) => u.code));
  let n = 0;
  for (const seed of SEED_UNITS) {
    if (existing.has(seed.code)) continue;
    await auditedInsert(
      ctx,
      "units",
      { code: seed.code, label: { ...seed.label }, isSystem: true },
      {
        action: "settings.unit.create",
        label: seed.code,
      },
    );
    n += 1;
  }
  return n;
}

export async function createUnit(ctx: ModelCtx, values: UnitValues): Promise<Id<"units">> {
  const unit = { code: values.code, label: { de: values.labelDe, en: values.labelEn } };
  const r = validateUnit(
    unit,
    (await listUnits(ctx)).map((u) => u.code),
  );
  if (!r.ok) throw invalid(r.error);
  return auditedInsert(
    ctx,
    "units",
    { ...unit, isSystem: false },
    { action: "settings.unit.create", label: unit.code },
  );
}

/** Labels are editable for system and custom units; the code is fixed. */
export async function updateUnitLabels(ctx: ModelCtx, unitId: Id<"units">, values: UnitValues): Promise<void> {
  const unit = await ctx.db.get(unitId);
  if (!unit) throw appError("not_found");
  const r = validateUnit({ code: unit.code, label: { de: values.labelDe, en: values.labelEn } }, []);
  if (!r.ok) throw invalid(r.error);
  await auditedPatch(
    ctx,
    "units",
    unitId,
    { label: { de: values.labelDe, en: values.labelEn } },
    {
      action: "settings.unit.update",
      label: unit.code,
    },
  );
}

export async function setUnitArchived(ctx: ModelCtx, unitId: Id<"units">, archived: boolean): Promise<void> {
  const unit = await ctx.db.get(unitId);
  if (!unit) throw appError("not_found");
  await auditedPatch(
    ctx,
    "units",
    unitId,
    { archivedAt: archived ? ctx.now() : undefined },
    {
      action: archived ? "settings.unit.archive" : "settings.unit.restore",
      label: unit.code,
    },
  );
}

export async function deleteUnit(ctx: ModelCtx, unitId: Id<"units">): Promise<void> {
  const unit = await ctx.db.get(unitId);
  if (!unit) throw appError("not_found");
  const e = checkDeleteUnit(unit, await unitUsageCount(ctx, unit.code));
  if (e) throw invalid(e);
  await auditedDelete(ctx, "units", unitId, { action: "settings.unit.delete", label: unit.code });
}

// ── payment methods ───────────────────────────────────────────────────────────────────────────────────
export async function listPaymentMethods(ctx: ReadCtx): Promise<Doc<"paymentMethods">[]> {
  return ctx.db.query("paymentMethods").collect();
}

export async function seedPaymentMethods(ctx: ModelCtx): Promise<number> {
  const existing = await listPaymentMethods(ctx);
  if (existing.length > 0) return 0;
  for (const m of SEED_PAYMENT_METHODS) {
    await auditedInsert(ctx, "paymentMethods", { ...m }, { action: "settings.payment_method.create", label: m.name });
  }
  return SEED_PAYMENT_METHODS.length;
}

/** Creates or updates one method; the whole list is re-validated (unique names, exactly one default, AO-04 text). */
export async function savePaymentMethod(
  ctx: ModelCtx,
  values: PaymentMethodFormValues,
  methodId?: Id<"paymentMethods">,
): Promise<Id<"paymentMethods">> {
  const all = await listPaymentMethods(ctx);
  if (methodId && !all.some((m) => m._id === methodId)) throw appError("not_found");
  if (values.active) {
    const e = checkActivatePaymentMethod(values.kind, (await getCompanyProfile(ctx))?.creditorId);
    if (e) throw invalid(e);
  }
  if (values.isDefault && !values.active) {
    throw appError("invalid_input", "Die Standard-Zahlungsart muss aktiv sein.", { reason: "PAYMENT_METHOD_DEFAULT" });
  }
  const next = all
    .filter((m) => m._id !== methodId)
    .map((m) => ({
      id: m._id as string,
      name: m.name,
      text: m.text,
      kind: m.kind,
      active: m.active,
      isDefault: values.isDefault ? false : m.isDefault,
    }));
  const candidate = { id: methodId ?? "", ...values };
  const r = validatePaymentMethods([...next, candidate]);
  if (!r.ok) throw invalid(r.error);
  if (values.isDefault) {
    for (const m of all) {
      if (m.isDefault && m._id !== methodId) {
        await auditedPatch(
          ctx,
          "paymentMethods",
          m._id,
          { isDefault: false },
          {
            action: "settings.payment_method.update",
            label: m.name,
          },
        );
      }
    }
  }
  if (methodId) {
    await auditedPatch(ctx, "paymentMethods", methodId, values, {
      action: "settings.payment_method.update",
      label: values.name,
    });
    return methodId;
  }
  return auditedInsert(ctx, "paymentMethods", values, { action: "settings.payment_method.create", label: values.name });
}

// ── tags ──────────────────────────────────────────────────────────────────────────────────────────────
export async function listTags(ctx: ReadCtx): Promise<Doc<"tags">[]> {
  return ctx.db.query("tags").collect();
}

export async function saveTag(ctx: ModelCtx, values: TagValues, tagId?: Id<"tags">): Promise<Id<"tags">> {
  const all = await listTags(ctx);
  const r = validateTag(
    { ...(tagId ? { id: tagId as string } : {}), ...values },
    all.map((t) => ({ id: t._id as string, name: t.name })),
  );
  if (!r.ok) throw invalid(r.error);
  const row = { name: values.name, ...(values.color ? { color: values.color } : {}) };
  if (tagId) {
    if (!all.some((t) => t._id === tagId)) throw appError("not_found");
    await auditedPatch(
      ctx,
      "tags",
      tagId,
      { ...row, color: values.color },
      { action: "settings.tag.update", label: values.name },
    );
    return tagId;
  }
  return auditedInsert(ctx, "tags", row, { action: "settings.tag.create", label: values.name });
}

/** SET-094: deleting a tag removes it everywhere (references arrive with contacts/products/documents/vouchers). */
export async function deleteTag(ctx: ModelCtx, tagId: Id<"tags">): Promise<void> {
  const tag = await ctx.db.get(tagId);
  if (!tag) throw appError("not_found");
  await auditedDelete(ctx, "tags", tagId, { action: "settings.tag.delete", label: tag.name });
}

// ── custom field definitions ──────────────────────────────────────────────────────────────────────────
export async function listCustomFieldDefs(ctx: ReadCtx): Promise<Doc<"customFieldDefs">[]> {
  return ctx.db.query("customFieldDefs").collect();
}

export async function customFieldValueCount(_ctx: ReadCtx, _def: Doc<"customFieldDefs">): Promise<number> {
  return 0;
}

export async function createCustomFieldDef(
  ctx: ModelCtx,
  values: CustomFieldDefValues,
): Promise<Id<"customFieldDefs">> {
  const all = await listCustomFieldDefs(ctx);
  const r = validateCustomFieldDef(values, all);
  if (!r.ok) throw invalid(r.error);
  const position = all.filter((d) => d.entity === values.entity).length;
  return auditedInsert(
    ctx,
    "customFieldDefs",
    {
      entity: values.entity,
      key: values.key,
      label: values.label,
      type: values.type,
      ...(values.type === "select" ? { options: values.options } : {}),
      printOnDocuments: values.printOnDocuments,
      required: values.required,
      position,
    },
    { action: "settings.custom_field.create", label: `${values.entity}.${values.key}` },
  );
}

export async function updateCustomFieldDef(
  ctx: ModelCtx,
  defId: Id<"customFieldDefs">,
  values: CustomFieldDefValues,
): Promise<void> {
  const def = await ctx.db.get(defId);
  if (!def) throw appError("not_found");
  if (values.entity !== def.entity) {
    throw appError("invalid_input", "Der Bereich eines Feldes kann nicht geändert werden.", {
      reason: "CUSTOM_FIELD_KEY_LOCKED",
    });
  }
  const e = checkCustomFieldChange(def, values, await customFieldValueCount(ctx, def));
  if (e) throw invalid(e);
  await auditedPatch(
    ctx,
    "customFieldDefs",
    defId,
    {
      label: values.label,
      type: values.type,
      options: values.type === "select" ? values.options : undefined,
      printOnDocuments: values.printOnDocuments,
      required: values.required,
    },
    { action: "settings.custom_field.update", label: `${def.entity}.${def.key}` },
  );
}

/** SET-096: „Löschen“ archives the definition — existing values are hidden, finalised documents keep theirs. */
export async function archiveCustomFieldDef(ctx: ModelCtx, defId: Id<"customFieldDefs">): Promise<void> {
  const def = await ctx.db.get(defId);
  if (!def) throw appError("not_found");
  await auditedPatch(
    ctx,
    "customFieldDefs",
    defId,
    { archivedAt: ctx.now() },
    {
      action: "settings.custom_field.archive",
      label: `${def.entity}.${def.key}`,
    },
  );
}

// ── cost centres ──────────────────────────────────────────────────────────────────────────────────────
export async function listCostCenters(ctx: ReadCtx): Promise<Doc<"costCenters">[]> {
  return ctx.db.query("costCenters").collect();
}

export async function saveCostCenter(
  ctx: ModelCtx,
  values: CostCenterValues,
  costCenterId?: Id<"costCenters">,
): Promise<{ id: Id<"costCenters">; warnings: string[] }> {
  const all = await listCostCenters(ctx);
  const r = validateCostCenter(
    { ...(costCenterId ? { id: costCenterId as string } : {}), ...values },
    all.map((c) => ({ id: c._id as string, number: c.number })),
  );
  if (!r.ok) throw invalid(r.error);
  if (values.isDefault) {
    for (const c of all) {
      if (c.isDefault && c._id !== costCenterId) {
        await auditedPatch(
          ctx,
          "costCenters",
          c._id,
          { isDefault: false },
          { action: "settings.cost_center.update", label: c.number },
        );
      }
    }
  }
  if (costCenterId) {
    const existing = all.find((c) => c._id === costCenterId);
    if (!existing) throw appError("not_found");
    if (existing.archivedAt !== undefined && values.isDefault) {
      throw appError("invalid_input", "Eine archivierte Kostenstelle kann nicht Standard sein.", {
        reason: "COST_CENTER_ARCHIVED",
      });
    }
    await auditedPatch(ctx, "costCenters", costCenterId, values, {
      action: "settings.cost_center.update",
      label: values.number,
    });
    return { id: costCenterId, warnings: r.value.warnings };
  }
  const id = await auditedInsert(ctx, "costCenters", values, {
    action: "settings.cost_center.create",
    label: values.number,
  });
  return { id, warnings: r.value.warnings };
}

/** Archiving hides the cost centre from pickers and clears the default flag (exports keep the number). */
export async function archiveCostCenter(ctx: ModelCtx, costCenterId: Id<"costCenters">): Promise<void> {
  const c = await ctx.db.get(costCenterId);
  if (!c) throw appError("not_found");
  await auditedPatch(
    ctx,
    "costCenters",
    costCenterId,
    { archivedAt: ctx.now(), isDefault: false },
    {
      action: "settings.cost_center.archive",
      label: c.number,
    },
  );
}
