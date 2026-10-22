"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ConfirmDialog, formatDate, selectClass, todayBerlin, useRun } from "@/components/catalog/shared";
import { money } from "@/components/invoices/invoice-shared";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCents } from "@/domain/money/format";
import { parsePaymentAmount } from "@/domain/payments/amount";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type PaymentsData = FunctionReturnType<typeof api.payments.forDocument>;
type Means = "bank" | "cash";

const daysBack = (date: string, today: string) =>
  Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);

/**
 * „Erstattung erfassen“ on a Rechnungskorrektur (PAY-033 b, PAY-062): the open refund (= −open amount) goes back to
 * the customer by bank (an outgoing transaction, or the account manually) or „Bar erstattet“. Amount default = open
 * refund; the live check (`previewCorrectionRefund`) runs the same planning as the act — more than the open refund
 * (EC-PAY-33) and a negative cash balance (RI-11, EC-PAY-28) are rejected there.
 */
export function RefundDialog({
  documentId,
  number,
  data,
  onClose,
  onRecorded,
}: {
  documentId: Id<"salesDocuments">;
  number: string;
  data: PaymentsData;
  onClose: () => void;
  onRecorded: (r: { paymentId: string; cash: boolean }) => void;
}) {
  const t = useTranslations("payments.refundDialog");
  const td = useTranslations("payments.dialog");
  const run = useRun();
  const refund = useMutation(api.payments.refundCorrection);
  const openRefund = -data.settlement.openAmountCents;
  const unmatched = useAuthedQuery(api.banking.unmatched, {});
  const [means, setMeans] = useState<Means>("bank");
  const defaultAccount = data.accounts.find((a) => a.isDefault) ?? data.accounts[0];
  const [accountId, setAccountId] = useState<string>(defaultAccount?.id ?? "");
  const [txId, setTxId] = useState<string>("");
  const [date, setDate] = useState<string>(data.today);
  const [amountText, setAmountText] = useState(formatCents(openRefund));
  const [backdateReason, setBackdateReason] = useState("");
  const [note, setNote] = useState("");
  const [ack, setAck] = useState<string[]>([]);
  const ids = {
    means: useId(),
    account: useId(),
    tx: useId(),
    date: useId(),
    amount: useId(),
    reason: useId(),
    note: useId(),
  };

  // EC-PAY-38 / 04 §8: „1.234“ = 1.234,00 € (shown back), > 2 decimals rejected
  const parsed = parsePaymentAmount(amountText);
  const amountCents = parsed.ok ? parsed.value.cents : null;
  const amountHint =
    amountText.trim() === ""
      ? null
      : parsed.ok
        ? parsed.value.interpretation
          ? `= ${parsed.value.interpretation}`
          : null
        : parsed.error.message;
  const outgoing = (unmatched ?? []).filter((x) => x.direction === "out" && x.currency === "EUR");
  const tx = means === "bank" ? outgoing.find((x) => x.id === txId) : undefined;
  const effectiveDate = tx ? tx.bookingDate : date;
  const source =
    means === "cash"
      ? { kind: "cash" as const }
      : tx
        ? { kind: "bank" as const, transactionId: tx.id as Id<"bankTransactions"> }
        : { kind: "clearing" as const, accountId: accountId as Id<"bankAccounts"> };
  const cashBack = means === "cash" ? daysBack(effectiveDate, data.today) : 0;
  const args = {
    documentId,
    source,
    date: effectiveDate,
    amountCents: amountCents ?? 0,
    ...(cashBack > 10 && backdateReason.trim() ? { backdateReason: backdateReason.trim() } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
    acknowledgeWarnings: ack,
  };
  const ready = amountCents !== null && amountCents > 0 && (means === "cash" || Boolean(accountId) || Boolean(tx));
  const preview = useAuthedQuery(api.payments.previewCorrectionRefund, args, ready);
  const warnings = preview?.ok ? preview.warnings.filter((w) => w.ack) : [];
  const info = preview?.ok ? preview.warnings.filter((w) => !w.ack) : [];
  const allAcked = warnings.every((w) => ack.includes(w.code));

  return (
    <ConfirmDialog
      title={t("title", { number })}
      description={t("open", { amount: money(openRefund) })}
      confirmLabel={t("confirm")}
      confirmDisabled={!ready || !preview?.ok || !allAcked}
      onConfirm={async () => {
        const r = await run(() => refund(args), t("done"));
        if (r.ok) onRecorded({ paymentId: r.value.paymentId, cash: means === "cash" });
      }}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3" data-testid="refund-dialog">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 font-medium text-sm">{t("refundedWith")}</legend>
          <div
            role="radiogroup"
            aria-label={t("refundedWith")}
            className="grid grid-cols-2 gap-1 rounded-lg border p-1"
          >
            {(["bank", "cash"] as const).map((m) => (
              <label
                key={m}
                className="flex min-h-11 cursor-pointer items-center justify-center rounded-md text-sm has-checked:bg-primary has-checked:text-primary-foreground md:min-h-9"
              >
                <input
                  type="radio"
                  name={ids.means}
                  value={m}
                  className="sr-only"
                  checked={means === m}
                  onChange={() => {
                    setMeans(m);
                    setTxId("");
                    setAck([]);
                  }}
                />
                {t(`means.${m}`)}
              </label>
            ))}
          </div>
        </fieldset>
        {means === "bank" && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.account} className="font-medium text-sm">
              {td("account")}
            </label>
            <select
              id={ids.account}
              className={selectClass}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {means === "bank" && outgoing.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.tx} className="font-medium text-sm">
              {t("transaction")}
            </label>
            <select id={ids.tx} className={selectClass} value={txId} onChange={(e) => setTxId(e.target.value)}>
              <option value="">{td("noTransaction")}</option>
              {outgoing.map((x) => (
                <option key={x.id} value={x.id}>
                  {formatDate(x.bookingDate)} · {money(x.openCents)} · {x.counterpartyName ?? x.purpose.slice(0, 40)}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.date} className="font-medium text-sm">
              {td("date")}
            </label>
            <Input
              id={ids.date}
              type="date"
              max={todayBerlin()}
              value={effectiveDate}
              disabled={Boolean(tx)}
              onChange={(e) => {
                setDate(e.target.value);
                setAck([]);
              }}
              className="h-11 md:h-9"
            />
            {tx && <p className="text-muted-foreground text-xs">{td("dateFixed")}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.amount} className="font-medium text-sm">
              {td("amount")}
            </label>
            <Input
              id={ids.amount}
              inputMode="decimal"
              value={amountText}
              aria-invalid={amountText.trim() !== "" && !parsed.ok}
              aria-describedby={amountHint ? `${ids.amount}-hint` : undefined}
              onChange={(e) => setAmountText(e.target.value)}
              className="h-11 text-right tabular-nums md:h-9"
            />
            {amountHint && (
              <p
                id={`${ids.amount}-hint`}
                className={parsed.ok ? "text-muted-foreground text-xs" : "text-destructive text-xs"}
                data-testid="amount-hint"
              >
                {amountHint}
              </p>
            )}
          </div>
        </div>
        {means === "cash" && cashBack > 10 && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.reason} className="font-medium text-sm">
              {td("backdateReason")}
            </label>
            <Textarea id={ids.reason} value={backdateReason} onChange={(e) => setBackdateReason(e.target.value)} />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.note} className="font-medium text-sm">
            {td("note")}
          </label>
          <Input id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} className="h-11 md:h-9" />
        </div>
        {preview && !preview.ok && (
          <p role="alert" className="text-danger text-sm" data-testid="refund-error">
            {preview.message}
          </p>
        )}
        {warnings.map((w) => (
          <label key={w.code} className="flex items-start gap-2 rounded-md border border-warning/40 p-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-5 accent-primary md:size-4"
              checked={ack.includes(w.code)}
              onChange={(e) => setAck((a) => (e.target.checked ? [...a, w.code] : a.filter((x) => x !== w.code)))}
            />
            <span>{w.message}</span>
          </label>
        ))}
        {info.map((w) => (
          <p key={w.code} className="text-muted-foreground text-sm">
            {w.message}
          </p>
        ))}
        {preview?.ok && (
          <p className="text-muted-foreground text-sm" data-testid="refund-open-after">
            {t("openAfter", { amount: money(-preview.openAfterCents) })}
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}
