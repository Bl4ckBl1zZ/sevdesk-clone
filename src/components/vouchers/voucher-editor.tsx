"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { CheckCheckIcon, FileSignatureIcon, PlusIcon, Trash2Icon, UtensilsIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useFreshAction } from "@/components/auth/fresh-action";
import { ConfirmDialog, FormSection, formatDateTime, todayBerlin, useCan, useRun } from "@/components/catalog/shared";
import { adapterErrorMessage, adapterErrorReason } from "@/components/setup/actions";
import { Button } from "@/components/ui/button";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { BewirtungSheet, EigenbelegSheet } from "./voucher-approvals";
import { CheckboxInput, SelectInput, TextArea, TextInput } from "./voucher-fields";
import { VoucherFiles, type VoucherFileView } from "./voucher-files";
import {
  type Direction,
  emptyLine,
  type FormIssue,
  type PriceMode,
  type StoredLine,
  type StoredVoucher,
  toDraftInput,
  updateLine,
  type VoucherForm,
  type VoucherKind,
  voucherFormFrom,
} from "./voucher-form";
import { BookDialog, ReasonField } from "./voucher-payment";
import { money, VoucherCheckPanel } from "./voucher-shared";

export type VoucherDetailData = NonNullable<FunctionReturnType<typeof api.vouchers.get>>;
type VId = Id<"vouchers">;

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "PLN", "CZK", "DKK", "SEK", "NOK"] as const;
const KINDS: readonly VoucherKind[] = ["standard", "bewirtung", "eigenbeleg", "asset", "tax_payment", "private"];

/**
 * Voucher editor (F06 §6.3, VOU-001…010): Lieferant · Kopf · Steuer · Positionen · Summen · Dateien and the check.
 * The editor parses what was typed and saves the draft; totals, VAT, the effective tax rule and every warning come
 * from the saved draft (`vouchers.preview`). „Buchen“ opens the dialog with „Bezahlt mit“.
 */
