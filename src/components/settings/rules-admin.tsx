"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { ConfirmDialog, formatDate, useCan } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { FormErrorSummary, SelectField, TextField } from "@/components/forms/fields";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  OVERRIDE_RULE_SET_LABEL_DE,
  OVERRIDE_RULE_SETS,
  overrideTableIds,
  RULE_GROUP_LABEL_DE,
  type RuleGroup,
} from "@/domain/rules/overrides";
import { type RuleOverrideFormValues, type RuleOverrideValues, ruleOverrideSchema } from "@/domain/schemas/settings";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type Overview = FunctionReturnType<typeof api.settings.ruleOverview>;
type TableView = Overview["tables"][number];
type OverrideForm = UseFormReturn<RuleOverrideFormValues, unknown, RuleOverrideValues>;

const GROUPS: readonly RuleGroup[] = ["basiszinssatz", "taxRate", "noteText", "other"];

/**
 * F01 SET-120…123 `/einstellungen/regeln`: the shipped date-effective rule tables with source and validity, the row
 * effective today, and the owner's overrides (add; delete only while no finalised document used them).
 */
export function RulesAdmin() {
  return (
    <ConvexGuard fallback={<div className="h-64" aria-busy="true" />}>
      <RulesAdminInner />
    </ConvexGuard>
  );
}

