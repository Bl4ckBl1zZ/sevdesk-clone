"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { BoldIcon, BracesIcon, ItalicIcon, ListIcon, PlusIcon, RotateCcwIcon, UnderlineIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useRef, useState } from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { CheckboxField, FormErrorSummary, SelectField, TextField } from "@/components/forms/fields";
import { adapterErrorMessage } from "@/components/setup/actions";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SALES_DOC_TYPES } from "@/domain/documents/layout";
import { NUMBERED_TYPE_LABEL_DE } from "@/domain/numbering/register";
import { type TextTemplateValues, textTemplateSchema } from "@/domain/schemas/lookups";
import { TEMPLATE_KIND_LABEL_DE, TEMPLATE_KINDS } from "@/domain/templates/defaults";
import {
  type PlaceholderDef,
  placeholderGroups,
  placeholderSnippet,
  renderTemplate,
  samplePlaceholderValues,
  searchPlaceholders,
} from "@/domain/templates/placeholders";
import { sanitizeTemplateHtml } from "@/domain/templates/sanitize";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type Template = FunctionReturnType<typeof api.lookups.listTextTemplates>[number];
type TemplateForm = UseFormReturn<TextTemplateValues, unknown, TextTemplateValues>;

const typeLabel = (t: string) => NUMBERED_TYPE_LABEL_DE[t] ?? t;
const LANGUAGE_LABEL: Record<string, string> = { de: "Deutsch", en: "Englisch" };

/**
 * Textvorlagen (F01 SET-080…087, §6.7): head/foot texts and copyable e-mail texts per document type and language,
 * a source editor with a small toolbar, the placeholder picker (grouped, searchable, live sample values) and a
 * preview that resolves the placeholders against sample data. The server sanitises and checks every save.
 */
export function TextTemplatesAdmin() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <TextTemplatesAdminInner />
    </ConvexGuard>
  );
}

