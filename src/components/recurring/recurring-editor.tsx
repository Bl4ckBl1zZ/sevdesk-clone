"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useConvex, useMutation } from "convex/react";
import { PackageIcon, PlusIcon, TypeIcon } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, formatDate, selectClass, todayBerlin, useRun } from "@/components/catalog/shared";
import { type EditorLine, emptyLine, lineFromValues } from "@/components/invoices/editor-model";
import { LineEditor } from "@/components/invoices/invoice-editor";
import { money } from "@/components/invoices/invoice-shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  BILLING_LABELS_DE,
  BILLING_MODES,
  RECURRING_INTERVAL_LABELS_DE,
  RECURRING_INTERVALS,
} from "@/domain/recurring/schedule";
import type { DraftValues } from "@/domain/schemas/documents";
import type { RecurringTemplateValues } from "@/domain/schemas/recurring";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { emptyRecurringForm, type RecurringFormState, recurringFormFrom, toTemplateValues } from "./recurring-model";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

const BASE = "/rechnungen/wiederkehrend";

/**
 * Vorlagen-Editor (F04 §6.5): the invoice content (customer, positions, payment terms, texts) with the invoice
 * editor's line rows, plus „Zeitplan“ and „Automatik“; right pane „Nächste Termine“ (REC-13) computed by Convex for
 * the unsaved values. The first activation of „Fertigstellen“ asks for a confirmation (REC-14).
 */
