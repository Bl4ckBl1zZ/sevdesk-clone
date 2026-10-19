"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { PauseIcon, PlayIcon, PlusIcon, RepeatIcon, ZapIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { FormDialog, formatDate, todayBerlin, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EmptyState } from "@/components/layout/empty-state";
import { ListLayout } from "@/components/layout/list-layout";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parseBasisPoints, parseCents } from "@/domain/money/parse";
import { RECURRING_VOUCHER_INTERVALS } from "@/domain/schemas/api/vouchers";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { SelectInput, TextInput } from "./voucher-fields";
import { money } from "./voucher-shared";

/**
 * „Wiederkehrende Belege“ (VOU-064/065): templates for rent, subscriptions and contracts. The nightly job (and
 * „Jetzt erzeugen“) creates one voucher per due date — as a draft, or booked only when the check is clean.
 */
type Interval = (typeof RECURRING_VOUCHER_INTERVALS)[number];

export function RecurringVouchers() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <RecurringInner />
    </ConvexGuard>
  );
}

function RecurringInner() {
  const t = useTranslations("vouchers.recurring");
  const rows = useAuthedQuery(api.vouchers.recurringList, {});
  const canWrite = useCan("vouchers.write");
  const update = useMutation(api.vouchers.updateRecurring);
  const runNow = useMutation(api.vouchers.generateRecurringNow);
  const run = useRun();
  const [creating, setCreating] = useState(false);
  const toolbar = canWrite && (
    <Button className="h-11 md:ml-auto md:h-9" onClick={() => setCreating(true)} data-testid="recurring-new">
      <PlusIcon aria-hidden="true" />
      {t("new")}
    </Button>
  );
  const gross = (r: NonNullable<typeof rows>[number]) =>
    r.template.priceMode === "gross" ? r.template.lines.reduce((s, l) => s + l.amountCents, 0) : null;
  if (rows === undefined) return <div className="h-64" aria-busy="true" />;
  const actions = (r: NonNullable<typeof rows>[number]) =>
    canWrite && (
      <div className="flex flex-wrap gap-1">
        <Button
          variant="ghost"
          className="h-11 md:h-9"
          onClick={async () => {
            const res = await run(() => runNow({ id: r._id }));
            if (res.ok) toast.success(t("runDone", { count: res.value.created.length }));
          }}
        >
          <ZapIcon aria-hidden="true" />
          {t("runNow")}
        </Button>
        <Button
          variant="ghost"
          className="h-11 md:h-9"
          onClick={() =>
            void run(() => update({ id: r._id, version: r.version, patch: { active: !r.active } }), t("updated"))
          }
        >
          {r.active ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
          {r.active ? t("pause") : t("resume")}
        </Button>
      </div>
    );
  return (
    <ListLayout
      toolbar={toolbar}
      table={
        rows.length > 0 && (
          <Table data-testid="recurring-vouchers-table">
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.name")}</TableHead>
                <TableHead>{t("columns.interval")}</TableHead>
                <TableHead>{t("columns.next")}</TableHead>
                <TableHead className="text-right">{t("columns.amount")}</TableHead>
                <TableHead>{t("columns.state")}</TableHead>
                <TableHead>{t("columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r._id}>
                  <TableCell className="font-medium">
                    {r.name}
                    {r.template.supplierName && (
                      <span className="block text-muted-foreground text-xs">{r.template.supplierName}</span>
                    )}
                  </TableCell>
                  <TableCell>{t(`intervals.${r.interval}`)}</TableCell>
                  <TableCell className="tabular-nums">{r.active ? formatDate(r.nextDate) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(gross(r), r.template.currency)}</TableCell>
                  <TableCell>{r.active ? t("active") : t("paused")}</TableCell>
                  <TableCell>{actions(r)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      }
      cards={rows.map((r) => (
        <article key={r._id} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col">
              <span className="font-medium">{r.name}</span>
              <span className="text-muted-foreground text-sm">
                {t(`intervals.${r.interval}`)} · {r.active ? formatDate(r.nextDate) : t("paused")}
              </span>
            </div>
            <span className="font-medium text-sm tabular-nums">{money(gross(r), r.template.currency)}</span>
          </div>
          {actions(r)}
        </article>
      ))}
    >
      {rows.length === 0 && <EmptyState icon={RepeatIcon} title={t("empty")} />}
      {creating && <RecurringDialog onClose={() => setCreating(false)} />}
    </ListLayout>
  );
}

function RecurringDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("vouchers.recurring");
  const create = useMutation(api.vouchers.createRecurring);
  const run = useRun();
  const [f, setF] = useState({
    name: "",
    supplierName: "",
    interval: "P1M" as Interval,
    firstDate: todayBerlin(),
    endDate: "",
    createAs: "draft" as "draft" | "open",
    account: "",
    amount: "",
    rate: "19",
    taxRule: "",
  });
  const options = useAuthedQuery(api.vouchers.options, {
    direction: "expense",
    taxRule: f.taxRule || "input_vat_deductible",
  });
  const taxRule = f.taxRule || (options?.ku ? "no_input_vat" : "input_vat_deductible");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = async (e?: React.BaseSyntheticEvent) => {
    e?.preventDefault();
    const amount = parseCents(f.amount.trim());
    const rate = parseBasisPoints(f.rate.trim() || "0");
    const errs: Record<string, string> = {};
    if (!f.name.trim()) errs.name = t("required");
    if (!amount.ok || amount.value <= 0) errs.amount = t("amountInvalid");
    if (!rate.ok) errs.rate = t("rateInvalid");
    if (!f.account) errs.account = t("required");
    setErrors(errs);
    if (Object.keys(errs).length > 0 || !amount.ok || !rate.ok) return;
    setBusy(true);
    const r = await run(
      () =>
        create({
          name: f.name.trim(),
          interval: f.interval,
          firstDate: f.firstDate,
          ...(f.endDate ? { endDate: f.endDate } : {}),
          createAs: f.createAs,
          template: {
            direction: "expense",
            kind: "standard",
            ...(f.supplierName.trim() ? { supplierName: f.supplierName.trim() } : {}),
            currency: "EUR",
            priceMode: "gross",
            taxRule: taxRule as never,
            lines: [
              { account: f.account, amountCents: amount.value, vatRateBp: rate.value, description: f.name.trim() },
            ],
          },
        }),
      t("created"),
    );
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <FormDialog
      title={t("new")}
      formId="recurring-voucher-form"
      onClose={onClose}
      onSubmit={submit}
      submitting={busy}
      wide
    >
      <div className="grid gap-4 @lg/form:grid-cols-2">
        <TextInput
          label={t("name")}
          value={f.name}
          error={errors.name}
          onChange={(name) => setF({ ...f, name })}
          required
        />
        <TextInput
          label={t("supplier")}
          value={f.supplierName}
          onChange={(supplierName) => setF({ ...f, supplierName })}
        />
        <SelectInput
          label={t("interval")}
          value={f.interval}
          onChange={(v) => setF({ ...f, interval: v as Interval })}
          options={RECURRING_VOUCHER_INTERVALS.map((i) => ({ value: i, label: t(`intervals.${i}`) }))}
        />
        <TextInput
          label={t("firstDate")}
          type="date"
          value={f.firstDate}
          onChange={(firstDate) => setF({ ...f, firstDate })}
        />
        <TextInput label={t("endDate")} type="date" value={f.endDate} onChange={(endDate) => setF({ ...f, endDate })} />
        <SelectInput
          label={t("createAs")}
          value={f.createAs}
          onChange={(v) => setF({ ...f, createAs: v as "draft" | "open" })}
          options={(["draft", "open"] as const).map((o) => ({ value: o, label: t(`createAsOptions.${o}`) }))}
        />
        <SelectInput
          label={t("taxRule")}
          value={taxRule}
          onChange={(v) => setF({ ...f, taxRule: v })}
          options={(options?.taxRules ?? [{ value: taxRule, label: taxRule }]).map((r) => ({
            value: r.value,
            label: r.label,
          }))}
        />
        <SelectInput
          label={t("account")}
          value={f.account}
          onChange={(account) => setF({ ...f, account })}
          options={[
            { value: "", label: "—" },
            ...(options?.accounts ?? []).map((a) => ({ value: a.number, label: `${a.number} – ${a.name}` })),
          ]}
          hint={errors.account}
        />
        <TextInput
          label={t("amount")}
          inputMode="decimal"
          value={f.amount}
          error={errors.amount}
          onChange={(amount) => setF({ ...f, amount })}
        />
        <TextInput
          label={t("rate")}
          inputMode="decimal"
          value={f.rate}
          error={errors.rate}
          onChange={(rate) => setF({ ...f, rate })}
        />
      </div>
    </FormDialog>
  );
}
