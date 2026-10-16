"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArchiveIcon, CopyIcon, PencilIcon, PlusIcon, ScaleIcon, StarIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, selectClass, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { money } from "@/components/invoices/invoice-shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCents } from "@/domain/money/format";
import { parseCents } from "@/domain/money/parse";
import {
  type DunningSettingsValues,
  dunningSettingsSchema,
  type PolicyValues,
  policySchema,
} from "@/domain/schemas/dunning";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { SectionCard } from "./dunning-shared";

type Settings = FunctionReturnType<typeof api.dunning.settings>;
type Policy = Settings["policies"][number];
type Template = Settings["textTemplates"][number];

/** Einstellungen › Mahnwesen (F05 §6.6, DUN-001): global switches and the policy editor. Writes need `dunning.manage`. */
export function DunningSettings() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <DunningSettingsInner />
    </ConvexGuard>
  );
}

function DunningSettingsInner() {
  const t = useTranslations("dunning.settings");
  const data = useAuthedQuery(api.dunning.settings, {});
  const canManage = useCan("dunning.manage");
  if (data === undefined) return <div className="h-96" aria-busy="true" />;
  return (
    <div className="@container/settings flex flex-col gap-6" data-testid="dunning-settings">
      {!canManage && (
        <p role="status" className="rounded-md border p-3 text-muted-foreground text-sm">
          {t("readOnly")}
        </p>
      )}
      <Policies data={data} canManage={canManage} />
      {data.receivables ? (
        <GlobalSwitches key={JSON.stringify(data.receivables)} initial={data.receivables} canManage={canManage} />
      ) : (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
          {t("setupMissing")}
        </p>
      )}
    </div>
  );
}

// ── global switches ─────────────────────────────────────────────────────────────────────────────────────────────

type Receivables = NonNullable<Settings["receivables"]>;

/** „30, 60, 90“ → [30, 60, 90] (ascending, unique); null when a value is not a whole number. */
export function parseBucketEdges(text: string): number[] | null {
  const parts = text
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
  if (nums.some((n) => !Number.isInteger(n))) return null;
  return [...new Set(nums)].sort((a, b) => a - b);
}

