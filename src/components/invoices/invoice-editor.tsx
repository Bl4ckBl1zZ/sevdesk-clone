"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useConvex, useMutation } from "convex/react";
import { ArrowDownIcon, ArrowUpIcon, PackageIcon, PlusIcon, Trash2Icon, TypeIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, selectClass, todayBerlin, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RC13B_TYPE_KEYS, rc13bLabelDe } from "@/domain/rules/rc13b-types";
import { VAT_RATE_KEY_LABELS } from "@/domain/rules/vat-rates";
import type { DraftValues } from "@/domain/schemas/documents";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import {
  type EditorLine,
  type EditorState,
  editorFromValues,
  emptyEditor,
  emptyLine,
  lineFromValues,
  toDraftValues,
} from "./editor-model";
import { CompliancePanel, FORMAT_LABELS, money, TotalsPanel } from "./invoice-shared";

/** Debounced value for the live check (DOC-19: totals while typing, without a request per keystroke). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

/**
 * Rechnungseditor (F04 §6.2, DOC-19/20): header, positions with product picker, live totals and the compliance
 * panel from `invoices.check`, „Entwurf speichern“ and „Fertigstellen“ (finalise dialog).
 */
export function InvoiceEditor({
  id,
  initial,
  version,
  presetContactId,
}: {
  id?: Id<"salesDocuments">;
  initial?: DraftValues;
  version?: number;
  presetContactId?: string;
}) {
  const t = useTranslations("invoices.editor");
  const router = useRouter();
  const run = useRun();
  const convex = useConvex();
  const createDraft = useMutation(api.invoices.createDraft);
  const updateDraft = useMutation(api.invoices.updateDraft);
  const deleteDraft = useMutation(api.invoices.deleteDraft);
  const finalize = useAction(api.invoices.finalize);
  const [state, setState] = useState<EditorState>(() =>
    initial ? editorFromValues(initial) : emptyEditor(todayBerlin(), { contactId: presetContactId ?? "" }),
  );
  const [dirty, setDirty] = useState(!id);
  const [ver, setVer] = useState(version);
  const [saving, setSaving] = useState(false);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [contactQuery, setContactQuery] = useState("");
  const appliedDefaults = useRef<string | null>(initial ? (initial.contactId ?? "") : null);

  const contacts = useAuthedQuery(api.contacts.options, contactQuery ? { q: contactQuery } : {}) ?? [];
  const products = useAuthedQuery(api.products.options, {}) ?? [];
  const units = useAuthedQuery(api.lookups.listUnits, {}) ?? [];
  const defaults = useAuthedQuery(
    api.invoices.draftDefaults,
    state.contactId ? { contactId: state.contactId as Id<"contacts"> } : {},
  );

  const set = (patch: Partial<EditorState>) => {
    setState((s) => ({ ...s, ...patch }));
    setDirty(true);
  };
  const setLine = (key: string, patch: Partial<EditorLine>) =>
    set({ lines: state.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });

  // DOC-08: defaults of the chosen contact (price mode, terms, bank account) when the contact changes.
  useEffect(() => {
    if (!defaults || appliedDefaults.current === state.contactId) return;
    appliedDefaults.current = state.contactId;
    setState((s) => ({
      ...s,
      priceMode: defaults.priceMode,
      language: defaults.language,
      currency: defaults.currency,
      dueDays: String(defaults.paymentTerms.dueDays),
      skontoPercent: defaults.paymentTerms.skontoPercentBp
        ? String(defaults.paymentTerms.skontoPercentBp / 100).replace(".", ",")
        : "",
      skontoDays: defaults.paymentTerms.skontoDays !== undefined ? String(defaults.paymentTerms.skontoDays) : "",
      bankAccountId: defaults.bankAccountId ?? "",
      paymentMethodId: defaults.paymentMethodId ?? "",
      buyerReference: s.buyerReference || (defaults.buyerReference ?? ""),
    }));
  }, [defaults, state.contactId]);

  const { values, errors: inputErrors } = useMemo(() => toDraftValues(state), [state]);
  const debounced = useDebounced(values, 250);
  const check = useAuthedQuery(api.invoices.check, { values: debounced, ...(id ? { id } : {}) });

  const save = async (): Promise<Id<"salesDocuments"> | null> => {
    if (inputErrors.length > 0) {
      toast.error(inputErrors[0]?.message ?? t("inputInvalid"));
      return null;
    }
    setSaving(true);
    try {
      if (!id) {
        const r = await run(() => createDraft({ values }), t("saved"));
        if (!r.ok) return null;
        setDirty(false);
        router.replace(`/rechnungen/${r.value.id}` as Route);
        return r.value.id;
      }
      if (!dirty) return id;
      const r = await run(() => updateDraft({ id, version: ver ?? 1, values }), t("saved"));
      if (!r.ok) return null;
      setVer(r.value.version);
      for (const n of r.value.notices) toast.info(n);
      setDirty(false);
      return id;
    } finally {
      setSaving(false);
    }
  };

  const doFinalize = async () => {
    if (!id || ver === undefined) return;
    setSaving(true);
    const r = await run(() => finalize({ id, version: ver }));
    setSaving(false);
    setConfirmFinalize(false);
    if (r.ok) toast.success(t("finalized", { number: r.value.number }));
  };

  const addProduct = async (productId: string) => {
    if (!productId) return;
    const r = await run(() =>
      convex.query(api.invoices.productLine, {
        productId: productId as Id<"products">,
        ...(state.contactId ? { contactId: state.contactId as Id<"contacts"> } : {}),
        referenceDate: state.supplyDate || todayBerlin(),
        priceMode: state.priceMode,
        currency: state.currency,
      }),
    );
    if (!r.ok) return;
    for (const w of r.value.warnings) toast.warning(w);
    const line = lineFromValues(r.value.line as DraftValues["lines"][number]);
    const lines = state.lines.length === 1 && !state.lines[0]?.name ? [line] : [...state.lines, line];
    set({ lines });
  };

  const move = (i: number, d: -1 | 1) => {
    const lines = [...state.lines];
    const [x] = lines.splice(i, 1);
    if (x) lines.splice(i + d, 0, x);
    set({ lines });
  };

  const findings = check?.findings ?? [];
  const canFinalize = !!id && !dirty && check?.canFinalize === true && inputErrors.length === 0;
  const ids = {
    contact: useId(),
    contactSearch: useId(),
    supplyMode: useId(),
    supplyDate: useId(),
    supplyFrom: useId(),
    supplyTo: useId(),
    dueDays: useId(),
    skonto: useId(),
    skontoDays: useId(),
    subject: useId(),
    head: useId(),
    foot: useId(),
    buyerRef: useId(),
    format: useId(),
    priceMode: useId(),
    product: useId(),
  };

  return (
    // The query container wraps only the form grid: a container is the containing block of `position: fixed`
    // descendants, so the phone action bar below must stay outside it to be fixed to the viewport.
    <div className="flex flex-col gap-4 pb-28 md:pb-0">
      <div className="@container/editor">
        <div className="grid grid-cols-1 gap-4 @4xl/editor:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <section
              aria-label={t("sections.customer")}
              className="grid grid-cols-1 gap-4 rounded-xl border p-4 @lg/editor:grid-cols-2"
            >
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.contactSearch} className="font-medium text-sm">
                  {t("contactSearch")}
                </label>
                <Input
                  id={ids.contactSearch}
                  value={contactQuery}
                  placeholder={t("contactSearchPlaceholder")}
                  onChange={(e) => setContactQuery(e.target.value)}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.contact} className="font-medium text-sm">
                  {t("contact")}
                </label>
                <select
                  id={ids.contact}
                  className={selectClass}
                  value={state.contactId}
                  onChange={(e) => set({ contactId: e.target.value })}
                >
                  <option value="">{t("contactNone")}</option>
                  {state.contactId && !contacts.some((c) => c._id === state.contactId) && (
                    <option value={state.contactId}>{check?.buyer?.name ?? t("contactSelected")}</option>
                  )}
                  {contacts.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.displayName} ({c.number})
                    </option>
                  ))}
                </select>
              </div>
              {check?.buyer && (
                <address className="text-muted-foreground text-sm not-italic @lg/editor:col-span-2" data-testid="buyer">
                  <span className="font-medium text-foreground">{check.buyer.name}</span>
                  {check.buyer.contactPerson ? `, z. Hd. ${check.buyer.contactPerson.name}` : ""}
                  {check.buyer.address
                    ? ` · ${check.buyer.address.street}, ${check.buyer.address.postalCode} ${check.buyer.address.city}`
                    : ""}
                  {!check.buyer.invoiceEmail && (
                    <span className="block text-warning">
                      {t("noInvoiceEmail")}{" "}
                      <Link className="underline" href={`/kontakte/${state.contactId}` as Route}>
                        {t("addEmail")}
                      </Link>
                    </span>
                  )}
                </address>
              )}
            </section>

            <section
              aria-label={t("sections.dates")}
              className="grid grid-cols-1 gap-4 rounded-xl border p-4 @lg/editor:grid-cols-3"
            >
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.supplyMode} className="font-medium text-sm">
                  {t("supplyMode")}
                </label>
                <select
                  id={ids.supplyMode}
                  className={selectClass}
                  value={state.supplyDateMode === "document_date" ? "document_date" : state.supplyKind}
                  onChange={(e) =>
                    e.target.value === "document_date"
                      ? set({ supplyDateMode: "document_date" })
                      : set({ supplyDateMode: "explicit", supplyKind: e.target.value as "date" | "period" })
                  }
                >
                  <option value="date">{t("supplyDate")}</option>
                  <option value="period">{t("supplyPeriod")}</option>
                  <option value="document_date">{t("supplyIsDocumentDate")}</option>
                </select>
              </div>
              {state.supplyDateMode === "explicit" && state.supplyKind === "date" && (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={ids.supplyDate} className="font-medium text-sm">
                    {t("supplyDateLabel")}
                  </label>
                  <Input
                    id={ids.supplyDate}
                    type="date"
                    value={state.supplyDate}
                    onChange={(e) => set({ supplyDate: e.target.value })}
                    className="h-11 md:h-9"
                  />
                </div>
              )}
              {state.supplyDateMode === "explicit" && state.supplyKind === "period" && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={ids.supplyFrom} className="font-medium text-sm">
                      {t("supplyFrom")}
                    </label>
                    <Input
                      id={ids.supplyFrom}
                      type="date"
                      value={state.supplyFrom}
                      onChange={(e) => set({ supplyFrom: e.target.value })}
                      className="h-11 md:h-9"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={ids.supplyTo} className="font-medium text-sm">
                      {t("supplyTo")}
                    </label>
                    <Input
                      id={ids.supplyTo}
                      type="date"
                      value={state.supplyTo}
                      onChange={(e) => set({ supplyTo: e.target.value })}
                      className="h-11 md:h-9"
                    />
                  </div>
                </>
              )}
              <p className="text-muted-foreground text-sm @lg/editor:col-span-3">
                {t("documentDateHint", { date: check?.documentDate ?? todayBerlin() })}
              </p>
            </section>

            <section aria-label={t("sections.lines")} className="flex flex-col gap-3 rounded-xl border p-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <h2 className="font-semibold text-base">{t("sections.lines")}</h2>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={ids.priceMode} className="font-medium text-sm">
                    {t("priceMode")}
                  </label>
                  <select
                    id={ids.priceMode}
                    className={selectClass}
                    value={state.priceMode}
                    onChange={(e) => set({ priceMode: e.target.value as "net" | "gross" })}
                  >
                    <option value="net">{t("net")}</option>
                    <option value="gross">{t("gross")}</option>
                  </select>
                </div>
              </div>
              <ol className="flex flex-col gap-3">
                {state.lines.map((l, i) => (
                  <LineEditor
                    key={l.key}
                    line={l}
                    index={i}
                    count={state.lines.length}
                    units={units.filter((u) => !u.archivedAt).map((u) => ({ code: u.code, label: u.labelDe }))}
                    vatLabel={check?.lines.find((x) => x.index === i)}
                    lineNet={check?.totals?.lineNets[state.lines.slice(0, i).filter((x) => x.kind === "item").length]}
                    currency={state.currency}
                    onChange={(patch) => setLine(l.key, patch)}
                    onRemove={() => set({ lines: state.lines.filter((x) => x.key !== l.key) })}
                    onMove={(d) => move(i, d)}
                  />
                ))}
              </ol>
              <div className="flex flex-wrap items-end gap-2">
                <Button
                  variant="outline"
                  className="h-11 md:h-9"
                  onClick={() => set({ lines: [...state.lines, emptyLine()] })}
                >
                  <PlusIcon aria-hidden="true" />
                  {t("addLine")}
                </Button>
                <Button
                  variant="outline"
                  className="h-11 md:h-9"
                  onClick={() => set({ lines: [...state.lines, emptyLine("text")] })}
                >
                  <TypeIcon aria-hidden="true" />
                  {t("addText")}
                </Button>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={ids.product} className="font-medium text-sm">
                    <PackageIcon className="mr-1 inline size-4" aria-hidden="true" />
                    {t("addProduct")}
                  </label>
                  <select
                    id={ids.product}
                    className={selectClass}
                    value=""
                    onChange={(e) => void addProduct(e.target.value)}
                  >
                    <option value="">{t("chooseProduct")}</option>
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
              aria-label={t("sections.payment")}
              className="grid grid-cols-1 gap-4 rounded-xl border p-4 @lg/editor:grid-cols-3"
            >
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.dueDays} className="font-medium text-sm">
                  {t("dueDays")}
                </label>
                <Input
                  id={ids.dueDays}
                  inputMode="numeric"
                  value={state.dueDays}
                  onChange={(e) => set({ dueDays: e.target.value })}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.skonto} className="font-medium text-sm">
                  {t("skontoPercent")}
                </label>
                <Input
                  id={ids.skonto}
                  inputMode="decimal"
                  value={state.skontoPercent}
                  onChange={(e) => set({ skontoPercent: e.target.value })}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.skontoDays} className="font-medium text-sm">
                  {t("skontoDays")}
                </label>
                <Input
                  id={ids.skontoDays}
                  inputMode="numeric"
                  value={state.skontoDays}
                  onChange={(e) => set({ skontoDays: e.target.value })}
                  className="h-11 md:h-9"
                />
              </div>
            </section>

            <section
              aria-label={t("sections.texts")}
              className="grid grid-cols-1 gap-4 rounded-xl border p-4 @lg/editor:grid-cols-2"
            >
              <div className="flex flex-col gap-1.5 @lg/editor:col-span-2">
                <label htmlFor={ids.subject} className="font-medium text-sm">
                  {t("subject")}
                </label>
                <Input
                  id={ids.subject}
                  value={state.subject}
                  onChange={(e) => set({ subject: e.target.value })}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.head} className="font-medium text-sm">
                  {t("headText")}
                </label>
                <Textarea id={ids.head} value={state.headText} onChange={(e) => set({ headText: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.foot} className="font-medium text-sm">
                  {t("footText")}
                </label>
                <Textarea id={ids.foot} value={state.footText} onChange={(e) => set({ footText: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.buyerRef} className="font-medium text-sm">
                  {t("buyerReference")}
                </label>
                <Input
                  id={ids.buyerRef}
                  value={state.buyerReference}
                  onChange={(e) => set({ buyerReference: e.target.value })}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.format} className="font-medium text-sm">
                  {t("einvoiceFormat")}
                </label>
                <select
                  id={ids.format}
                  className={selectClass}
                  value={state.einvoiceFormat}
                  onChange={(e) => set({ einvoiceFormat: e.target.value })}
                >
                  <option value="">
                    {t("formatAuto", { format: FORMAT_LABELS[check?.einvoice.format ?? ""] ?? "—" })}
                  </option>
                  {(check?.einvoice.allowed ?? []).map((f) => (
                    <option key={f} value={f}>
                      {FORMAT_LABELS[f] ?? f}
                    </option>
                  ))}
                </select>
              </div>
              <fieldset className="flex flex-col gap-2 @lg/editor:col-span-2">
                <legend className="mb-1 font-medium text-sm">{t("flags")}</legend>
                <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
                  <input
                    type="checkbox"
                    className="size-5 accent-primary md:size-4"
                    checked={state.kleinbetrag}
                    onChange={(e) => set({ kleinbetrag: e.target.checked })}
                  />
                  {t("kleinbetrag")}
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
                  <input
                    type="checkbox"
                    className="size-5 accent-primary md:size-4"
                    checked={state.constructionWork}
                    onChange={(e) => set({ constructionWork: e.target.checked })}
                  />
                  {t("constructionWork")}
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
                  <input
                    type="checkbox"
                    className="size-5 accent-primary md:size-4"
                    checked={state.showEpcQr}
                    onChange={(e) => set({ showEpcQr: e.target.checked })}
                  />
                  {t("showEpcQr")}
                </label>
              </fieldset>
            </section>
          </div>

          <aside className="flex flex-col gap-4 @4xl/editor:sticky @4xl/editor:top-36 @4xl/editor:self-start">
            <section aria-label={t("sections.totals")} className="flex flex-col gap-3 rounded-xl border p-4">
              <h2 className="font-semibold text-base">{t("sections.totals")}</h2>
              <TotalsPanel totals={check?.totals ?? null} currency={state.currency} />
              {check && (
                <p className="text-muted-foreground text-xs">
                  {t("taxCase")}: {check.taxCase}
                  {check.einvoice.decision ? ` · ${t("er03")}: ${check.einvoice.decision}` : ""}
                </p>
              )}
            </section>
            <CompliancePanel
              findings={[
                ...findings,
                ...inputErrors.map((e) => ({
                  code: "input",
                  severity: "E" as const,
                  message: e.message,
                  rule: "DOC-19",
                  group: "pflichtangaben",
                })),
              ]}
            />
          </aside>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex gap-2 border-t bg-background p-3 md:static md:justify-end md:border-0 md:bg-transparent md:p-0">
        {id && (
          <Button variant="ghost" className="h-11 md:h-9" onClick={() => setConfirmDelete(true)}>
            <Trash2Icon aria-hidden="true" />
            <span className="sr-only md:not-sr-only">{t("delete")}</span>
          </Button>
        )}
        <Button
          variant="outline"
          className="h-11 flex-1 md:h-9 md:flex-none"
          disabled={saving}
          onClick={() => void save()}
        >
          {t("save")}
        </Button>
        <Button
          className="h-11 flex-1 md:h-9 md:flex-none"
          disabled={saving || (!!id && !dirty && check?.canFinalize === false)}
          onClick={async () => {
            const saved = await save();
            if (saved && id) setConfirmFinalize(true);
          }}
        >
          {t("finalize")}
        </Button>
      </div>

      {confirmFinalize && (
        <ConfirmDialog
          title={t("finalizeTitle")}
          description={t("finalizeDescription")}
          confirmLabel={t("finalizeConfirm")}
          confirmDisabled={saving || !canFinalize}
          onConfirm={doFinalize}
          onClose={() => setConfirmFinalize(false)}
        >
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t("finalizeCustomer")}</dt>
            <dd className="text-right">{check?.buyer?.name ?? "—"}</dd>
            <dt className="text-muted-foreground">{t("finalizeGross")}</dt>
            <dd className="text-right tabular-nums">{money(check?.totals?.grossCents, state.currency)}</dd>
            <dt className="text-muted-foreground">{t("finalizeFormat")}</dt>
            <dd className="text-right">{FORMAT_LABELS[check?.einvoice.format ?? ""] ?? "—"}</dd>
          </dl>
          {findings.some((f) => f.severity === "W") && (
            <ul className="flex flex-col gap-1 text-sm text-warning">
              {findings
                .filter((f) => f.severity === "W")
                .map((f) => (
                  <li key={f.code + f.message}>{f.message}</li>
                ))}
            </ul>
          )}
        </ConfirmDialog>
      )}
      {confirmDelete && id && (
        <ConfirmDialog
          title={t("deleteTitle")}
          description={t("deleteDescription")}
          confirmLabel={t("delete")}
          destructive
          onConfirm={async () => {
            const r = await run(() => deleteDraft({ id }), t("deleted"));
            if (r.ok) router.push("/rechnungen");
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

function LineEditor({
  line,
  index,
  count,
  units,
  vatLabel,
  lineNet,
  currency,
  onChange,
  onRemove,
  onMove,
}: {
  line: EditorLine;
  index: number;
  count: number;
  units: { code: string; label: string }[];
  vatLabel?: { vatCategory: string; vatRateBp: number };
  lineNet?: number;
  currency: string;
  onChange: (patch: Partial<EditorLine>) => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
}) {
  const t = useTranslations("invoices.editor.line");
  const base = useId();
  const n = index + 1;
  const field = (name: string) => `${base}-${name}`;
  if (line.kind !== "item") {
    return (
      <li className="flex items-end gap-2 rounded-lg border border-dashed p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor={field("text")} className="font-medium text-sm">
            {t("textLabel", { n })}
          </label>
          <Textarea id={field("text")} value={line.name} onChange={(e) => onChange({ name: e.target.value })} />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 md:size-9"
          aria-label={t("remove", { n })}
          onClick={onRemove}
        >
          <Trash2Icon aria-hidden="true" />
        </Button>
      </li>
    );
  }
  return (
    <li className="@container/line flex flex-col gap-3 rounded-lg border p-3" data-testid="line">
      <div className="grid grid-cols-1 gap-3 @2xl/line:grid-cols-[minmax(0,2fr)_6rem_7rem_8rem_6rem_9rem]">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={field("name")} className="font-medium text-sm">
            {t("name", { n })}
          </label>
          <Input
            id={field("name")}
            value={line.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="h-11 md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={field("qty")} className="font-medium text-sm">
            {t("quantity")}
          </label>
          <Input
            id={field("qty")}
            inputMode="decimal"
            value={line.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
            className="h-11 text-right tabular-nums md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={field("unit")} className="font-medium text-sm">
            {t("unit")}
          </label>
          <select
            id={field("unit")}
            className={selectClass}
            value={line.unitCode}
            onChange={(e) => onChange({ unitCode: e.target.value })}
          >
            {!units.some((u) => u.code === line.unitCode) && (
              <option value={line.unitCode}>{line.unitCode || "—"}</option>
            )}
            {units.map((u) => (
              <option key={u.code} value={u.code}>
                {u.label} ({u.code})
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={field("price")} className="font-medium text-sm">
            {t("price")}
          </label>
          <Input
            id={field("price")}
            inputMode="decimal"
            value={line.price}
            onChange={(e) => onChange({ price: e.target.value })}
            className="h-11 text-right tabular-nums md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={field("discount")} className="font-medium text-sm">
            {t("discount")}
          </label>
          <Input
            id={field("discount")}
            inputMode="decimal"
            value={line.discount}
            onChange={(e) => onChange({ discount: e.target.value })}
            className="h-11 text-right tabular-nums md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={field("vat")} className="font-medium text-sm">
            {t("vat")}
          </label>
          <select
            id={field("vat")}
            className={selectClass}
            value={line.vatRateKey}
            onChange={(e) => onChange({ vatRateKey: e.target.value })}
          >
            {Object.entries(VAT_RATE_KEY_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 @2xl/line:grid-cols-[minmax(0,2fr)_10rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={field("desc")} className="font-medium text-sm">
            {t("description")}
          </label>
          <Input
            id={field("desc")}
            value={line.description}
            onChange={(e) => onChange({ description: e.target.value })}
            className="h-11 md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={field("type")} className="font-medium text-sm">
            {t("type")}
          </label>
          <select
            id={field("type")}
            className={selectClass}
            value={line.productType}
            onChange={(e) => onChange({ productType: e.target.value as "good" | "service" })}
          >
            <option value="service">{t("service")}</option>
            <option value="good">{t("good")}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={field("rc")} className="font-medium text-sm">
            {t("reverseCharge13b")}
          </label>
          <select
            id={field("rc")}
            className={selectClass}
            value={line.reverseCharge13b}
            onChange={(e) => onChange({ reverseCharge13b: e.target.value })}
          >
            <option value="">{t("noReverseCharge")}</option>
            {RC13B_TYPE_KEYS.map((k) => (
              <option key={k} value={k}>
                {rc13bLabelDe(k)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
          <input
            type="checkbox"
            className="size-5 accent-primary md:size-4"
            checked={line.isLaborCost}
            onChange={(e) => onChange({ isLaborCost: e.target.checked })}
          />
          {t("laborCost")}
        </label>
        <div className="flex items-center gap-1">
          <span className={cn("mr-2 text-sm tabular-nums", lineNet === undefined && "text-muted-foreground")}>
            {vatLabel ? `${vatLabel.vatCategory} ${(vatLabel.vatRateBp / 100).toLocaleString("de-DE")} % · ` : ""}
            {money(lineNet, currency)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 md:size-9"
            aria-label={t("up", { n })}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUpIcon aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 md:size-9"
            aria-label={t("down", { n })}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDownIcon aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 md:size-9"
            aria-label={t("remove", { n })}
            onClick={onRemove}
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </li>
  );
}
