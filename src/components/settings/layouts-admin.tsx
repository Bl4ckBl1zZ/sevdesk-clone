"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ExternalLinkIcon, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { FormErrorSummary, TextField } from "@/components/forms/fields";
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
import { PREVIEW_SAMPLE_TYPES, SALES_DOC_TYPES } from "@/domain/documents/layout";
import { NUMBERED_TYPE_LABEL_DE } from "@/domain/numbering/register";
import { layoutCreateSchema } from "@/domain/schemas/settings";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type Layout = FunctionReturnType<typeof api.settings.listLayoutsWithDefaults>[number];
type CreateForm = UseFormReturn<{ name: string }, unknown, { name: string }>;

const typeLabel = (t: string) => NUMBERED_TYPE_LABEL_DE[t] ?? t;
const SELECT =
  "h-11 w-full rounded-md border border-input bg-background px-2.5 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm dark:bg-input/30";

/**
 * „Alle Layouts“ (F01 SET-070, SET-074) and the layout preview (SET-073): one default layout per document type,
 * further layouts copied from the default, and a sample PDF (Rechnung/Angebot/Mahnung/Lieferschein, B2B/B2C, KU).
 */
export function LayoutsAdmin() {
  return (
    <ConvexGuard fallback={null}>
      <LayoutsAdminInner />
    </ConvexGuard>
  );
}

function LayoutsAdminInner() {
  const t = useTranslations("settings.layouts");
  const layouts = useAuthedQuery(api.settings.listLayoutsWithDefaults, {});
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Layout | null>(null);
  if (layouts === undefined) return <div className="h-40" aria-busy="true" />;
  return (
    <>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <CardTitle>
              <h2>{t("title")}</h2>
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <Button variant="outline" className="h-11 md:h-9" onClick={() => setCreating(true)}>
            <PlusIcon aria-hidden="true" />
            {t("create")}
          </Button>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y rounded-lg border">
            {layouts.map((l) => (
              <li
                key={l.layoutId}
                className="flex flex-col gap-2 p-3 text-sm @2xl/main:flex-row @2xl/main:items-center"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    <span
                      aria-hidden="true"
                      className="size-3 rounded-full border"
                      style={{ background: l.accentColor }}
                    />
                    {l.name}
                    <Badge variant="outline">{t("version", { version: l.version })}</Badge>
                  </span>
                  <span className="text-muted-foreground">
                    {l.isDefaultFor.length
                      ? t("defaultsFor", { types: l.isDefaultFor.map(typeLabel).join(", ") })
                      : t("noDefaults")}
                  </span>
                </div>
                <Button variant="outline" size="sm" className="h-11 md:h-8" onClick={() => setEditing(l)}>
                  {t("setDefaults")}
                  <span className="sr-only"> ({l.name})</span>
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <PreviewCard layouts={layouts} />
      <CreateLayoutDialog open={creating} onOpenChange={setCreating} />
      {editing && <DefaultsDialog layout={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function PreviewCard({ layouts }: { layouts: Layout[] }) {
  const t = useTranslations("settings.layouts");
  const ids = { typ: useId(), kunde: useId(), ku: useId(), layout: useId() };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("previewTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("previewDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          action="/einstellungen/layouts/vorschau"
          method="get"
          target="_blank"
          className="grid gap-4 @2xl/main:grid-cols-4"
          rel="noopener"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.typ}>{t("sampleType")}</Label>
            <select id={ids.typ} name="typ" className={SELECT} defaultValue="invoice">
              {PREVIEW_SAMPLE_TYPES.map((s) => (
                <option key={s} value={s}>
                  {t(`sample.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.kunde}>{t("customer")}</Label>
            <select id={ids.kunde} name="kunde" className={SELECT} defaultValue="b2b">
              <option value="b2b">{t("b2b")}</option>
              <option value="b2c">{t("b2c")}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.ku}>{t("taxation")}</Label>
            <select id={ids.ku} name="ku" className={SELECT} defaultValue="">
              <option value="">{t("kuCurrent")}</option>
              <option value="1">{t("kuYes")}</option>
              <option value="0">{t("kuNo")}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.layout}>{t("layout")}</Label>
            <select id={ids.layout} name="layout" className={SELECT} defaultValue="">
              <option value="">Standard</option>
              {layouts.map((l) => (
                <option key={l.layoutId} value={l.layoutId}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="@2xl/main:col-span-4">
            <Button type="submit" variant="outline" className="h-11 md:h-9">
              <ExternalLinkIcon aria-hidden="true" />
              {t("openPreview")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function CreateLayoutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("settings.layouts");
  const tCommon = useTranslations("common");
  const formId = useId();
  const create = useMutation(api.settings.createLayoutVariant);
  const showError = useAdapterErrorToast();
  const form = useZodForm(layoutCreateSchema, { name: "" }) as CreateForm;
  const submit = form.handleSubmit(async (values) => {
    try {
      await create({ values });
      toast.success(t("created"));
      form.reset({ name: "" });
      onOpenChange(false);
    } catch (e) {
      showError(e);
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDescription")}</DialogDescription>
        </DialogHeader>
        <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
          <FormErrorSummary form={form} />
          <TextField form={form} name="name" label={t("name")} required maxLength={60} />
        </form>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" form={formId} className="h-11 md:h-9" disabled={form.formState.isSubmitting}>
            {t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DefaultsDialog({ layout, onClose }: { layout: Layout; onClose: () => void }) {
  const t = useTranslations("settings.layouts");
  const tCommon = useTranslations("common");
  const save = useMutation(api.settings.setLayoutDefaults);
  const showError = useAdapterErrorToast();
  const [selected, setSelected] = useState<string[]>([...layout.isDefaultFor]);
  const [busy, setBusy] = useState(false);
  const baseId = useId();
  const toggle = (type: string, on: boolean) =>
    setSelected((s) => (on ? [...new Set([...s, type])] : s.filter((x) => x !== type)));
  const submit = async () => {
    setBusy(true);
    try {
      await save({ layoutId: layout.layoutId as Id<"layouts">, docTypes: selected });
      toast.success(t("defaultsSaved"));
      onClose();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("defaultsTitle")}</DialogTitle>
          <DialogDescription>{t("defaultsDescription", { name: layout.name })}</DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">{t("defaultsTitle")}</legend>
          {SALES_DOC_TYPES.map((type) => {
            const id = `${baseId}-${type}`;
            return (
              <div key={type} className="flex items-center gap-3">
                <input
                  id={id}
                  type="checkbox"
                  className="size-5 shrink-0 accent-primary md:size-4"
                  checked={selected.includes(type)}
                  onChange={(e) => toggle(type, e.target.checked)}
                />
                <label htmlFor={id} className="text-sm">
                  {typeLabel(type)}
                </label>
              </div>
            );
          })}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button className="h-11 md:h-9" disabled={busy} onClick={() => void submit()}>
            {tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