function GlobalSwitches({ initial, canManage }: { initial: Receivables; canManage: boolean }) {
  const t = useTranslations("dunning.settings.global");
  const run = useRun();
  const save = useMutation(api.dunning.saveSettings);
  const [form, setForm] = useState({
    autoCreateReminders: initial.autoCreateReminders !== false,
    autoFinalizeReminders: initial.autoFinalizeReminders,
    postalDeliveryDays: String(initial.postalDeliveryDays),
    bankDataMaxAgeDays: String(initial.bankDataMaxAgeDays),
    defaultStartViaReminder: initial.defaultStartViaReminder,
    reopenGraceDays: String(initial.reopenGraceDays),
    agingBucketEdgesDays: initial.agingBucketEdgesDays.join(", "),
  });
  const [error, setError] = useState<string | null>(null);
  const ids = { postal: useId(), bank: useId(), grace: useId(), buckets: useId(), route: useId(), routeHint: useId() };
  const patch = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const submit = async () => {
    const values: DunningSettingsValues | null = (() => {
      const edges = parseBucketEdges(form.agingBucketEdgesDays);
      const parsed = dunningSettingsSchema.safeParse({
        autoCreateReminders: form.autoCreateReminders,
        autoFinalizeReminders: form.autoFinalizeReminders,
        postalDeliveryDays: Number(form.postalDeliveryDays),
        bankDataMaxAgeDays: Number(form.bankDataMaxAgeDays),
        defaultStartViaReminder: form.defaultStartViaReminder,
        reopenGraceDays: Number(form.reopenGraceDays),
        agingBucketEdgesDays: edges ?? [],
      });
      return parsed.success ? parsed.data : null;
    })();
    if (!values) {
      setError(t("invalid"));
      return;
    }
    setError(null);
    await run(() => save({ values }), t("saved"));
  };
  const numberField = (id: string, key: "postalDeliveryDays" | "bankDataMaxAgeDays" | "reopenGraceDays") => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-sm">
        {t(key)}
      </label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        value={form[key]}
        disabled={!canManage}
        onChange={(e) => patch({ [key]: e.target.value })}
        className="h-11 md:h-9"
      />
      <p className="text-muted-foreground text-xs">{t(`${key}Hint`)}</p>
    </div>
  );
  return (
    <SectionCard title={t("title")} testId="dunning-global">
      <label className="flex min-h-11 items-start gap-2 text-sm md:min-h-9">
        <input
          type="checkbox"
          className="mt-0.5 size-5 accent-primary md:size-4"
          checked={form.autoCreateReminders}
          disabled={!canManage}
          onChange={(e) => patch({ autoCreateReminders: e.target.checked })}
        />
        <span className="flex flex-col">
          <span className="font-medium">{t("autoCreate")}</span>
          <span className="text-muted-foreground text-xs">{t("autoCreateHint")}</span>
        </span>
      </label>
      <label className="flex min-h-11 items-start gap-2 text-sm md:min-h-9">
        <input
          type="checkbox"
          className="mt-0.5 size-5 accent-primary md:size-4"
          checked={form.autoFinalizeReminders}
          disabled={!canManage}
          onChange={(e) => patch({ autoFinalizeReminders: e.target.checked })}
        />
        <span className="flex flex-col">
          <span className="font-medium">{t("autoFinalize")}</span>
          <span className="text-muted-foreground text-xs">{t("autoFinalizeHint")}</span>
        </span>
      </label>
      <div className="grid gap-4 @2xl/settings:grid-cols-3">
        {numberField(ids.postal, "postalDeliveryDays")}
        {numberField(ids.bank, "bankDataMaxAgeDays")}
        {numberField(ids.grace, "reopenGraceDays")}
      </div>
      <fieldset className="flex flex-col gap-1" aria-describedby={ids.routeHint}>
        <legend className="mb-1 flex items-center gap-1.5 font-medium text-sm">
          <ScaleIcon className="size-4" aria-hidden="true" />
          {t("defaultStart")}
        </legend>
        {(["after_printed_deadline", "zugang_plus_1"] as const).map((v) => (
          <label key={v} className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
            <input
              type="radio"
              name={ids.route}
              className="size-5 accent-primary md:size-4"
              checked={form.defaultStartViaReminder === v}
              disabled={!canManage}
              onChange={() => patch({ defaultStartViaReminder: v })}
            />
            {t(`defaultStartOptions.${v}`)}
          </label>
        ))}
        <p id={ids.routeHint} className="rounded-md border border-info/30 bg-info/5 p-2 text-xs">
          {t("defaultStartHint")}
        </p>
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.buckets} className="font-medium text-sm">
          {t("buckets")}
        </label>
        <Input
          id={ids.buckets}
          value={form.agingBucketEdgesDays}
          disabled={!canManage}
          onChange={(e) => patch({ agingBucketEdgesDays: e.target.value })}
          className="h-11 md:h-9"
        />
        <p className="text-muted-foreground text-xs">{t("bucketsHint")}</p>
      </div>
      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}
      {canManage && (
        <Button className="h-11 self-start md:h-9" onClick={() => void submit()}>
          {t("save")}
        </Button>
      )}
    </SectionCard>
  );
}

// ── policies (DUN-001) ──────────────────────────────────────────────────────────────────────────────────────────

const toValues = (p: Policy): PolicyValues => ({
  name: p.name,
  isDefault: p.isDefault,
  appliesTo: { consumer: p.appliesTo.consumer, business: p.appliesTo.business },
  steps: p.steps.map((s) => ({
    level: s.level,
    daysAfter: s.daysAfter,
    title: s.title,
    feeCents: s.feeCents,
    addInterest: s.addInterest,
    addFlatFee40: s.addFlatFee40,
    newDueDays: s.newDueDays,
    ...(s.textTemplateId ? { textTemplateId: s.textTemplateId } : {}),
    autoFinalize: s.autoFinalize,
  })),
  ...(p.dueSoonDays !== undefined ? { dueSoonDays: p.dueSoonDays } : {}),
  dueSoonTodo: p.dueSoonTodo,
  minOpenAmountCents: p.minOpenAmountCents,
  pauseOnPartialPaymentDays: p.pauseOnPartialPaymentDays,
  stopAfterLastLevel: p.stopAfterLastLevel,
});

const EMPTY_POLICY: PolicyValues = {
  name: "",
  isDefault: false,
  appliesTo: { consumer: false, business: true },
  steps: [
    {
      level: 1,
      daysAfter: 7,
      title: "Zahlungserinnerung",
      feeCents: 0,
      addInterest: false,
      addFlatFee40: false,
      newDueDays: 7,
      autoFinalize: false,
    },
  ],
  dueSoonDays: 3,
  dueSoonTodo: false,
  minOpenAmountCents: 500,
  pauseOnPartialPaymentDays: 14,
  stopAfterLastLevel: true,
};

