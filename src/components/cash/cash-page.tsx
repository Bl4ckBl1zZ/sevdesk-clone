"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useConvex, useMutation } from "convex/react";
import { WalletIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { money } from "@/components/banking/shared";
import { ConfirmDialog, FormDialog, formatDate, todayBerlin, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { RadioCardGroup, SelectField, TextField } from "@/components/forms/fields";
import { EmptyState } from "@/components/layout/empty-state";
import { PageBody } from "@/components/layout/list-layout";
import { NoPosNotice } from "@/components/layout/no-pos-notice";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { parseCents } from "@/domain/money/parse";
import { type CashTransferFormValues, cashTransferFormSchema, emptyCashTransferForm } from "@/domain/schemas/banking";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * Kasse (F07 CSH-020…030, 04 §4.12): balance, movements with running balance (from the journal), „Bargeld eingezahlt /
 * entnommen“ with the live never-negative projection, cash transfers with Eigenbeleg and „Stornieren“, Kassenbericht
 * CSV. No cash income without an invoice (CSH-029).
 */
export function CashPage() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <CashPageInner />
    </ConvexGuard>
  );
}

function CashPageInner() {
  const t = useTranslations("cash");
  const data = useAuthedQuery(api.cash.overview, {});
  const canWrite = useCan("cash.write");
  const [dialog, setDialog] = useState(false);
  const [reverse, setReverse] = useState<Id<"cashTransfers"> | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  if (data === undefined) return <PageBody aria-busy="true" className="h-96" />;
  return (
    <PageBody className="@container/cash">
      <NoPosNotice />
      <section
        aria-labelledby="cash-balance"
        className="flex flex-wrap items-end justify-between gap-4 rounded-xl border p-4"
      >
        <div className="flex flex-col">
          <h2 id="cash-balance" className="text-muted-foreground text-sm">
            {t("balance")}
          </h2>
          <p className="font-semibold text-3xl tabular-nums" data-testid="cash-balance">
            {money(data.balanceCents)}
          </p>
          {data.account && <p className="text-muted-foreground text-xs">{t("account", { account: data.account })}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && (
            <Button className="h-11 md:h-9" onClick={() => setDialog(true)}>
              {t("transfer")}
            </Button>
          )}
          <Button variant="outline" className="h-11 md:h-9" onClick={() => setReportOpen(true)}>
            {t("report")}
          </Button>
        </div>
      </section>
      <p className="text-muted-foreground text-sm">{t("atmHint")}</p>

      <section aria-labelledby="cash-movements" className="flex flex-col gap-2">
        <h2 id="cash-movements" className="font-semibold text-base">
          {t("movements")}
        </h2>
        {data.rows.length === 0 ? (
          <EmptyState icon={WalletIcon} title={t("empty")} />
        ) : (
          <>
            <div className="hidden @3xl/cash:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.date")}</TableHead>
                    <TableHead>{t("columns.voucher")}</TableHead>
                    <TableHead>{t("columns.text")}</TableHead>
                    <TableHead className="text-right">{t("columns.in")}</TableHead>
                    <TableHead className="text-right">{t("columns.out")}</TableHead>
                    <TableHead className="text-right">{t("columns.balance")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((r) => (
                    <TableRow key={`${r.entryId}-${r.seq}-${r.inCents}-${r.outCents}`}>
                      <TableCell className="whitespace-nowrap">{formatDate(r.date)}</TableCell>
                      <TableCell>{r.voucher}</TableCell>
                      <TableCell>{r.text}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.inCents ? money(r.inCents) : ""}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.outCents ? money(r.outCents) : ""}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.balanceCents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <ul className="flex flex-col gap-2 @3xl/cash:hidden">
              {data.rows.map((r) => (
                <li
                  key={`${r.entryId}-${r.seq}-${r.inCents}-${r.outCents}`}
                  className="flex justify-between gap-3 rounded-lg border p-3 text-sm"
                >
                  <span className="flex flex-col">
                    <span className="font-medium">{r.text}</span>
                    <span className="text-muted-foreground">
                      {formatDate(r.date)} · {r.voucher}
                    </span>
                  </span>
                  <span className="flex flex-col items-end tabular-nums">
                    <span className={r.inCents ? "text-success" : ""}>
                      {r.inCents ? money(r.inCents) : `−${money(r.outCents)}`}
                    </span>
                    <span className="text-muted-foreground text-xs">{money(r.balanceCents)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {data.transfers.length > 0 && (
        <section aria-labelledby="cash-transfers" className="flex flex-col gap-2">
          <h2 id="cash-transfers" className="font-semibold text-base">
            {t("transfers")}
          </h2>
          <ul className="flex flex-col gap-2">
            {data.transfers.map((x) => (
              <li
                key={x.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
              >
                <span className="flex flex-col">
                  <span className="font-medium">
                    {x.reversalOfId ? t("reversalOf") : ""}
                    {t(`kind.${x.kind}`)} · {money(x.amountCents)}
                  </span>
                  <span className="text-muted-foreground">
                    {formatDate(x.date)}
                    {x.note && ` · ${x.note}`}
                    {x.eigenbeleg?.url && (
                      <>
                        {" · "}
                        <a href={x.eigenbeleg.url} target="_blank" rel="noreferrer" className="underline">
                          {t("eigenbeleg")}
                        </a>
                      </>
                    )}
                  </span>
                </span>
                {x.reversed ? (
                  <Badge variant="secondary">{t("reversed")}</Badge>
                ) : (
                  canWrite &&
                  !x.reversalOfId &&
                  !x.fromBank && (
                    <Button variant="outline" className="h-11 md:h-9" onClick={() => setReverse(x.id)}>
                      {t("reverse")}
                    </Button>
                  )
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialog && (
        <TransferDialog bankAccounts={data.bankAccounts} today={data.today} onClose={() => setDialog(false)} />
      )}
      {reverse && <ReverseDialog id={reverse} onClose={() => setReverse(null)} />}
      {reportOpen && <ReportDialog today={data.today} onClose={() => setReportOpen(false)} />}
    </PageBody>
  );
}

function TransferDialog({
  bankAccounts,
  today,
  onClose,
}: {
  bankAccounts: { id: Id<"bankAccounts">; name: string }[];
  today: string;
  onClose: () => void;
}) {
  const t = useTranslations("cash.dialog");
  const run = useRun();
  const record = useAction(api.cash.recordTransfer);
  const formId = useId();
  // The schema transforms to the API shape; the field helpers work on the form values (as in product-form).
  const form = useZodForm(cashTransferFormSchema, {
    ...emptyCashTransferForm(today),
    bankAccountId: bankAccounts[0]?.id ?? "",
  }) as unknown as UseFormReturn<CashTransferFormValues>;
  const kind = form.watch("kind");
  const date = form.watch("date");
  const amount = parseCents(form.watch("amount") || "0");
  const amountCents = amount.ok ? amount.value : 0;
  const projection = useAuthedQuery(
    api.cash.project,
    { date, amountCents },
    amountCents > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date),
  );
  const submit = form.handleSubmit(async () => {
    const { bankAccountId, ...values } = cashTransferFormSchema.parse(form.getValues());
    const r = await run(
      () =>
        record({
          ...values,
          ...(bankAccountId ? { bankAccountId: bankAccountId as Id<"bankAccounts"> } : {}),
        }),
      t("saved"),
    );
    if (r.ok) {
      if (r.value.warning) toast.warning(r.value.warning);
      onClose();
    }
  });
  return (
    <FormDialog
      title={t("title")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
    >
      <RadioCardGroup
        form={form}
        name="kind"
        label={t("kind")}
        options={[
          { value: "deposit_to_bank", label: t("deposit"), hint: t("depositHint") },
          { value: "private_withdrawal", label: t("withdrawal"), hint: t("withdrawalHint") },
        ]}
      />
      <TextField form={form} name="amount" label={t("amount")} required inputMode="decimal" className="text-lg" />
      <TextField form={form} name="date" label={t("date")} type="date" required max={todayBerlin()} />
      {kind === "deposit_to_bank" && (
        <SelectField
          form={form}
          name="bankAccountId"
          label={t("bankAccount")}
          required
          options={bankAccounts.map((a) => ({ value: a.id, label: a.name }))}
        />
      )}
      {kind === "private_withdrawal" && (
        <>
          <TextField form={form} name="shareholderName" label={t("shareholder")} description={t("shareholderHint")} />
          <TextField form={form} name="shareholderNote" label={t("shareholderNote")} />
        </>
      )}
      <TextField form={form} name="note" label={t("note")} />
      <TextField form={form} name="backdateReason" label={t("backdateReason")} description={t("backdateHint")} />
      {projection && amountCents > 0 && (
        <p role="status" className={projection.ok ? "text-muted-foreground text-sm" : "text-danger text-sm"}>
          {projection.ok
            ? t("projection", { amount: money(projection.minBalanceCents), date: formatDate(projection.minDate) })
            : t("projectionNegative", {
                amount: money(projection.minBalanceCents),
                date: formatDate(projection.minDate),
              })}
        </p>
      )}
    </FormDialog>
  );
}

function ReverseDialog({ id, onClose }: { id: Id<"cashTransfers">; onClose: () => void }) {
  const t = useTranslations("cash");
  const run = useRun();
  const reverse = useMutation(api.cash.reverseTransfer);
  const reasonId = useId();
  const [reason, setReason] = useState("");
  return (
    <ConfirmDialog
      title={t("reverseTitle")}
      description={t("reverseHint")}
      confirmLabel={t("reverse")}
      destructive
      confirmDisabled={reason.trim().length < 5}
      onClose={onClose}
      onConfirm={async () => {
        const r = await run(() => reverse({ id, reason }), t("reversedToast"));
        if (r.ok) onClose();
      }}
    >
      <label htmlFor={reasonId} className="font-medium text-sm">
        {t("reason")}
      </label>
      <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} />
    </ConfirmDialog>
  );
}

function ReportDialog({ today, onClose }: { today: string; onClose: () => void }) {
  const t = useTranslations("cash");
  const convex = useConvex();
  const run = useRun();
  const fromId = useId();
  const toId = useId();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  return (
    <ConfirmDialog
      title={t("reportTitle")}
      description={t("reportHint")}
      confirmLabel={t("reportDownload")}
      onClose={onClose}
      onConfirm={async () => {
        const r = await run(() => convex.query(api.cash.reportCsv, { from, to }));
        if (!r.ok) return;
        const blob = new Blob([r.value.csv], { type: "text/csv;charset=utf-8" });
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = `kassenbericht-${from}-${to}.csv`;
        a.click();
        URL.revokeObjectURL(href);
        onClose();
      }}
    >
      <div className="grid grid-cols-2 gap-2 text-sm">
        <label htmlFor={fromId}>{t("from")}</label>
        <label htmlFor={toId}>{t("to")}</label>
        <Input id={fromId} type="date" className="h-11 md:h-9" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input id={toId} type="date" className="h-11 md:h-9" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}
