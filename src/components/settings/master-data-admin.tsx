"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { InfoIcon, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { CheckboxField, FormErrorSummary, SelectField, TextField } from "@/components/forms/fields";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES } from "@/domain/lookups/custom-fields";
import { bt81Code, CASH_HELP_TEXT, PAYMENT_METHOD_KINDS } from "@/domain/lookups/payment-methods";
import { TAG_COLORS } from "@/domain/lookups/tags";
import { UNIT_CODES } from "@/domain/rules/unit-codes";
import {
  type CostCenterValues,
  type CustomFieldDefFormValues,
  costCenterSchema,
  customFieldDefSchema,
  type PaymentMethodFormValues,
  paymentMethodSchema,
  type TagValues,
  tagSchema,
  type UnitValues,
  unitSchema,
} from "@/domain/schemas/lookups";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * Stammdaten (F01 SET-090…097, §6.8): units, payment methods, tags, custom fields and cost centres — each tab a
 * compact list with add/edit dialogs. Server rules: src/domain/lookups (re-checked in Convex).
 */
export function MasterDataAdmin() {
  const t = useTranslations("settings.masterData");
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <Tabs defaultValue="einheiten">
        <TabsList className="h-auto w-full justify-start overflow-x-auto">
          {(["einheiten", "zahlungsarten", "tags", "felder", "kostenstellen"] as const).map((tab) => (
            <TabsTrigger key={tab} value={tab} className="h-9 flex-none px-3">
              {t(`tabs.${tab}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="einheiten">
          <UnitsPanel />
        </TabsContent>
        <TabsContent value="zahlungsarten">
          <PaymentMethodsPanel />
        </TabsContent>
        <TabsContent value="tags">
          <TagsPanel />
        </TabsContent>
        <TabsContent value="felder">
          <CustomFieldsPanel />
        </TabsContent>
        <TabsContent value="kostenstellen">
          <CostCentersPanel />
        </TabsContent>
      </Tabs>
    </ConvexGuard>
  );
}

// ── shared pieces ─────────────────────────────────────────────────────────────────────────────────────
function Panel({
  title,
  description,
  addLabel,
  onAdd,
  children,
}: {
  title: string;
  description: string;
  addLabel: string;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle>
            <h2>{title}</h2>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <Button variant="outline" className="h-11 md:h-9" onClick={onAdd}>
          <PlusIcon aria-hidden="true" />
          {addLabel}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

function List({ empty, children }: { empty: string; children: React.ReactNode[] }) {
  if (children.length === 0) return <p className="text-muted-foreground text-sm">{empty}</p>;
  return <ul className="flex flex-col divide-y rounded-lg border">{children}</ul>;
}

function Row({ title, meta, actions }: { title: React.ReactNode; meta: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <li className="flex flex-col gap-2 p-3 text-sm @2xl/main:flex-row @2xl/main:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 font-medium">{title}</span>
        <span className="text-muted-foreground">{meta}</span>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </li>
  );
}

function RowButton({ label, name, onClick }: { label: string; name: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" className="h-11 md:h-8" onClick={onClick}>
      {label}
      <span className="sr-only"> ({name})</span>
    </Button>
  );
}

function FormDialog({
  title,
  description,
  formId,
  onClose,
  onSubmit,
  submitting,
  children,
}: {
  title: string;
  description?: string;
  formId: string;
  onClose: () => void;
  onSubmit: (e?: React.BaseSyntheticEvent) => Promise<void>;
  submitting: boolean;
  children: React.ReactNode;
}) {
  const tCommon = useTranslations("common");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form id={formId} noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
          {children}
        </form>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" form={formId} className="h-11 md:h-9" disabled={submitting}>
            {tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useRun() {
  const showError = useAdapterErrorToast();
  return async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      toast.success(success);
      return true;
    } catch (e) {
      showError(e);
      return false;
    }
  };
}

// ── units (SET-090/091) ───────────────────────────────────────────────────────────────────────────────
type Unit = FunctionReturnType<typeof api.lookups.listUnits>[number];
const UNIT_CODE_OPTIONS = [...UNIT_CODES];

function UnitsPanel() {
  const t = useTranslations("settings.masterData.units");
  const units = useAuthedQuery(api.lookups.listUnits, {});
  const archive = useMutation(api.lookups.archiveUnit);
  const remove = useMutation(api.lookups.deleteUnit);
  const run = useRun();
  const [editing, setEditing] = useState<Unit | "new" | null>(null);
  if (units === undefined) return <div className="h-40" aria-busy="true" />;
  return (
    <Panel title={t("title")} description={t("description")} addLabel={t("add")} onAdd={() => setEditing("new")}>
      <List empty={t("empty")}>
        {units.map((u) => (
          <Row
            key={u.unitId}
            title={
              <>
                <code className="font-mono">{u.code}</code>
                {u.labelDe} / {u.labelEn}
                {u.isSystem && <Badge variant="secondary">{t("system")}</Badge>}
                {u.archivedAt !== null && <Badge variant="outline">{t("archived")}</Badge>}
              </>
            }
            meta={u.archivedAt !== null ? t("archivedHint") : t("labelsHint")}
            actions={
              <>
                <RowButton label={t("edit")} name={u.code} onClick={() => setEditing(u)} />
                <RowButton
                  label={u.archivedAt === null ? t("archive") : t("restore")}
                  name={u.code}
                  onClick={() =>
                    void run(
                      () => archive({ unitId: u.unitId as Id<"units">, archived: u.archivedAt === null }),
                      u.archivedAt === null ? t("archivedDone") : t("restoredDone"),
                    )
                  }
                />
                {!u.isSystem && (
                  <RowButton
                    label={t("delete")}
                    name={u.code}
                    onClick={() => void run(() => remove({ unitId: u.unitId as Id<"units"> }), t("deleted"))}
                  />
                )}
              </>
            }
          />
        ))}
      </List>
      {editing && <UnitDialog unit={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function UnitDialog({ unit, onClose }: { unit: Unit | null; onClose: () => void }) {
  const t = useTranslations("settings.masterData.units");
  const formId = useId();
  const listId = useId();
  const create = useMutation(api.lookups.createUnit);
  const update = useMutation(api.lookups.updateUnit);
  const run = useRun();
  const form = useZodForm(unitSchema, {
    code: unit?.code ?? "",
    labelDe: unit?.labelDe ?? "",
    labelEn: unit?.labelEn ?? "",
  }) as UseFormReturn<UnitValues, unknown, UnitValues>;
  const submit = form.handleSubmit(async (values) => {
    const ok = await run(
      () => (unit ? update({ unitId: unit.unitId as Id<"units">, values }) : create({ values })),
      t("saved"),
    );
    if (ok) onClose();
  });
  return (
    <FormDialog
      title={unit ? t("editTitle") : t("addTitle")}
      description={t("codeHint")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
    >
      <FormErrorSummary form={form} />
      <TextField
        form={form}
        name="code"
        label={t("code")}
        required
        list={listId}
        disabled={unit !== null}
        autoCapitalize="characters"
        spellCheck={false}
      />
      <datalist id={listId}>
        {UNIT_CODE_OPTIONS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <TextField form={form} name="labelDe" label={t("labelDe")} required maxLength={20} />
      <TextField form={form} name="labelEn" label={t("labelEn")} required maxLength={20} />
    </FormDialog>
  );
}

// ── payment methods (SET-092/093) ─────────────────────────────────────────────────────────────────────
type PaymentMethod = FunctionReturnType<typeof api.lookups.listPaymentMethods>[number];

function PaymentMethodsPanel() {
  const t = useTranslations("settings.masterData.paymentMethods");
  const methods = useAuthedQuery(api.lookups.listPaymentMethods, {});
  const [editing, setEditing] = useState<PaymentMethod | "new" | null>(null);
  if (methods === undefined) return <div className="h-40" aria-busy="true" />;
  return (
    <Panel title={t("title")} description={t("description")} addLabel={t("add")} onAdd={() => setEditing("new")}>
      <p className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 p-3 text-info text-sm">
        <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {CASH_HELP_TEXT}
      </p>
      <List empty={t("empty")}>
        {methods.map((m) => (
          <Row
            key={m.paymentMethodId}
            title={
              <>
                {m.name}
                {m.isDefault && <Badge variant="secondary">{t("default")}</Badge>}
                {!m.active && <Badge variant="outline">{t("inactive")}</Badge>}
              </>
            }
            meta={`${t(`kinds.${m.kind}`)} · ${t("bt81", { code: m.kind === "transfer" ? t("transferCodes") : bt81Code(m.kind, undefined) })}`}
            actions={<RowButton label={t("edit")} name={m.name} onClick={() => setEditing(m)} />}
          />
        ))}
      </List>
      {editing && <PaymentMethodDialog method={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function PaymentMethodDialog({ method, onClose }: { method: PaymentMethod | null; onClose: () => void }) {
  const t = useTranslations("settings.masterData.paymentMethods");
  const formId = useId();
  const textId = useId();
  const save = useMutation(api.lookups.savePaymentMethod);
  const run = useRun();
  const form = useZodForm(paymentMethodSchema, {
    name: method?.name ?? "",
    text: method?.text ?? "",
    kind: method?.kind ?? "other",
    isDefault: method?.isDefault ?? false,
    active: method?.active ?? true,
  }) as UseFormReturn<PaymentMethodFormValues, unknown, PaymentMethodFormValues>;
  const kind = useWatch({ control: form.control, name: "kind" });
  const submit = form.handleSubmit(async (values) => {
    const ok = await run(
      () => save({ values, ...(method ? { paymentMethodId: method.paymentMethodId as Id<"paymentMethods"> } : {}) }),
      t("saved"),
    );
    if (ok) onClose();
  });
  return (
    <FormDialog
      title={method ? t("editTitle") : t("addTitle")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
    >
      <FormErrorSummary form={form} />
      <TextField form={form} name="name" label={t("name")} required maxLength={60} />
      <SelectField
        form={form}
        name="kind"
        label={t("kind")}
        disabled={method !== null}
        options={PAYMENT_METHOD_KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
        description={kind === "cash" ? CASH_HELP_TEXT : kind === "sepa_debit" ? t("sepaHint") : undefined}
      />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={textId}>{t("text")}</Label>
        <Textarea id={textId} rows={3} maxLength={500} {...form.register("text")} />
      </div>
      <CheckboxField form={form} name="active" label={t("active")} />
      <CheckboxField form={form} name="isDefault" label={t("isDefault")} />
    </FormDialog>
  );
}

// ── tags (SET-094) ────────────────────────────────────────────────────────────────────────────────────
type Tag = FunctionReturnType<typeof api.lookups.listTags>[number];
const SWATCH: Record<string, string> = {
  gray: "bg-gray-400",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-400",
  green: "bg-green-600",
  teal: "bg-teal-500",
  blue: "bg-blue-600",
  indigo: "bg-indigo-500",
  purple: "bg-purple-500",
  pink: "bg-pink-500",
};

function TagsPanel() {
  const t = useTranslations("settings.masterData.tags");
  const tags = useAuthedQuery(api.lookups.listTags, {});
  const remove = useMutation(api.lookups.deleteTag);
  const run = useRun();
  const [editing, setEditing] = useState<Tag | "new" | null>(null);
  if (tags === undefined) return <div className="h-40" aria-busy="true" />;
  return (
    <Panel title={t("title")} description={t("description")} addLabel={t("add")} onAdd={() => setEditing("new")}>
      <List empty={t("empty")}>
        {tags.map((tag) => (
          <Row
            key={tag.tagId}
            title={
              <>
                <span
                  aria-hidden="true"
                  className={`size-3 rounded-full ${SWATCH[tag.color ?? "gray"] ?? "bg-gray-400"}`}
                />
                {tag.name}
              </>
            }
            meta={t("usage", { count: tag.usage })}
            actions={
              <>
                <RowButton label={t("edit")} name={tag.name} onClick={() => setEditing(tag)} />
                <RowButton
                  label={t("delete")}
                  name={tag.name}
                  onClick={() => void run(() => remove({ tagId: tag.tagId as Id<"tags"> }), t("deleted"))}
                />
              </>
            }
          />
        ))}
      </List>
      {editing && <TagDialog tag={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function TagDialog({ tag, onClose }: { tag: Tag | null; onClose: () => void }) {
  const t = useTranslations("settings.masterData.tags");
  const formId = useId();
  const save = useMutation(api.lookups.saveTag);
  const run = useRun();
  const form = useZodForm(tagSchema, {
    name: tag?.name ?? "",
    ...(tag?.color ? { color: tag.color as TagValues["color"] } : { color: "blue" as const }),
  }) as UseFormReturn<TagValues, unknown, TagValues>;
  const submit = form.handleSubmit(async (values) => {
    const ok = await run(() => save({ values, ...(tag ? { tagId: tag.tagId as Id<"tags"> } : {}) }), t("saved"));
    if (ok) onClose();
  });
  return (
    <FormDialog
      title={tag ? t("editTitle") : t("addTitle")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
    >
      <FormErrorSummary form={form} />
      <TextField form={form} name="name" label={t("name")} required maxLength={40} />
      <SelectField
        form={form}
        name="color"
        label={t("color")}
        options={TAG_COLORS.map((c) => ({ value: c, label: t(`colors.${c}`) }))}
      />
    </FormDialog>
  );
}

// ── custom fields (SET-095/096) ───────────────────────────────────────────────────────────────────────
type CustomField = FunctionReturnType<typeof api.lookups.listCustomFields>[number];

function CustomFieldsPanel() {
  const t = useTranslations("settings.masterData.customFields");
  const fields = useAuthedQuery(api.lookups.listCustomFields, {});
  const archive = useMutation(api.lookups.archiveCustomField);
  const run = useRun();
  const [editing, setEditing] = useState<CustomField | "new" | null>(null);
  if (fields === undefined) return <div className="h-40" aria-busy="true" />;
  return (
    <Panel title={t("title")} description={t("description")} addLabel={t("add")} onAdd={() => setEditing("new")}>
      <List empty={t("empty")}>
        {fields.map((f) => (
          <Row
            key={f.customFieldId}
            title={
              <>
                {f.label}
                <Badge variant="outline">{t(`entities.${f.entity}`)}</Badge>
                {f.printOnDocuments && <Badge variant="secondary">{t("printsBadge")}</Badge>}
              </>
            }
            meta={
              <>
                <code className="font-mono">{f.key}</code> · {t(`types.${f.type}`)} · {t("values", { count: f.values })}
              </>
            }
            actions={
              <>
                <RowButton label={t("edit")} name={f.label} onClick={() => setEditing(f)} />
                <RowButton
                  label={t("delete")}
                  name={f.label}
                  onClick={() =>
                    void run(() => archive({ customFieldId: f.customFieldId as Id<"customFieldDefs"> }), t("deleted"))
                  }
                />
              </>
            }
          />
        ))}
      </List>
      {editing && <CustomFieldDialog field={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function CustomFieldDialog({ field, onClose }: { field: CustomField | null; onClose: () => void }) {
  const t = useTranslations("settings.masterData.customFields");
  const formId = useId();
  const optionsId = useId();
  const create = useMutation(api.lookups.createCustomField);
  const update = useMutation(api.lookups.updateCustomField);
  const run = useRun();
  const form = useZodForm(customFieldDefSchema, {
    entity: field?.entity ?? "contact",
    key: field?.key ?? "",
    label: field?.label ?? "",
    type: field?.type ?? "text",
    options: (field?.options ?? []).join("\n"),
    printOnDocuments: field?.printOnDocuments ?? false,
    required: field?.required ?? false,
  }) as unknown as UseFormReturn<CustomFieldDefFormValues>;
  const type = useWatch({ control: form.control, name: "type" });
  const submit = form.handleSubmit(async () => {
    // Send the raw form values; the server applies the same schema (options one per line).
    const values = form.getValues();
    const ok = await run(
      () =>
        field ? update({ customFieldId: field.customFieldId as Id<"customFieldDefs">, values }) : create({ values }),
      t("saved"),
    );
    if (ok) onClose();
  });
  return (
    <FormDialog
      title={field ? t("editTitle") : t("addTitle")}
      description={field ? t("lockedHint") : undefined}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
    >
      <FormErrorSummary form={form} />
      <SelectField
        form={form}
        name="entity"
        label={t("entity")}
        disabled={field !== null}
        options={CUSTOM_FIELD_ENTITIES.map((e) => ({ value: e, label: t(`entities.${e}`) }))}
      />
      <TextField
        form={form}
        name="key"
        label={t("key")}
        required
        disabled={field !== null}
        spellCheck={false}
        description={t("keyHint")}
      />
      <TextField form={form} name="label" label={t("label")} required maxLength={60} />
      <SelectField
        form={form}
        name="type"
        label={t("type")}
        options={CUSTOM_FIELD_TYPES.map((x) => ({ value: x, label: t(`types.${x}`) }))}
      />
      {type === "select" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={optionsId}>{t("options")}</Label>
          <Textarea id={optionsId} rows={4} aria-describedby={`${optionsId}-hint`} {...form.register("options")} />
          <p id={`${optionsId}-hint`} className="text-muted-foreground text-xs">
            {t("optionsHint")}
          </p>
          {form.formState.errors.options?.message && (
            <p className="text-danger text-sm">{form.formState.errors.options.message}</p>
          )}
        </div>
      )}
      <CheckboxField form={form} name="printOnDocuments" label={t("printOnDocuments")} />
      <CheckboxField form={form} name="required" label={t("required")} />
    </FormDialog>
  );
}

// ── cost centres (SET-097) ────────────────────────────────────────────────────────────────────────────
type CostCenter = FunctionReturnType<typeof api.lookups.listCostCenters>[number];

function CostCentersPanel() {
  const t = useTranslations("settings.masterData.costCenters");
  const centers = useAuthedQuery(api.lookups.listCostCenters, {});
  const archive = useMutation(api.lookups.archiveCostCenter);
  const run = useRun();
  const [editing, setEditing] = useState<CostCenter | "new" | null>(null);
  if (centers === undefined) return <div className="h-40" aria-busy="true" />;
  return (
    <Panel title={t("title")} description={t("description")} addLabel={t("add")} onAdd={() => setEditing("new")}>
      <List empty={t("empty")}>
        {centers.map((c) => (
          <Row
            key={c.costCenterId}
            title={
              <>
                <code className="font-mono">{c.number}</code>
                {c.name}
                {c.isDefault && <Badge variant="secondary">{t("default")}</Badge>}
                {c.archivedAt !== null && <Badge variant="outline">{t("archived")}</Badge>}
              </>
            }
            meta={t("datevHint")}
            actions={
              c.archivedAt === null ? (
                <>
                  <RowButton label={t("edit")} name={c.number} onClick={() => setEditing(c)} />
                  <RowButton
                    label={t("archive")}
                    name={c.number}
                    onClick={() =>
                      void run(() => archive({ costCenterId: c.costCenterId as Id<"costCenters"> }), t("archivedDone"))
                    }
                  />
                </>
              ) : undefined
            }
          />
        ))}
      </List>
      {editing && <CostCenterDialog center={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function CostCenterDialog({ center, onClose }: { center: CostCenter | null; onClose: () => void }) {
  const t = useTranslations("settings.masterData.costCenters");
  const formId = useId();
  const save = useMutation(api.lookups.saveCostCenter);
  const showError = useAdapterErrorToast();
  const form = useZodForm(costCenterSchema, {
    number: center?.number ?? "",
    name: center?.name ?? "",
    isDefault: center?.isDefault ?? false,
  }) as UseFormReturn<CostCenterValues, unknown, CostCenterValues>;
  const submit = form.handleSubmit(async (values) => {
    try {
      const r = await save({ values, ...(center ? { costCenterId: center.costCenterId as Id<"costCenters"> } : {}) });
      toast.success(t("saved"));
      for (const w of r.warnings) toast.warning(w);
      onClose();
    } catch (e) {
      showError(e);
    }
  });
  return (
    <FormDialog
      title={center ? t("editTitle") : t("addTitle")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
    >
      <FormErrorSummary form={form} />
      <TextField form={form} name="number" label={t("number")} required maxLength={36} spellCheck={false} />
      <TextField form={form} name="name" label={t("name")} required maxLength={60} />
      <CheckboxField form={form} name="isDefault" label={t("isDefault")} />
    </FormDialog>
  );
}