export function VoucherEditor({
  data,
  onBooked,
  onDeleted,
  bookRef,
  mode = "draft",
  onCorrectionDone,
}: {
  data: VoucherDetailData;
  onBooked?: () => void;
  onDeleted?: () => void;
  /** `correct`: a booked, unlocked voucher (VOU-008) — saving asks for a reason and rebooks (Generalumkehr). */
  mode?: "draft" | "correct";
  onCorrectionDone?: () => void;
  /** Lets the batch queue trigger „Buchen und weiter“ from the keyboard. */
  bookRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const t = useTranslations("vouchers.editor");
  const tb = useTranslations("vouchers.book");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const v = data.voucher;
  const id = v._id as VId;
  const canWrite = useCan("vouchers.write");
  const canApprove = useCan("vouchers.approve");
  const update = useMutation(api.vouchers.updateDraft);
  const remove = useMutation(api.vouchers.deleteDraft);
  const checked = useMutation(api.vouchers.checkedComplete);
  const correct = useMutation(api.vouchers.correct);
  const td = useTranslations("vouchers.detail");
  const run = useRun();
  const fresh = useFreshAction();
  const [correcting, setCorrecting] = useState(false);
  const [reason, setReason] = useState("");
  const [ackCodes, setAckCodes] = useState<string[] | null>(null);
  const [ack, setAck] = useState(false);
  const [correctError, setCorrectError] = useState<string | null>(null);
  const fromData = () =>
    voucherFormFrom(v as unknown as StoredVoucher, data.lines as unknown as StoredLine[], todayBerlin());
  const [form, setForm] = useState<VoucherForm>(fromData);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<FormIssue[]>([]);
  const [booking, setBooking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sheet, setSheet] = useState<"bewirtung" | "eigenbeleg" | null>(null);
  const [saving, setSaving] = useState(false);
  const seenVersion = useRef(v.version);

  // A saved draft comes back with a new version: take the server state unless the user is typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync only on a new server version
  useEffect(() => {
    if (v.version !== seenVersion.current && !dirty) setForm(fromData());
    seenVersion.current = v.version;
  }, [v.version]);

  const taxRuleForOptions = form.taxRule || v.taxRule;
  const options = useAuthedQuery(api.vouchers.options, {
    direction: form.direction,
    taxRule: taxRuleForOptions,
    ...(form.documentDate ? { date: form.documentDate } : {}),
  });
  const suggestion = useAuthedQuery(
    api.vouchers.suggest,
    {
      direction: form.direction,
      ...(form.supplierName.trim() ? { supplierName: form.supplierName.trim() } : {}),
      ...(form.supplierVatId.trim() ? { supplierVatId: form.supplierVatId.trim() } : {}),
      ...(form.documentDate ? { date: form.documentDate } : {}),
      text: form.lines.map((l) => l.description).join(" "),
    },
    canWrite,
  );

  const patch = (p: Partial<VoucherForm>) => {
    setForm((f) => ({ ...f, ...p }));
    setDirty(true);
  };
  const patchLine = (i: number, p: Partial<VoucherForm["lines"][number]>) => {
    setForm((f) => ({ ...f, lines: f.lines.map((l, k) => (k === i ? updateLine(l, p) : l)) }));
    setDirty(true);
  };

  const submitCorrection = async () => {
    const { input, issues: found } = toDraftInput(form);
    setIssues(found);
    if (found.length > 0) return;
    setSaving(true);
    setCorrectError(null);
    try {
      await fresh(() =>
        correct({
          id,
          version: v.version,
          input: input as never,
          reason: reason.trim(),
          ...(ack && ackCodes ? { acknowledgeWarnings: ackCodes } : {}),
        }),
      );
      toast.success(td("corrected"));
      setCorrecting(false);
      setDirty(false);
      onCorrectionDone?.();
    } catch (e) {
      if (adapterErrorReason(e) === "WARNINGS_UNACKNOWLEDGED" && e instanceof ConvexError) {
        setAckCodes(
          String((e.data as { warnings?: string }).warnings ?? "")
            .split(",")
            .filter(Boolean),
        );
      }
      setCorrectError(adapterErrorMessage(e) ?? (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  const save = async (): Promise<boolean> => {
    const { input, issues: found } = toDraftInput(form);
    setIssues(found);
    if (found.length > 0) return false;
    if (mode === "correct") {
      setCorrecting(true);
      return false;
    }
    setSaving(true);
    const r = await run(() => update({ id, version: v.version, input: input as never }));
    setSaving(false);
    if (r.ok) {
      setDirty(false);
      seenVersion.current = r.value.version;
      toast.success(t("saved"));
    }
    return r.ok;
  };

  const startBooking = async () => {
    if (dirty && !(await save())) return;
    setBooking(true);
  };
  if (bookRef) bookRef.current = () => void startBooking();

  const issueFor = (field: string) => issues.find((i) => i.field === field)?.message;
  const amountLabel = form.priceMode === "gross" ? t("line.amountGross") : t("line.amountNet");
  const accountOptions = (current: string) => {
    const list = (options?.accounts ?? []).map((a) => ({ value: a.number, label: `${a.number} – ${a.name}` }));
    if (current && !list.some((o) => o.value === current)) list.unshift({ value: current, label: current });
    return [{ value: "", label: t("line.accountPlaceholder") }, ...list];
  };
  const suggested = suggestion?.account;
  const firstEmpty = form.lines.findIndex((l) => !l.account);
  const ruleLabel = options?.taxRules.find((r) => r.value === v.taxRule)?.label ?? v.taxRule;
  const help = options?.taxRules.find((r) => r.value === (form.taxRule || v.taxRule))?.help;
  const totals = data.check?.totals as
    | { netCents: number; vatCents: number; grossCents: number; selfAssessedVatCents?: number }
    | undefined;
  const totalsEur = data.check?.totalsEur as { grossCents: number } | undefined;
  const hasErrors = !data.check || data.check.errors.length > 0;

  return (
    <div className="flex flex-col gap-4" data-testid="voucher-editor">
      {options?.ku && <p className="rounded-lg border border-info/30 bg-info/5 p-3 text-sm">{t("ku")}</p>}
      <div className="grid gap-4 @5xl/main:grid-cols-[minmax(0,1fr)_22rem]">
        <form
          noValidate
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <FormSection title={t("sections.supplier")}>
            <SelectInput
              label={t("direction")}
              value={form.direction}
              onChange={(d) => patch({ direction: d as Direction, taxRule: "" })}
              options={(["expense", "income"] as const).map((d) => ({ value: d, label: t(`directions.${d}`) }))}
              testId="voucher-direction"
            />
            <SelectInput
              label={t("kind")}
              value={form.kind}
              onChange={(k) => patch({ kind: k as VoucherKind })}
              options={KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
            />
            <TextInput
              label={t("supplierName")}
              value={form.supplierName}
              onChange={(supplierName) => patch({ supplierName })}
              testId="voucher-supplier"
            />
            <TextInput
              label={t("supplierVatId")}
              value={form.supplierVatId}
              onChange={(supplierVatId) => patch({ supplierVatId })}
            />
            <TextInput
              label={t("supplierTaxNumber")}
              value={form.supplierTaxNumber}
              onChange={(supplierTaxNumber) => patch({ supplierTaxNumber })}
            />
            <TextInput
              label={t("supplierIban")}
              value={form.supplierIban}
              onChange={(supplierIban) => patch({ supplierIban })}
            />
            <TextArea
              className="@lg/form:col-span-2"
              label={t("supplierAddress")}
              rows={2}
              value={form.supplierAddress}
              onChange={(supplierAddress) => patch({ supplierAddress })}
            />
          </FormSection>

          <FormSection title={t("sections.header")}>
            <TextInput
              label={t("documentNumber")}
              value={form.documentNumber}
              onChange={(documentNumber) => patch({ documentNumber })}
              testId="voucher-document-number"
            />
            <TextInput
              label={t("documentDate")}
              type="date"
              value={form.documentDate}
              onChange={(documentDate) => patch({ documentDate })}
              testId="voucher-document-date"
            />
            <TextInput
              label={t("supplyDate")}
              type="date"
              hint={t("supplyDateHint")}
              value={form.supplyDate}
              onChange={(supplyDate) => patch({ supplyDate })}
            />
            <TextInput
              label={t("dueDate")}
              type="date"
              value={form.dueDate}
              onChange={(dueDate) => patch({ dueDate })}
            />
            <SelectInput
              label={t("currency")}
              value={form.currency}
              onChange={(currency) => patch({ currency })}
              options={CURRENCIES.map((c) => ({ value: c, label: c }))}
            />
            {form.currency !== "EUR" && (
              <TextInput
                label={t("fxRate")}
                inputMode="decimal"
                value={form.fxRate}
                error={issueFor("fxRate")}
                onChange={(fxRate) => patch({ fxRate })}
              />
            )}
            <TextInput
              label={t("statedGross")}
              hint={t("statedGrossHint")}
              inputMode="decimal"
              value={form.statedGross}
              error={issueFor("statedGross")}
              onChange={(statedGross) => patch({ statedGross })}
            />
          </FormSection>

          <FormSection title={t("sections.tax")}>
            <SelectInput
              label={t("taxRule")}
              value={form.taxRule}
              onChange={(taxRule) => patch({ taxRule })}
              options={[
                { value: "", label: t("taxRuleAuto", { label: ruleLabel }) },
                ...(options?.taxRules ?? []).map((r) => ({ value: r.value, label: r.label })),
              ]}
              hint={help}
              testId="voucher-tax-rule"
            />
            <SelectInput
              label={t("priceMode")}
              value={form.priceMode}
              onChange={(priceMode) => patch({ priceMode: priceMode as PriceMode })}
              options={(["gross", "net"] as const).map((m) => ({ value: m, label: t(`priceModes.${m}`) }))}
            />
          </FormSection>

          <LinesSection
            form={form}
            amountLabel={amountLabel}
            accountOptions={accountOptions}
            issueFor={issueFor}
            patchLine={patchLine}
            onAdd={() => patch({ lines: [...form.lines, emptyLine(form.lines.at(-1)?.rate ?? "19")] })}
            onRemove={(i) => patch({ lines: form.lines.filter((_, k) => k !== i) })}
            suggestion={
              suggested && firstEmpty >= 0
                ? {
                    label: t("suggestion", { account: `${suggested.account}` }),
                    apply: () => patchLine(firstEmpty, { account: suggested.account }),
                  }
                : null
            }
          />

          <FormSection title={t("sections.notes")}>
            <TextArea
              className="@lg/form:col-span-2"
              label={t("internalNote")}
              value={form.internalNote}
              onChange={(internalNote) => patch({ internalNote })}
            />
          </FormSection>

          {canWrite && mode === "correct" && (
            <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 flex flex-wrap gap-2 rounded-xl border bg-background/95 p-3 shadow-sm md:bottom-2">
              <Button type="submit" className="h-11 md:h-9" disabled={saving} data-testid="voucher-correct-save">
                {td("correct")}
              </Button>
              <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => onCorrectionDone?.()}>
                {tCommon("cancel")}
              </Button>
            </div>
          )}
          {canWrite && mode === "draft" && (
            <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 flex flex-wrap gap-2 rounded-xl border bg-background/95 p-3 shadow-sm md:bottom-2">
              <Button
                type="submit"
                variant="outline"
                className="h-11 md:h-9"
                disabled={saving}
                data-testid="voucher-save"
              >
                {t("save")}
              </Button>
              <Button
                type="button"
                className="h-11 md:h-9"
                onClick={() => void startBooking()}
                disabled={saving || (!dirty && hasErrors)}
                data-testid="voucher-book"
              >
                {tb("title")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11 text-danger md:ml-auto md:h-9"
                onClick={() => setDeleting(true)}
              >
                <Trash2Icon aria-hidden="true" />
                {t("deleteDraft")}
              </Button>
            </div>
          )}
        </form>

        <aside className={mode === "correct" ? "hidden" : "flex flex-col gap-4"}>
          <VoucherCheckPanel
            check={
              data.check
                ? {
                    errors: data.check.errors,
                    warnings: data.check.warnings,
                    infos: data.check.infos,
                    inputVatAtRisk: data.check.inputVatAtRisk,
                  }
                : null
            }
          />
          {totals && (
            <section className="flex flex-col gap-1 rounded-xl border p-4 text-sm" data-testid="voucher-totals">
              <h2 className="mb-1 font-semibold text-base">{t("sections.totals")}</h2>
              <Row label={t("totals.net")} value={money(totals.netCents, v.currency)} />
              <Row label={t("totals.vat")} value={money(totals.vatCents, v.currency)} />
              {!!totals.selfAssessedVatCents && (
                <Row label={t("totals.selfAssessed")} value={money(totals.selfAssessedVatCents, v.currency)} />
              )}
              <Row label={t("totals.gross")} value={money(totals.grossCents, v.currency)} strong />
              {v.currency !== "EUR" && totalsEur && <Row label={t("totals.eur")} value={money(totalsEur.grossCents)} />}
            </section>
          )}
          {dirty && <p className="text-muted-foreground text-xs">{t("unsaved")}</p>}
          <VoucherFiles
            id={id}
            files={data.files as unknown as VoucherFileView[]}
            eigenbelegFile={data.eigenbelegFile}
            bewirtungFile={data.bewirtungFile}
            canAdd={canWrite}
            canReplace={canWrite}
            reasonRequired={false}
          />
          {canWrite && (
            <div className="flex flex-col gap-2">
              {form.kind === "bewirtung" && canApprove && (
                <Button
                  variant="outline"
                  className="h-11 md:h-9"
                  onClick={() => setSheet("bewirtung")}
                  data-testid="open-bewirtung"
                >
                  <UtensilsIcon aria-hidden="true" />
                  {t("bewirtung")}
                </Button>
              )}
              {form.kind === "eigenbeleg" && canApprove && !v.eigenbeleg?.approvedAt && (
                <Button
                  variant="outline"
                  className="h-11 md:h-9"
                  onClick={() => setSheet("eigenbeleg")}
                  data-testid="open-eigenbeleg"
                >
                  <FileSignatureIcon aria-hidden="true" />
                  {t("eigenbeleg")}
                </Button>
              )}
              {v.checkedComplete ? (
                <p className="text-muted-foreground text-xs">
                  {t("checkedAt", { date: formatDateTime(v.checkedComplete.at) })}
                </p>
              ) : (
                <Button
                  variant="ghost"
                  className="h-11 md:h-9"
                  onClick={() => void run(() => checked({ id }), t("checked"))}
                >
                  <CheckCheckIcon aria-hidden="true" />
                  {t("markChecked")}
                </Button>
              )}
            </div>
          )}
        </aside>
      </div>

      {booking && (
        <BookDialog
          id={id}
          version={seenVersion.current}
          direction={form.direction}
          corporation={options?.corporation ?? false}
          onClose={() => setBooking(false)}
          onBooked={() => onBooked?.()}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t("deleteDraft")}
          description={t("deleteConfirm")}
          confirmLabel={t("deleteDraft")}
          destructive
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            const r = await run(() => remove({ id }), t("deleted"));
            setDeleting(false);
            if (r.ok) {
              if (onDeleted) onDeleted();
              else router.push("/belege");
            }
          }}
        />
      )}
      {sheet === "bewirtung" && (
        <BewirtungSheet
          id={id}
          stored={(v.bewirtung as never) ?? null}
          documentDate={form.documentDate}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "eigenbeleg" && <EigenbelegSheet id={id} onClose={() => setSheet(null)} />}
      {correcting && (
        <ConfirmDialog
          title={td("correct")}
          description={td("correctHint")}
          confirmLabel={td("correct")}
          confirmDisabled={reason.trim().length < 5 || saving || (ackCodes !== null && !ack)}
          onClose={() => setCorrecting(false)}
          onConfirm={submitCorrection}
        >
          <ReasonField label={td("correctReason")} value={reason} onChange={setReason} />
          {correctError && (
            <p role="alert" className="text-danger text-sm">
              {correctError}
            </p>
          )}
          {ackCodes && <CheckboxInput label={tb("acknowledge")} checked={ack} onChange={setAck} />}
        </ConfirmDialog>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className={strong ? "font-semibold" : "text-muted-foreground"}>{label}</span>
      <span className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>{value}</span>
    </div>
  );
}

function LinesSection({
  form,
  amountLabel,
  accountOptions,
  issueFor,
  patchLine,
  onAdd,
  onRemove,
  suggestion,
}: {
  form: VoucherForm;
  amountLabel: string;
  accountOptions: (current: string) => { value: string; label: string }[];
  issueFor: (field: string) => string | undefined;
  patchLine: (i: number, p: Partial<VoucherForm["lines"][number]>) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  suggestion: { label: string; apply: () => void } | null;
}) {
  const t = useTranslations("vouchers.editor");
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border p-4"
      data-testid="voucher-lines"
    >
      <h2 id={headingId} className="font-semibold text-base">
        {t("sections.lines")}
      </h2>
      {suggestion && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{suggestion.label}</span>
          <Button type="button" variant="outline" className="h-11 md:h-9" onClick={suggestion.apply}>
            {t("applySuggestion")}
          </Button>
        </div>
      )}
      {form.lines.map((l, i) => (
        <fieldset
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional until saved
          key={i}
          className="@container/form grid gap-3 rounded-lg border p-3 @lg/form:grid-cols-6"
          data-line={i}
        >
          <legend className="px-1 text-muted-foreground text-xs">{t("line.label", { n: i + 1 })}</legend>
          <SelectInput
            className="@lg/form:col-span-3"
            label={t("line.account")}
            value={l.account}
            onChange={(account) => patchLine(i, { account })}
            options={accountOptions(l.account)}
            testId={`line-${i}-account`}
          />
          <TextInput
            className="@lg/form:col-span-3"
            label={t("line.description")}
            value={l.description}
            onChange={(description) => patchLine(i, { description })}
          />
          <TextInput
            className="@lg/form:col-span-2"
            label={amountLabel}
            inputMode="decimal"
            value={l.amount}
            error={issueFor(`lines.${i}.amount`)}
            onChange={(amount) => patchLine(i, { amount })}
            testId={`line-${i}-amount`}
          />
          <TextInput
            label={t("line.rate")}
            inputMode="decimal"
            value={l.rate}
            error={issueFor(`lines.${i}.rate`)}
            onChange={(rate) => patchLine(i, { rate })}
            testId={`line-${i}-rate`}
          />
          <TextInput
            label={t("line.vat")}
            hint={t("line.vatHint")}
            inputMode="decimal"
            value={l.vat}
            error={issueFor(`lines.${i}.vat`)}
            onChange={(vat) => patchLine(i, { vat })}
          />
          <TextInput
            className="@lg/form:col-span-2"
            label={t("line.nonDeductible")}
            inputMode="decimal"
            value={l.nonDeductible}
            error={issueFor(`lines.${i}.nonDeductible`)}
            onChange={(nonDeductible) => patchLine(i, { nonDeductible })}
          />
          {form.lines.length > 1 && (
            <div className="flex items-end @lg/form:col-span-6 @lg/form:justify-end">
              <Button type="button" variant="ghost" className="h-11 md:h-9" onClick={() => onRemove(i)}>
                <Trash2Icon aria-hidden="true" />
                {t("line.remove", { n: i + 1 })}
              </Button>
            </div>
          )}
        </fieldset>
      ))}
      <Button type="button" variant="outline" className="h-11 self-start md:h-9" onClick={onAdd} data-testid="add-line">
        <PlusIcon aria-hidden="true" />
        {t("addLine")}
      </Button>
    </section>
  );
}