function RulesAdminInner() {
  const t = useTranslations("settings.rules");
  const data = useAuthedQuery(api.settings.ruleOverview, {});
  const canWrite = useCan("settings.write");
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; label: string } | null>(null);
  if (data === undefined) return <div className="h-64" aria-busy="true" />;
  const locked = new Map(data.overrides.map((o) => [o.id, o.locked]));
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <CardTitle>
              <h2>{t("overridesTitle")}</h2>
            </CardTitle>
            <CardDescription>{t("overridesDescription")}</CardDescription>
          </div>
          {canWrite && (
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setAdding(true)}>
              <PlusIcon aria-hidden="true" />
              {t("add")}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {data.overrides.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("noOverrides")}</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border" data-testid="rule-overrides">
              {data.overrides.map((o) => {
                const label = `${o.tableId} ab ${formatDate(o.validFrom)}`;
                return (
                  <li key={o.id} className="flex flex-col gap-2 p-3 text-sm @2xl/main:flex-row @2xl/main:items-center">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {OVERRIDE_RULE_SET_LABEL_DE[o.ruleSet]} · {o.tableId}
                        {o.locked && <Badge variant="outline">{t("locked")}</Badge>}
                      </span>
                      <span className="text-muted-foreground">
                        {formatDate(o.validFrom)} – {o.validTo ? formatDate(o.validTo) : t("open")} · {t("source")}:{" "}
                        {o.source}
                      </span>
                    </div>
                    {canWrite && !o.locked && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-11 md:h-8"
                        onClick={() => setDeleting({ id: o.id, label })}
                      >
                        {t("delete")}
                        <span className="sr-only"> ({label})</span>
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      {GROUPS.map((g) => (
        <RuleGroupCard key={g} group={g} tables={data.tables.filter((x) => x.group === g)} locked={locked} />
      ))}
      {adding && <AddOverrideDialog onClose={() => setAdding(false)} />}
      {deleting && <DeleteOverrideDialog target={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function RuleGroupCard({
  group,
  tables,
  locked,
}: {
  group: RuleGroup;
  tables: TableView[];
  locked: Map<string, boolean>;
}) {
  const t = useTranslations("settings.rules");
  if (tables.length === 0) return null;
  const body = (
    <Table scrollLabel={RULE_GROUP_LABEL_DE[group]}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("table")}</TableHead>
          <TableHead>{t("validity")}</TableHead>
          <TableHead>{t("value")}</TableHead>
          <TableHead>{t("source")}</TableHead>
          <TableHead>{t("origin")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tables.flatMap((table) =>
          table.rows.map((r) => (
            <TableRow key={r.rowId} data-current={r.current || undefined}>
              <TableCell className="font-mono text-xs">{table.id}</TableCell>
              <TableCell className="whitespace-nowrap">
                {formatDate(r.validFrom)} – {r.validTo ? formatDate(r.validTo) : t("open")}
              </TableCell>
              <TableCell className="min-w-48 max-w-md">
                {r.value}
                {r.current && (
                  <Badge variant="secondary" className="ml-2">
                    {t("current")}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="min-w-40 max-w-sm text-muted-foreground text-xs">{r.source}</TableCell>
              <TableCell className="whitespace-nowrap">
                {r.origin === "code" ? t("originCode") : t("originOverride")}
                {r.overrideId && locked.get(r.overrideId) && <span className="sr-only"> ({t("locked")})</span>}
              </TableCell>
            </TableRow>
          )),
        )}
      </TableBody>
    </Table>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{RULE_GROUP_LABEL_DE[group]}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {group === "other" || group === "noteText" ? (
          <details>
            <summary className="cursor-pointer text-sm underline">{t("showTables", { count: tables.length })}</summary>
            <div className="mt-3">{body}</div>
          </details>
        ) : (
          body
        )}
      </CardContent>
    </Card>
  );
}

const defaults: RuleOverrideFormValues = {
  ruleSet: "basiszinssatz",
  tableId: "basiszinssatz",
  validFrom: "",
  validTo: "",
  rate: "",
  de: "",
  en: "",
  source: "",
};

function AddOverrideDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("settings.rules");
  const tCommon = useTranslations("common");
  const formId = useId();
  const deId = useId();
  const enId = useId();
  const add = useMutation(api.settings.addRuleOverride);
  const showError = useAdapterErrorToast();
  const form = useZodForm(ruleOverrideSchema, defaults) as OverrideForm;
  const ruleSet = useWatch({ control: form.control, name: "ruleSet" }) ?? "basiszinssatz";
  const tableIds = overrideTableIds(ruleSet);
  useEffect(() => {
    const current = form.getValues("tableId");
    if (!tableIds.includes(current)) form.setValue("tableId", tableIds[0] ?? "");
  }, [form, tableIds]);
  const submit = form.handleSubmit(async (values) => {
    try {
      const r = await add({ values });
      for (const w of r.warnings) toast.warning(w);
      toast.success(t("added"));
      onClose();
    } catch (e) {
      showError(e);
    }
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("addTitle")}</DialogTitle>
          <DialogDescription>{t("addDescription")}</DialogDescription>
        </DialogHeader>
        <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
          <FormErrorSummary form={form} />
          <SelectField
            form={form}
            name="ruleSet"
            label={t("ruleSet")}
            options={OVERRIDE_RULE_SETS.map((r) => ({ value: r, label: OVERRIDE_RULE_SET_LABEL_DE[r] }))}
          />
          <SelectField
            form={form}
            name="tableId"
            label={t("table")}
            required
            options={tableIds.map((id) => ({ value: id, label: id }))}
          />
          <TextField form={form} name="validFrom" label={t("validFrom")} type="date" required />
          <TextField form={form} name="validTo" label={t("validTo")} type="date" />
          {ruleSet === "noteText" ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor={deId}>{t("textDe")}</Label>
                <Textarea id={deId} rows={3} {...form.register("de")} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={enId}>{t("textEn")}</Label>
                <Textarea id={enId} rows={3} {...form.register("en")} />
              </div>
            </>
          ) : (
            <TextField form={form} name="rate" label={t("rate")} inputMode="decimal" required />
          )}
          <TextField form={form} name="source" label={t("sourceField")} required description={t("sourceHint")} />
        </form>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" form={formId} className="h-11 md:h-9" disabled={form.formState.isSubmitting}>
            {t("add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteOverrideDialog({ target, onClose }: { target: { id: string; label: string }; onClose: () => void }) {
  const t = useTranslations("settings.rules");
  const remove = useMutation(api.settings.deleteRuleOverride);
  const showError = useAdapterErrorToast();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  return (
    <ConfirmDialog
      title={t("deleteTitle", { label: target.label })}
      description={t("deleteDescription")}
      confirmLabel={t("delete")}
      destructive
      confirmDisabled={reason.trim().length < 5}
      onClose={onClose}
      onConfirm={async () => {
        try {
          await remove({ id: target.id as Id<"ruleOverrides">, reason });
          toast.success(t("deleted"));
          onClose();
        } catch (e) {
          showError(e);
        }
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={reasonId}>{t("reason")}</Label>
        <Textarea id={reasonId} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}