export function RecurringEditor({
  id,
  initial,
  version,
  automationConfirmed = false,
  started = false,
  inlineActions = false,
}: {
  id?: Id<"recurringTemplates">;
  initial?: RecurringTemplateValues;
  version?: number;
  automationConfirmed?: boolean;
  /** An invoice was generated or a period skipped: the anchor (first date, interval, billing) is fixed. */
  started?: boolean;
  /**
   * The page header already owns the fixed phone action bar (template detail: „Jetzt erzeugen“, „Pausieren“ …), so the
   * save button sits below the form instead of a second fixed bar on top of it.
   */
  inlineActions?: boolean;
}) {
  const t = useTranslations("recurring.editor");
  const te = useTranslations("invoices.editor");
  const router = useRouter();
  const run = useRun();
  const convex = useConvex();
  const create = useMutation(api.recurring.create);
  const update = useMutation(api.recurring.update);
  const [form, setForm] = useState<RecurringFormState>(() =>
    initial ? recurringFormFrom(initial) : emptyRecurringForm(todayBerlin()),
  );
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [contactQuery, setContactQuery] = useState("");
  const appliedDefaults = useRef<string | null>(initial ? (initial.draft.contactId ?? "") : null);
  const editor = form.editor;

  const contacts = useAuthedQuery(api.contacts.options, contactQuery ? { q: contactQuery } : {}) ?? [];
  const products = useAuthedQuery(api.products.options, {}) ?? [];
  const units = useAuthedQuery(api.lookups.listUnits, {}) ?? [];
  const defaults = useAuthedQuery(
    api.invoices.draftDefaults,
    editor.contactId ? { contactId: editor.contactId as Id<"contacts"> } : {},
  );

  const set = (patch: Partial<RecurringFormState>) => setForm((f) => ({ ...f, ...patch }));
  const setEditor = (patch: Partial<RecurringFormState["editor"]>) =>
    setForm((f) => ({ ...f, editor: { ...f.editor, ...patch } }));
  const setLine = (key: string, patch: Partial<EditorLine>) =>
    setEditor({ lines: editor.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });

  // DOC-08: defaults of the chosen customer (price mode, terms, bank account).
  useEffect(() => {
    if (!defaults || appliedDefaults.current === editor.contactId) return;
    appliedDefaults.current = editor.contactId;
    setForm((f) => ({
      ...f,
      editor: {
        ...f.editor,
        priceMode: defaults.priceMode,
        language: defaults.language,
        currency: defaults.currency,
        dueDays: String(defaults.paymentTerms.dueDays),
        bankAccountId: defaults.bankAccountId ?? "",
        paymentMethodId: defaults.paymentMethodId ?? "",
        buyerReference: f.editor.buyerReference || (defaults.buyerReference ?? ""),
      },
    }));
  }, [defaults, editor.contactId]);

  const { values, errors } = useMemo(() => toTemplateValues(form), [form]);
  const debounced = useDebounced(values, 300);
  const preview = useAuthedQuery(api.recurring.occurrences, { values: debounced, ...(id ? { id } : {}) });

  const save = async (confirmAutomation: boolean) => {
    if (errors.length > 0) {
      toast.error(errors[0]?.message ?? t("inputInvalid"));
      return;
    }
    setSaving(true);
    try {
      if (!id) {
        const r = await run(() => create({ values, confirmAutomation }), t("saved"));
        if (r.ok) router.replace(`${BASE}/${r.value.id}` as Route);
        return;
      }
      await run(() => update({ id, version: version ?? 1, values, confirmAutomation }), t("saved"));
    } finally {
      setSaving(false);
      setConfirm(false);
    }
  };
  const onSave = () => {
    if (form.finalize && !automationConfirmed) setConfirm(true);
    else void save(false);
  };

  const addProduct = async (productId: string) => {
    if (!productId) return;
    const r = await run(() =>
      convex.query(api.invoices.productLine, {
        productId: productId as Id<"products">,
        ...(editor.contactId ? { contactId: editor.contactId as Id<"contacts"> } : {}),
        referenceDate: form.firstDate || todayBerlin(),
        priceMode: editor.priceMode,
        currency: editor.currency,
      }),
    );
    if (!r.ok) return;
    for (const w of r.value.warnings) toast.warning(w);
    const line = lineFromValues(r.value.line as DraftValues["lines"][number]);
    setEditor({ lines: editor.lines.length === 1 && !editor.lines[0]?.name ? [line] : [...editor.lines, line] });
  };
  const move = (i: number, d: -1 | 1) => {
    const lines = [...editor.lines];
    const [x] = lines.splice(i, 1);
    if (x) lines.splice(i + d, 0, x);
    setEditor({ lines });
  };

  const ids = {
    name: useId(),
    contract: useId(),
    contactSearch: useId(),
    contact: useId(),
    firstDate: useId(),
    interval: useId(),
    billing: useId(),
    end: useId(),
    endDate: useId(),
    maxCount: useId(),
    priceMode: useId(),
    product: useId(),
    dueDays: useId(),
    subject: useId(),
    head: useId(),
    foot: useId(),
    buyerRef: useId(),
  };
  const next = preview?.[0];

  return (
    <div className="flex flex-col gap-4 pb-28 md:pb-0">
      {id && <p className="rounded-lg border border-dashed p-3 text-muted-foreground text-sm">{t("editNotice")}</p>}
      <div className="@container/editor">
        <div className="grid grid-cols-1 gap-4 @4xl/editor:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <section
              aria-label={t("sections.template")}
              className="grid grid-cols-1 gap-4 rounded-xl border p-4 @lg/editor:grid-cols-2"
            >
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.name} className="font-medium text-sm">
                  {t("name")}
                </label>
                <Input
                  id={ids.name}
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.contract} className="font-medium text-sm">
                  {t("contractReference")}
                </label>
                <Input
                  id={ids.contract}
                  value={form.contractReference}
                  onChange={(e) => set({ contractReference: e.target.value })}
                  className="h-11 md:h-9"
                  aria-describedby={`${ids.contract}-hint`}
                />
                <span id={`${ids.contract}-hint`} className="text-muted-foreground text-xs">
                  {t("contractReferenceHint")}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.contactSearch} className="font-medium text-sm">
                  {te("contactSearch")}
                </label>
                <Input
                  id={ids.contactSearch}
                  value={contactQuery}
                  placeholder={te("contactSearchPlaceholder")}
                  onChange={(e) => setContactQuery(e.target.value)}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.contact} className="font-medium text-sm">
                  {te("contact")}
                </label>
                <select
                  id={ids.contact}
                  className={selectClass}
                  value={editor.contactId}
                  onChange={(e) => setEditor({ contactId: e.target.value })}
                >
                  <option value="">{te("contactNone")}</option>
                  {editor.contactId && !contacts.some((c) => c._id === editor.contactId) && (
                    <option value={editor.contactId}>{te("contactSelected")}</option>
                  )}
                  {contacts.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.displayName} ({c.number})
                    </option>
                  ))}
                </select>
              </div>
            </section>

            <section
              aria-label={t("sections.schedule")}
              className="grid grid-cols-1 gap-4 rounded-xl border p-4 @lg/editor:grid-cols-3"
            >
              <h2 className="font-semibold text-base @lg/editor:col-span-3">{t("sections.schedule")}</h2>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.firstDate} className="font-medium text-sm">
                  {t("firstDate")}
                </label>
                <Input
                  id={ids.firstDate}
                  type="date"
                  value={form.firstDate}
                  disabled={started}
                  onChange={(e) => set({ firstDate: e.target.value })}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.interval} className="font-medium text-sm">
                  {t("interval")}
                </label>
                <select
                  id={ids.interval}
                  className={selectClass}
                  value={form.interval}
                  disabled={started}
                  onChange={(e) => set({ interval: e.target.value as RecurringFormState["interval"] })}
                >
                  {RECURRING_INTERVALS.map((i) => (
                    <option key={i} value={i}>
                      {RECURRING_INTERVAL_LABELS_DE[i]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.billing} className="font-medium text-sm">
                  {t("billing")}
                </label>
                <select
                  id={ids.billing}
                  className={selectClass}
                  value={form.billing}
                  disabled={started}
                  onChange={(e) => set({ billing: e.target.value as RecurringFormState["billing"] })}
                  aria-describedby={`${ids.billing}-hint`}
                >
                  {BILLING_MODES.map((b) => (
                    <option key={b} value={b}>
                      {BILLING_LABELS_DE[b]}
                    </option>
                  ))}
                </select>
              </div>
              <p id={`${ids.billing}-hint`} className="text-muted-foreground text-xs @lg/editor:col-span-3">
                {started ? t("scheduleLocked") : t("billingHint")}
              </p>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.end} className="font-medium text-sm">
                  {t("end")}
                </label>
                <select
                  id={ids.end}
                  className={selectClass}
                  value={form.endMode}
                  onChange={(e) => set({ endMode: e.target.value as RecurringFormState["endMode"] })}
                >
                  <option value="never">{t("endNever")}</option>
                  <option value="date">{t("endDate")}</option>
                  <option value="count">{t("endCount")}</option>
                </select>
              </div>
              {form.endMode === "date" && (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={ids.endDate} className="font-medium text-sm">
                    {t("endDateLabel")}
                  </label>
                  <Input
                    id={ids.endDate}
                    type="date"
                    value={form.endDate}
                    onChange={(e) => set({ endDate: e.target.value })}
                    className="h-11 md:h-9"
                  />
                </div>
              )}
              {form.endMode === "count" && (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={ids.maxCount} className="font-medium text-sm">
                    {t("maxCount")}
                  </label>
                  <Input
                    id={ids.maxCount}
                    inputMode="numeric"
                    value={form.maxCount}
                    onChange={(e) => set({ maxCount: e.target.value })}
                    className="h-11 md:h-9"
                  />
                </div>
              )}
              <label className="flex min-h-11 items-center gap-2 text-sm @lg/editor:col-span-3 md:min-h-9">
                <input
                  type="checkbox"
                  className="size-5 accent-primary md:size-4"
                  checked={form.periodText}
                  onChange={(e) => set({ periodText: e.target.checked })}
                />
                {t("periodText")}
                <span className="text-muted-foreground text-xs">
                  {t("periodTextHint", { placeholder: "{{recurring.periodText}}" })}
                </span>
              </label>
            </section>

            <section aria-label={te("sections.lines")} className="flex flex-col gap-3 rounded-xl border p-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <h2 className="font-semibold text-base">{te("sections.lines")}</h2>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={ids.priceMode} className="font-medium text-sm">
                    {te("priceMode")}
                  </label>
                  <select
                    id={ids.priceMode}
                    className={selectClass}
                    value={editor.priceMode}
                    onChange={(e) => setEditor({ priceMode: e.target.value as "net" | "gross" })}
                  >
                    <option value="net">{te("net")}</option>
                    <option value="gross">{te("gross")}</option>
                  </select>
                </div>
              </div>
              <ol className="flex flex-col gap-3">
                {editor.lines.map((l, i) => (
                  <LineEditor
                    key={l.key}
                    line={l}
                    index={i}
                    count={editor.lines.length}
                    units={units.filter((u) => !u.archivedAt).map((u) => ({ code: u.code, label: u.labelDe }))}
                    optionalAllowed={false}
                    currency={editor.currency}
                    onChange={(patch) => setLine(l.key, patch)}
                    onRemove={() => setEditor({ lines: editor.lines.filter((x) => x.key !== l.key) })}
                    onMove={(d) => move(i, d)}
                  />
                ))}
              </ol>
              <div className="flex flex-wrap items-end gap-2">
                <Button
                  variant="outline"
                  className="h-11 md:h-9"
                  onClick={() => setEditor({ lines: [...editor.lines, emptyLine()] })}
                >
                  <PlusIcon aria-hidden="true" />
                  {te("addLine")}
                </Button>
                <Button
                  variant="outline"
                  className="h-11 md:h-9"
                  onClick={() => setEditor({ lines: [...editor.lines, emptyLine("text")] })}
                >
                  <TypeIcon aria-hidden="true" />
                  {te("addText")}
                </Button>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={ids.product} className="font-medium text-sm">
                    <PackageIcon className="mr-1 inline size-4" aria-hidden="true" />
                    {te("addProduct")}
                  </label>
                  <select
                    id={ids.product}
                    className={selectClass}
                    value=""
                    onChange={(e) => void addProduct(e.target.value)}
                  >
                    <option value="">{te("chooseProduct")}</option>
                    {products.map((p) => (
                      <option key={p._id} value={p._id}>
                        {p.name} ({p.number})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </section>

            <section
              aria-label={te("sections.texts")}
              className="grid grid-cols-1 gap-4 rounded-xl border p-4 @lg/editor:grid-cols-2"
            >
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.dueDays} className="font-medium text-sm">
                  {te("dueDays")}
                </label>
                <Input
                  id={ids.dueDays}
                  inputMode="numeric"
                  value={editor.dueDays}
                  onChange={(e) => setEditor({ dueDays: e.target.value })}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.buyerRef} className="font-medium text-sm">
                  {te("buyerReference")}
                </label>
                <Input
                  id={ids.buyerRef}
                  value={editor.buyerReference}
                  onChange={(e) => setEditor({ buyerReference: e.target.value })}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5 @lg/editor:col-span-2">
                <label htmlFor={ids.subject} className="font-medium text-sm">
                  {te("subject")}
                </label>
                <Input
                  id={ids.subject}
                  value={editor.subject}
                  onChange={(e) => setEditor({ subject: e.target.value })}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.head} className="font-medium text-sm">
                  {te("headText")}
                </label>
                <Textarea
                  id={ids.head}
                  value={editor.headText}
                  onChange={(e) => setEditor({ headText: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.foot} className="font-medium text-sm">
                  {te("footText")}
                </label>
                <Textarea
                  id={ids.foot}
                  value={editor.footText}
                  onChange={(e) => setEditor({ footText: e.target.value })}
                />
              </div>
            </section>

            <section aria-label={t("sections.automation")} className="flex flex-col gap-2 rounded-xl border p-4">
              <h2 className="font-semibold text-base">{t("sections.automation")}</h2>
              <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
                <input
                  type="checkbox"
                  className="size-5 accent-primary md:size-4"
                  checked={form.finalize}
                  onChange={(e) => set({ finalize: e.target.checked })}
                />
                {t("finalize")}
              </label>
              <p className="text-muted-foreground text-sm">{t("finalizeNote")}</p>
              {form.finalize && id && !automationConfirmed && (
                <p className="text-sm text-warning">{t("finalizePending")}</p>
              )}
            </section>
          </div>

          <aside className="flex flex-col gap-4 @4xl/editor:sticky @4xl/editor:top-36 @4xl/editor:self-start">
            <section aria-label={t("sections.next")} className="flex flex-col gap-3 rounded-xl border p-4">
              <h2 className="font-semibold text-base">{t("sections.next")}</h2>
              {next && (
                <p className="text-sm">
                  {money(next.grossCents, next.currency)} · {formatDate(next.date)}
                </p>
              )}
              <OccurrenceTable rows={preview} />
            </section>
          </aside>
        </div>
      </div>

      <div
        className={
          inlineActions
            ? "flex gap-2 md:justify-end"
            : "fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex gap-2 border-t bg-background p-3 md:static md:justify-end md:border-0 md:bg-transparent md:p-0"
        }
      >
        <Button className="h-11 flex-1 md:h-9 md:flex-none" disabled={saving} onClick={onSave}>
          {t("save")}
        </Button>
      </div>

      {confirm && (
        <ConfirmDialog
          title={t("confirmTitle")}
          description={t("confirmDescription")}
          confirmLabel={t("confirmLabel")}
          confirmDisabled={saving}
          onConfirm={() => save(true)}
          onClose={() => setConfirm(false)}
        >
          <p className="text-muted-foreground text-sm">{t("finalizeNote")}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

type PreviewRows =
  | {
      date: string;
      period: { from: string; to: string };
      grossCents: number | null;
      currency: string;
      rates: { category: string; rateBp: number }[];
      decision: string | null;
      hints: string[];
      blocking: string | null;
    }[]
  | null
  | undefined;

/** REC-13 „Nächste Termine“: Datum, Zeitraum, Betrag, Steuersatz-Hinweis, ER-03. */
export function OccurrenceTable({ rows }: { rows: PreviewRows }) {
  const t = useTranslations("recurring.editor.preview");
  if (rows === undefined) return <p className="text-muted-foreground text-sm">{t("loading")}</p>;
  if (rows === null) return <p className="text-muted-foreground text-sm">{t("invalid")}</p>;
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">{t("empty")}</p>;
  return (
    <ol className="flex flex-col divide-y text-sm" data-testid="occurrences">
      {rows.map((r) => (
        <li key={r.date} className="flex flex-col gap-0.5 py-2">
          <div className="flex justify-between gap-2">
            <span className="font-medium tabular-nums">{formatDate(r.date)}</span>
            <span className="tabular-nums">{money(r.grossCents, r.currency)}</span>
          </div>
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("period")}: {formatDate(r.period.from)} – {formatDate(r.period.to)}
          </span>
          <span className="text-muted-foreground text-xs">
            {r.rates.map((x) => `${x.category} ${(x.rateBp / 100).toLocaleString("de-DE")} %`).join(", ") || "—"}
            {r.decision ? ` · ${t("er03")}: ${r.decision}` : ""}
          </span>
          {r.hints.map((h) => (
            <span key={h} className="text-warning text-xs">
              {t("rate")}: {h}
            </span>
          ))}
          {r.blocking && <span className="text-destructive text-xs">{t("blocking", { message: r.blocking })}</span>}
        </li>
      ))}
    </ol>
  );
}