function TextTemplatesAdminInner() {
  const t = useTranslations("settings.textTemplates");
  const templates = useAuthedQuery(api.lookups.listTextTemplates, {});
  const restore = useMutation(api.lookups.restoreDefaultTextTemplates);
  const showError = useAdapterErrorToast();
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const [kind, setKind] = useState<string>("all");
  const filterId = useId();
  if (templates === undefined) return <div className="h-96" aria-busy="true" />;
  const visible = templates.filter((x) => kind === "all" || x.kind === kind);
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle>
            <h2>{t("title")}</h2>
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="h-11 md:h-9"
            onClick={async () => {
              try {
                const n = await restore({});
                toast.success(t("restored", { count: n }));
              } catch (e) {
                showError(e);
              }
            }}
          >
            <RotateCcwIcon aria-hidden="true" />
            {t("restore")}
          </Button>
          <Button className="h-11 md:h-9" onClick={() => setEditing("new")}>
            <PlusIcon aria-hidden="true" />
            {t("create")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex max-w-xs flex-col gap-1.5">
          <Label htmlFor={filterId}>{t("filterKind")}</Label>
          <select
            id={filterId}
            className="h-11 rounded-md border border-input bg-background px-2.5 text-base md:h-9 md:text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="all">{t("allKinds")}</option>
            {TEMPLATE_KINDS.map((k) => (
              <option key={k} value={k}>
                {TEMPLATE_KIND_LABEL_DE[k]}
              </option>
            ))}
          </select>
        </div>
        {visible.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {visible.map((x) => (
              <TemplateRow key={x.templateId} template={x} onEdit={() => setEditing(x)} />
            ))}
          </ul>
        )}
      </CardContent>
      {editing && <TemplateEditor template={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function TemplateRow({ template, onEdit }: { template: Template; onEdit: () => void }) {
  const t = useTranslations("settings.textTemplates");
  const remove = useMutation(api.lookups.deleteTextTemplate);
  const showError = useAdapterErrorToast();
  return (
    <li className="flex flex-col gap-2 p-3 text-sm @2xl/main:flex-row @2xl/main:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {template.name}
          {template.isDefault && <Badge variant="secondary">{t("default")}</Badge>}
          <Badge variant="outline">{template.language.toUpperCase()}</Badge>
        </span>
        <span className="text-muted-foreground">
          {TEMPLATE_KIND_LABEL_DE[template.kind]} · {template.docTypes.map(typeLabel).join(", ")}
        </span>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="h-11 md:h-8" onClick={onEdit}>
          {t("edit")}
          <span className="sr-only"> ({template.name})</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-11 md:h-8"
          onClick={async () => {
            try {
              await remove({ templateId: template.templateId as Id<"textTemplates"> });
              toast.success(t("deleted"));
            } catch (e) {
              showError(e);
            }
          }}
        >
          {t("delete")}
          <span className="sr-only"> ({template.name})</span>
        </Button>
      </div>
    </li>
  );
}

const emptyTemplate: TextTemplateValues = {
  kind: "document_head",
  docTypes: ["invoice"],
  language: "de",
  name: "",
  subject: "",
  body: "<p>{{contact.letterSalutation}}</p>\n<p></p>",
  isDefault: false,
};

export function TemplateEditor({ template, onClose }: { template: Template | null; onClose: () => void }) {
  const t = useTranslations("settings.textTemplates");
  const tCommon = useTranslations("common");
  const formId = useId();
  const bodyId = useId();
  const save = useMutation(api.lookups.saveTextTemplate);
  const [serverError, setServerError] = useState<string | null>(null);
  const defaults: TextTemplateValues = template
    ? {
        kind: template.kind,
        docTypes: [...template.docTypes] as TextTemplateValues["docTypes"],
        language: template.language,
        name: template.name,
        subject: template.subject,
        body: template.body,
        isDefault: template.isDefault,
      }
    : emptyTemplate;
  const form = useZodForm(textTemplateSchema, defaults) as TemplateForm;
  const [kind, docTypes, body, subject] = useWatch({
    control: form.control,
    name: ["kind", "docTypes", "body", "subject"],
  });
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const [picking, setPicking] = useState(false);
  const bodyField = form.register("body");
  const bodyError = form.formState.errors.body?.message;

  const insert = (before: string, after = "") => {
    const el = textarea.current;
    const value = form.getValues("body");
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${before}${value.slice(start, end)}${after}${value.slice(end)}`;
    form.setValue("body", next, { shouldDirty: true, shouldValidate: true });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + before.length, end + before.length);
    });
  };

  const preview = useMemo(() => renderTemplate(sanitizeTemplateHtml(body ?? ""), samplePlaceholderValues()), [body]);
  const subjectPreview = useMemo(() => renderTemplate(subject ?? "", samplePlaceholderValues()), [subject]);

  const submit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      await save({
        values,
        ...(template ? { templateId: template.templateId as Id<"textTemplates"> } : {}),
      });
      toast.success(t("saved"));
      onClose();
    } catch (e) {
      setServerError(adapterErrorMessage(e) ?? t("saveFailed"));
    }
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{template ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription>{t("editorDescription")}</DialogDescription>
        </DialogHeader>
        <form id={formId} noValidate onSubmit={submit} className="@container/form flex flex-col gap-4">
          <FormErrorSummary form={form} />
          {serverError && (
            <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 p-3 text-danger text-sm">
              {serverError}
            </p>
          )}
          <div className="grid gap-4 @2xl/form:grid-cols-3">
            <TextField form={form} name="name" label={t("name")} required maxLength={80} />
            <SelectField
              form={form}
              name="kind"
              label={t("kind")}
              options={TEMPLATE_KINDS.map((k) => ({ value: k, label: TEMPLATE_KIND_LABEL_DE[k] }))}
            />
            <SelectField
              form={form}
              name="language"
              label={t("language")}
              options={["de", "en"].map((l) => ({ value: l, label: LANGUAGE_LABEL[l] ?? l }))}
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-medium text-sm">{t("docTypes")}</legend>
            <div className="grid gap-2 @lg/form:grid-cols-3">
              {SALES_DOC_TYPES.map((d) => {
                const id = `${formId}-${d}`;
                return (
                  <div key={d} className="flex items-center gap-3">
                    <input
                      id={id}
                      type="checkbox"
                      value={d}
                      className="size-5 shrink-0 accent-primary md:size-4"
                      {...form.register("docTypes")}
                    />
                    <label htmlFor={id} className="text-sm">
                      {typeLabel(d)}
                    </label>
                  </div>
                );
              })}
            </div>
          </fieldset>
          <CheckboxField form={form} name="isDefault" label={t("isDefault")} description={t("isDefaultHint")} />
          {kind === "message_text" && <TextField form={form} name="subject" label={t("subject")} maxLength={200} />}
          <div className="grid gap-4 @3xl/form:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor={bodyId}>{t("body")}</Label>
                <div role="toolbar" aria-label={t("toolbar")} className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("bold")}
                    onClick={() => insert("<strong>", "</strong>")}
                  >
                    <BoldIcon aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("italic")}
                    onClick={() => insert("<em>", "</em>")}
                  >
                    <ItalicIcon aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("underline")}
                    onClick={() => insert("<u>", "</u>")}
                  >
                    <UnderlineIcon aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("list")}
                    onClick={() => insert("<ul><li>", "</li></ul>")}
                  >
                    <ListIcon aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setPicking(true)}>
                    <BracesIcon aria-hidden="true" />
                    {t("insertPlaceholder")}
                  </Button>
                </div>
              </div>
              <textarea
                id={bodyId}
                rows={12}
                spellCheck={false}
                aria-invalid={bodyError ? true : undefined}
                aria-describedby={bodyError ? `${bodyId}-error` : undefined}
                className="min-h-48 w-full rounded-md border border-input bg-background p-2.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
                {...bodyField}
                ref={(el) => {
                  bodyField.ref(el);
                  textarea.current = el;
                }}
              />
              {bodyError && (
                <p id={`${bodyId}-error`} className="text-danger text-sm">
                  {bodyError}
                </p>
              )}
            </div>
            <section aria-labelledby={`${bodyId}-preview`} className="flex flex-col gap-1.5">
              <h3 id={`${bodyId}-preview`} className="font-medium text-sm">
                {t("preview")}
              </h3>
              <div className="min-h-48 rounded-md border bg-muted/30 p-3 text-sm [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5">
                {kind === "message_text" && subjectPreview && (
                  <p className="font-medium" data-testid="subject-preview">
                    {subjectPreview}
                  </p>
                )}
                {/* Sanitised by the same allowlist as on the server (SET-081); values are HTML-escaped. */}
                {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised template preview */}
                <div data-testid="template-preview" dangerouslySetInnerHTML={{ __html: preview }} />
              </div>
              <p className="text-muted-foreground text-xs">{t("previewHint")}</p>
            </section>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" form={formId} className="h-11 md:h-9" disabled={form.formState.isSubmitting}>
            {tCommon("save")}
          </Button>
        </DialogFooter>
        {picking && (
          <PlaceholderPicker
            kind={kind}
            docTypes={docTypes ?? []}
            onPick={(p) => {
              insert(placeholderSnippet(p));
              setPicking(false);
            }}
            onClose={() => setPicking(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** SET-087: searchable picker grouped by namespace with German labels and live sample values. */
export function PlaceholderPicker({
  kind,
  docTypes,
  onPick,
  onClose,
}: {
  kind: TextTemplateValues["kind"];
  docTypes: readonly string[];
  onPick: (p: PlaceholderDef) => void;
  onClose: () => void;
}) {
  const t = useTranslations("settings.textTemplates");
  const [query, setQuery] = useState("");
  const searchId = useId();
  const groups = useMemo(
    () => searchPlaceholders(placeholderGroups({ kind, docTypes }), query),
    [kind, docTypes, query],
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("pickerTitle")}</DialogTitle>
          <DialogDescription>{t("pickerDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={searchId}>{t("search")}</Label>
          <Input
            id={searchId}
            type="search"
            className="h-11 md:h-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        {groups.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noMatch")}</p>
        ) : (
          groups.map((g) => (
            <section key={g.namespace} aria-labelledby={`${searchId}-${g.namespace}`} className="flex flex-col gap-1">
              <h3 id={`${searchId}-${g.namespace}`} className="font-medium text-muted-foreground text-xs uppercase">
                {g.label}
              </h3>
              <ul className="flex flex-col">
                {g.items.map((p) => (
                  <li key={p.key}>
                    <button
                      type="button"
                      className="flex w-full flex-col items-start rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => onPick(p)}
                    >
                      <span className="font-medium">{p.label}</span>
                      <span className="font-mono text-muted-foreground text-xs">{placeholderSnippet(p)}</span>
                      {p.sample && !p.flag && (
                        <span className="text-muted-foreground text-xs">{t("sample", { value: p.sample })}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </DialogContent>
    </Dialog>
  );
}