type Editing = { mode: "new"; initial: PolicyValues } | { mode: "edit"; policy: Policy };

function Policies({ data, canManage }: { data: Settings; canManage: boolean }) {
  const t = useTranslations("dunning.settings.policies");
  const run = useRun();
  const update = useMutation(api.dunning.updatePolicy);
  const archive = useMutation(api.dunning.archive);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Policy | null>(null);
  const seeded = data.policies.some((p) => p.seeded);
  return (
    <SectionCard
      title={t("title")}
      testId="dunning-policies"
      actions={
        canManage ? (
          <Button
            variant="outline"
            className="h-11 md:h-9"
            onClick={() => setEditing({ mode: "new", initial: EMPTY_POLICY })}
          >
            <PlusIcon aria-hidden="true" />
            {t("new")}
          </Button>
        ) : undefined
      }
    >
      {seeded && <p className="text-muted-foreground text-sm">{t("seededHint")}</p>}
      <ul className="grid gap-3 @3xl/settings:grid-cols-2">
        {data.policies.map((p) => (
          <li key={p.id} className="flex flex-col gap-2 rounded-lg border p-3" data-policy={p.name}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.name}</span>
              {p.isDefault && <Badge>{t("default")}</Badge>}
              {p.appliesTo.business && <Badge variant="outline">{t("b2b")}</Badge>}
              {p.appliesTo.consumer && <Badge variant="outline">{t("b2c")}</Badge>}
              {p.seeded && <Badge variant="secondary">{t("seeded")}</Badge>}
            </div>
            <StepsTimeline steps={p.steps} />
            <p className="text-muted-foreground text-xs">
              {t("summary", {
                min: money(p.minOpenAmountCents),
                pause: p.pauseOnPartialPaymentDays,
                dueSoon: p.dueSoonDays ?? 3,
              })}
            </p>
            {p.warnings.length > 0 && <Findings findings={p.warnings} />}
            {canManage && (
              <div className="flex flex-wrap gap-2">
                {p.seeded ? (
                  <>
                    {/* DUN-001: editing a virtual default (seed:<n>) stores the defaults first. */}
                    <Button
                      variant="outline"
                      className="h-11 md:h-8"
                      onClick={() => setEditing({ mode: "edit", policy: p })}
                    >
                      <PencilIcon aria-hidden="true" />
                      {t("edit")}
                    </Button>
                    <Button
                      variant="outline"
                      className="h-11 md:h-8"
                      onClick={() =>
                        setEditing({
                          mode: "new",
                          initial: { ...toValues(p), name: t("copyName", { name: p.name }), isDefault: false },
                        })
                      }
                    >
                      <CopyIcon aria-hidden="true" />
                      {t("copy")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      className="h-11 md:h-8"
                      onClick={() => setEditing({ mode: "edit", policy: p })}
                    >
                      <PencilIcon aria-hidden="true" />
                      {t("edit")}
                    </Button>
                    {!p.isDefault && (
                      <Button
                        variant="outline"
                        className="h-11 md:h-8"
                        onClick={() =>
                          void run(
                            () =>
                              update({
                                id: p.id as Id<"dunningPolicies">,
                                version: p.version,
                                values: { ...toValues(p), isDefault: true },
                              }),
                            t("madeDefault", { name: p.name }),
                          )
                        }
                      >
                        <StarIcon aria-hidden="true" />
                        {t("makeDefault")}
                      </Button>
                    )}
                    {!p.isDefault && (
                      <Button variant="ghost" className="h-11 md:h-8" onClick={() => setArchiveTarget(p)}>
                        <ArchiveIcon aria-hidden="true" />
                        {t("archive")}
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <PolicyEditor
          key={editing.mode === "edit" ? editing.policy.id : "new"}
          editing={editing}
          templates={data.textTemplates}
          onClose={() => setEditing(null)}
        />
      )}
      {archiveTarget && (
        <ConfirmDialog
          title={t("archiveTitle", { name: archiveTarget.name })}
          description={t("archiveDescription")}
          confirmLabel={t("archive")}
          destructive
          onClose={() => setArchiveTarget(null)}
          onConfirm={async () => {
            const r = await run(() => archive({ id: archiveTarget.id as Id<"dunningPolicies"> }), t("archived"));
            if (r.ok) setArchiveTarget(null);
          }}
        />
      )}
    </SectionCard>
  );
}

/** Timeline of the steps relative to the due date (level 1) and the previous reminder's Zugang (DUN-054). */
function StepsTimeline({ steps }: { steps: readonly Policy["steps"][number][] }) {
  const t = useTranslations("dunning.settings.policies");
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label={t("timeline")}>
      <li className="rounded-md bg-muted px-2 py-1">{t("due")}</li>
      {steps.map((s) => (
        <li key={s.level} className="flex items-center gap-1">
          <span aria-hidden="true">→</span>
          <span className="rounded-md border px-2 py-1">
            {s.level === 1 ? t("afterDue", { days: s.daysAfter }) : t("afterZugang", { days: s.daysAfter })}: {s.title}
            {s.feeCents > 0 ? ` · ${money(s.feeCents)}` : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Findings({ findings }: { findings: readonly { code: string; severity: string; message: string }[] }) {
  return (
    <ul className="flex flex-col gap-1" data-testid="policy-warnings">
      {findings.map((f) => (
        <li
          key={`${f.code}-${f.message}`}
          data-code={f.code}
          className={cn(
            "rounded-md border p-2 text-xs",
            f.severity === "E" ? "border-danger/40 bg-danger/5" : "border-warning/40 bg-warning/5",
          )}
        >
          {f.message}
        </li>
      ))}
    </ul>
  );
}

interface StepForm {
  key: number;
  daysAfter: string;
  title: string;
  fee: string;
  addInterest: boolean;
  addFlatFee40: boolean;
  newDueDays: string;
  textTemplateId: string;
  autoFinalize: boolean;
}

const stepForm = (s: PolicyValues["steps"][number], key: number): StepForm => ({
  key,
  daysAfter: String(s.daysAfter),
  title: s.title,
  fee: formatCents(s.feeCents),
  addInterest: s.addInterest,
  addFlatFee40: s.addFlatFee40,
  newDueDays: String(s.newDueDays),
  textTemplateId: s.textTemplateId ?? "",
  autoFinalize: s.autoFinalize,
});

/** The editor form → `policySchema` values (levels follow the order of the steps). */
export function policyValuesOf(form: {
  name: string;
  isDefault: boolean;
  consumer: boolean;
  business: boolean;
  dueSoonDays: string;
  dueSoonTodo: boolean;
  minOpen: string;
  pauseDays: string;
  stopAfterLastLevel: boolean;
  steps: readonly StepForm[];
}): { ok: true; values: PolicyValues } | { ok: false; message: string } {
  const minOpen = parseCents(form.minOpen || "0");
  const steps = form.steps.map((s, i) => {
    const fee = parseCents(s.fee || "0");
    return {
      level: i + 1,
      daysAfter: Number(s.daysAfter),
      title: s.title,
      feeCents: fee.ok ? fee.value : Number.NaN,
      addInterest: s.addInterest,
      addFlatFee40: form.consumer && !form.business ? false : s.addFlatFee40,
      newDueDays: Number(s.newDueDays),
      ...(s.textTemplateId ? { textTemplateId: s.textTemplateId } : {}),
      autoFinalize: s.autoFinalize,
    };
  });
  const parsed = policySchema.safeParse({
    name: form.name,
    isDefault: form.isDefault,
    appliesTo: { consumer: form.consumer, business: form.business },
    steps,
    ...(form.dueSoonDays.trim() ? { dueSoonDays: Number(form.dueSoonDays) } : {}),
    dueSoonTodo: form.dueSoonTodo,
    minOpenAmountCents: minOpen.ok ? minOpen.value : Number.NaN,
    pauseOnPartialPaymentDays: Number(form.pauseDays),
    stopAfterLastLevel: form.stopAfterLastLevel,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: issue?.message ?? "" };
  }
  return { ok: true, values: parsed.data };
}

function PolicyEditor({
  editing,
  templates,
  onClose,
}: {
  editing: Editing;
  templates: readonly Template[];
  onClose: () => void;
}) {
  const t = useTranslations("dunning.settings.editor");
  const run = useRun();
  const create = useMutation(api.dunning.createPolicy);
  const update = useMutation(api.dunning.updatePolicy);
  const start = editing.mode === "edit" ? toValues(editing.policy) : editing.initial;
  const serverWarnings = editing.mode === "edit" ? editing.policy.warnings : [];
  const [form, setForm] = useState({
    name: start.name,
    isDefault: start.isDefault,
    consumer: start.appliesTo.consumer,
    business: start.appliesTo.business,
    dueSoonDays: start.dueSoonDays !== undefined ? String(start.dueSoonDays) : "",
    dueSoonTodo: start.dueSoonTodo,
    minOpen: formatCents(start.minOpenAmountCents),
    pauseDays: String(start.pauseOnPartialPaymentDays),
    stopAfterLastLevel: start.stopAfterLastLevel,
    steps: start.steps.map((s, i) => stepForm(s, i)),
  });
  const [error, setError] = useState<string | null>(null);
  const [nextKey, setNextKey] = useState(start.steps.length);
  const headingId = useId();
  const ids = { name: useId(), dueSoon: useId(), minOpen: useId(), pause: useId() };
  const patch = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const patchStep = (key: number, p: Partial<StepForm>) =>
    setForm((f) => ({ ...f, steps: f.steps.map((s) => (s.key === key ? { ...s, ...p } : s)) }));
  const consumerOnly = form.consumer && !form.business;
  const headTemplates = templates.filter((tpl) => tpl.kind === "document_head");

  const submit = async () => {
    const built = policyValuesOf(form);
    if (!built.ok) {
      setError(built.message || t("invalid"));
      return;
    }
    setError(null);
    const r = await run(
      () =>
        editing.mode === "edit"
          ? update({
              id: editing.policy.id as Id<"dunningPolicies">,
              version: editing.policy.version,
              values: built.values,
            })
          : create({ values: built.values }),
      t("saved"),
    );
    if (r.ok) {
      for (const w of r.value.warnings) toast.warning(w.message);
      onClose();
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-xl border-2 border-primary/30 p-4"
      data-testid="policy-editor"
    >
      <h3 id={headingId} className="font-semibold text-base">
        {editing.mode === "edit" ? t("editTitle", { name: editing.policy.name }) : t("newTitle")}
      </h3>
      {serverWarnings.length > 0 && <Findings findings={serverWarnings} />}
      <div className="grid gap-4 @2xl/settings:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.name} className="font-medium text-sm">
            {t("name")}
          </label>
          <Input
            id={ids.name}
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            className="h-11 md:h-9"
          />
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-medium text-sm">{t("appliesTo")}</legend>
          <div className="flex flex-wrap gap-4">
            {(["business", "consumer"] as const).map((k) => (
              <label key={k} className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
                <input
                  type="checkbox"
                  className="size-5 accent-primary md:size-4"
                  checked={form[k]}
                  onChange={(e) => patch({ [k]: e.target.checked })}
                />
                {t(k)}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
          <input
            type="checkbox"
            className="size-5 accent-primary md:size-4"
            checked={form.isDefault}
            onChange={(e) => patch({ isDefault: e.target.checked })}
          />
          {t("isDefault")}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
          <input
            type="checkbox"
            className="size-5 accent-primary md:size-4"
            checked={form.stopAfterLastLevel}
            onChange={(e) => patch({ stopAfterLastLevel: e.target.checked })}
          />
          {t("stopAfterLastLevel")}
        </label>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.minOpen} className="font-medium text-sm">
            {t("minOpen")}
          </label>
          <Input
            id={ids.minOpen}
            inputMode="decimal"
            value={form.minOpen}
            onChange={(e) => patch({ minOpen: e.target.value })}
            className="h-11 md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.pause} className="font-medium text-sm">
            {t("pauseDays")}
          </label>
          <Input
            id={ids.pause}
            type="number"
            min={0}
            value={form.pauseDays}
            onChange={(e) => patch({ pauseDays: e.target.value })}
            className="h-11 md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.dueSoon} className="font-medium text-sm">
            {t("dueSoonDays")}
          </label>
          <Input
            id={ids.dueSoon}
            type="number"
            min={0}
            value={form.dueSoonDays}
            onChange={(e) => patch({ dueSoonDays: e.target.value })}
            className="h-11 md:h-9"
          />
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
          <input
            type="checkbox"
            className="size-5 accent-primary md:size-4"
            checked={form.dueSoonTodo}
            onChange={(e) => patch({ dueSoonTodo: e.target.checked })}
          />
          {t("dueSoonTodo")}
        </label>
      </div>

      <ol className="flex flex-col gap-3" aria-label={t("steps")}>
        {form.steps.map((s, i) => (
          <StepCard
            key={s.key}
            step={s}
            index={i}
            consumerOnly={consumerOnly}
            templates={headTemplates}
            warnings={serverWarnings.filter((w) => w.field?.startsWith(`steps.${i}`))}
            onChange={(p) => patchStep(s.key, p)}
            onRemove={
              form.steps.length > 1
                ? () => setForm((f) => ({ ...f, steps: f.steps.filter((x) => x.key !== s.key) }))
                : undefined
            }
          />
        ))}
      </ol>
      <Button
        variant="outline"
        className="h-11 self-start md:h-9"
        onClick={() => {
          const last = form.steps.at(-1);
          setForm((f) => ({
            ...f,
            steps: [
              ...f.steps,
              {
                key: nextKey,
                daysAfter: "14",
                title: t("newStepTitle", { level: f.steps.length + 1 }),
                fee: "0,00",
                addInterest: true,
                addFlatFee40: false,
                newDueDays: last?.newDueDays ?? "7",
                textTemplateId: "",
                autoFinalize: false,
              },
            ],
          }));
          setNextKey((k) => k + 1);
        }}
      >
        <PlusIcon aria-hidden="true" />
        {t("addStep")}
      </Button>
      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button className="h-11 md:h-9" onClick={() => void submit()}>
          {t("save")}
        </Button>
        <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
          {t("cancel")}
        </Button>
      </div>
    </section>
  );
}

function StepCard({
  step,
  index,
  consumerOnly,
  templates,
  warnings,
  onChange,
  onRemove,
}: {
  step: StepForm;
  index: number;
  consumerOnly: boolean;
  templates: readonly Template[];
  warnings: readonly { code: string; severity: string; message: string }[];
  onChange: (p: Partial<StepForm>) => void;
  onRemove?: () => void;
}) {
  const t = useTranslations("dunning.settings.step");
  const ids = { days: useId(), title: useId(), fee: useId(), due: useId(), tpl: useId() };
  const level = index + 1;
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3" data-step={level}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-medium text-sm">{t("title", { level })}</h4>
        {onRemove && (
          <Button
            variant="ghost"
            size="icon"
            className="size-11 md:size-8"
            aria-label={t("remove", { level })}
            onClick={onRemove}
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="grid gap-3 @2xl/settings:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.title} className="font-medium text-sm">
            {t("label")}
          </label>
          <Input
            id={ids.title}
            value={step.title}
            onChange={(e) => onChange({ title: e.target.value })}
            className="h-11 md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.days} className="font-medium text-sm">
            {level === 1 ? t("daysAfterDue") : t("daysAfterZugang")}
          </label>
          <Input
            id={ids.days}
            type="number"
            min={0}
            value={step.daysAfter}
            onChange={(e) => onChange({ daysAfter: e.target.value })}
            className="h-11 md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.fee} className="font-medium text-sm">
            {t("fee")}
          </label>
          <Input
            id={ids.fee}
            inputMode="decimal"
            value={step.fee}
            onChange={(e) => onChange({ fee: e.target.value })}
            className="h-11 md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.due} className="font-medium text-sm">
            {t("newDueDays")}
          </label>
          <Input
            id={ids.due}
            type="number"
            min={1}
            value={step.newDueDays}
            onChange={(e) => onChange({ newDueDays: e.target.value })}
            className="h-11 md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.tpl} className="font-medium text-sm">
            {t("template")}
          </label>
          <select
            id={ids.tpl}
            className={selectClass}
            value={step.textTemplateId}
            onChange={(e) => onChange({ textTemplateId: e.target.value })}
          >
            <option value="">{t("templateDefault")}</option>
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name}
                {tpl.level ? ` (${t("templateLevel", { level: tpl.level })})` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
            <input
              type="checkbox"
              className="size-5 accent-primary md:size-4"
              checked={step.addInterest}
              onChange={(e) => onChange({ addInterest: e.target.checked })}
            />
            {t("addInterest")}
          </label>
          {!consumerOnly && (
            <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
              <input
                type="checkbox"
                className="size-5 accent-primary md:size-4"
                checked={step.addFlatFee40}
                onChange={(e) => onChange({ addFlatFee40: e.target.checked })}
              />
              {t("addFlatFee40")}
            </label>
          )}
          <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
            <input
              type="checkbox"
              className="size-5 accent-primary md:size-4"
              checked={step.autoFinalize}
              onChange={(e) => onChange({ autoFinalize: e.target.checked })}
            />
            {t("autoFinalize")}
          </label>
        </div>
      </div>
      {warnings.length > 0 && <Findings findings={warnings} />}
    </li>
  );
}
