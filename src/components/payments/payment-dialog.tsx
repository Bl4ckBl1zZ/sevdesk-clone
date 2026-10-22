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
type Means = "bank" | "cash" | "other";
type Diff = "none" | "skonto" | "bank_fees" | "write_off" | "other";

const daysBack = (date: string, today: string) =>
  Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);

/**
 * „Zahlung buchen“ (F05 §6.1, 04 §4.11): „Bezahlt mit“ Bank · Bar · Andere, date (fixed by a chosen bank
 * transaction), amount (default = open), the difference choice (Skonto only within the period, PAY-021/022), the
 * PAY-030 excess choice, the cash dating rules (PAY-061) and the live booking preview (PAY-015) from the same
 * domain planning the act uses.
 */
export function PaymentDialog({
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
  onRecorded: (r: { paymentIds: string[]; cash: boolean }) => void;
}) {
  const t = useTranslations("payments.dialog");
  const run = useRun();
  const record = useMutation(api.payments.recordForInvoice);
  const open = data.settlement.openAmountCents;
  const unmatched = useAuthedQuery(api.banking.unmatched, {});
  const [means, setMeans] = useState<Means>("bank");
  const defaultAccount = data.accounts.find((a) => a.isDefault) ?? data.accounts[0];
  const [accountId, setAccountId] = useState<string>(defaultAccount?.id ?? "");
  const [txId, setTxId] = useState<string>("");
  const [date, setDate] = useState<string>(data.today);
  const [amountText, setAmountText] = useState(formatCents(open));
  const [diff, setDiff] = useState<Diff>("none");
  const [writeOffReason, setWriteOffReason] = useState<"insolvency" | "uncollectible" | "statute_barred" | "waiver">(
    "uncollectible",
  );
  const [otherText, setOtherText] = useState("");
  const [otherAccount, setOtherAccount] = useState("");
  const [excessMode, setExcessMode] = useState<"credit" | "unallocated">("credit");
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
    otherText: useId(),
    otherAccount: useId(),
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
  const incoming = (unmatched ?? []).filter((x) => x.direction === "in" && x.currency === "EUR");
  const tx = incoming.find((x) => x.id === txId);
  const effectiveDate = tx ? tx.bookingDate : date;
  const shortfall = amountCents !== null ? open - amountCents : 0;
  const excess = amountCents !== null && amountCents > open ? amountCents - open : 0;
  const skontoOk = Boolean(data.skonto && effectiveDate <= data.skonto.date && open === data.settlement.payableCents);
  const source =
    means === "cash"
      ? { kind: "cash" as const }
      : tx
        ? { kind: "bank" as const, transactionId: tx.id as Id<"bankTransactions"> }
        : { kind: "clearing" as const, accountId: accountId as Id<"bankAccounts"> };
  const differences =
    shortfall > 0 && diff !== "none"
      ? [
          diff === "write_off"
            ? { reason: "write_off" as const, amountCents: shortfall, subReason: writeOffReason }
            : diff === "other"
              ? { reason: "other" as const, amountCents: shortfall, text: otherText, account: otherAccount }
              : { reason: diff, amountCents: shortfall },
        ]
      : undefined;
  const cashBack = means === "cash" ? daysBack(effectiveDate, data.today) : 0;
  const args = {
    documentId,
    source,
    date: effectiveDate,
    amountCents: amountCents ?? 0,
    ...(differences ? { differences } : {}),
    ...(excess > 0 ? { excess: { mode: means === "cash" ? ("credit" as const) : excessMode } } : {}),
    ...(cashBack > 10 && backdateReason.trim() ? { backdateReason: backdateReason.trim() } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
    acknowledgeWarnings: ack,
  };
  const ready = amountCents !== null && amountCents > 0 && (means === "cash" || Boolean(accountId) || Boolean(tx));
  const preview = useAuthedQuery(api.payments.previewInvoicePayment, args, ready);
  const warnings = preview?.ok ? preview.plan.warnings.filter((w) => w.ack) : [];
  const info = preview?.ok ? preview.plan.warnings.filter((w) => !w.ack) : [];
  const allAcked = warnings.every((w) => ack.includes(w.code));

  return (
    <ConfirmDialog
      title={t("title", { number })}
      description={t("open", { amount: money(open) })}
      confirmLabel={t("confirm")}
      confirmDisabled={!ready || !preview?.ok || !allAcked}
      onConfirm={async () => {
        const r = await run(() => record(args), t("done"));
        if (r.ok) onRecorded({ paymentIds: r.value.paymentIds, cash: means === "cash" });
      }}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3" data-testid="payment-dialog">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 font-medium text-sm">{t("paidWith")}</legend>
          <div role="radiogroup" aria-label={t("paidWith")} className="grid grid-cols-3 gap-1 rounded-lg border p-1">
            {(["bank", "cash", "other"] as const).map((m) => (
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
        {means !== "cash" && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.account} className="font-medium text-sm">
              {t("account")}
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
        {means === "bank" && incoming.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.tx} className="font-medium text-sm">
              {t("transaction")}
            </label>
            <select id={ids.tx} className={selectClass} value={txId} onChange={(e) => setTxId(e.target.value)}>
              <option value="">{t("noTransaction")}</option>
              {incoming.map((x) => (
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
              {t("date")}
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
            {tx && <p className="text-muted-foreground text-xs">{t("dateFixed")}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.amount} className="font-medium text-sm">
              {t("amount")}
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
        {means === "cash" && cashBack > 1 && (
          <p role="status" className="rounded-md border border-warning/40 bg-warning/5 p-2 text-sm">
            {t("cashDaily")}
          </p>
        )}
        {means === "cash" && cashBack > 10 && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.reason} className="font-medium text-sm">
              {t("backdateReason")}
            </label>
            <Textarea id={ids.reason} value={backdateReason} onChange={(e) => setBackdateReason(e.target.value)} />
          </div>
        )}
        {shortfall > 0 && amountCents !== null && amountCents > 0 && (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 font-medium text-sm">{t("difference", { amount: money(shortfall) })}</legend>
            {(["none", "skonto", "bank_fees", "write_off", "other"] as const).map((d) =>
              d === "skonto" && !data.skonto ? null : (
                <label key={d} className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
                  <input
                    type="radio"
                    className="size-5 accent-primary md:size-4"
                    checked={diff === d}
                    disabled={d === "skonto" && !skontoOk}
                    onChange={() => setDiff(d)}
                  />
                  {d === "skonto" && data.skonto
                    ? t("diff.skontoUntil", {
                        percent: (data.skonto.percentBp / 100).toLocaleString("de-DE"),
                        date: formatDate(data.skonto.date),
                      }) + (skontoOk ? "" : ` – ${t("diff.skontoLate")}`)
                    : t(`diff.${d}`)}
                </label>
              ),
            )}
            {diff === "write_off" && (
              <select
                aria-label={t("writeOffReason")}
                className={selectClass}
                value={writeOffReason}
                onChange={(e) => setWriteOffReason(e.target.value as typeof writeOffReason)}
              >
                {(["insolvency", "uncollectible", "statute_barred", "waiver"] as const).map((r) => (
                  <option key={r} value={r}>
                    {t(`writeOff.${r}`)}
                  </option>
                ))}
              </select>
            )}
            {diff === "other" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  id={ids.otherText}
                  aria-label={t("otherText")}
                  placeholder={t("otherText")}
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  className="h-11 md:h-9"
                />
                <Input
                  id={ids.otherAccount}
                  aria-label={t("otherAccount")}
                  placeholder={t("otherAccount")}
                  value={otherAccount}
                  onChange={(e) => setOtherAccount(e.target.value)}
                  className="h-11 md:h-9"
                />
              </div>
            )}
          </fieldset>
        )}
        {excess > 0 && (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 font-medium text-sm">{t("excess", { amount: money(excess) })}</legend>
            <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
              <input
                type="radio"
                className="size-5 accent-primary md:size-4"
                checked={means === "cash" || excessMode === "credit"}
                onChange={() => setExcessMode("credit")}
              />
              {t("excessCredit")}
            </label>
            {tx && (
              <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
                <input
                  type="radio"
                  className="size-5 accent-primary md:size-4"
                  checked={excessMode === "unallocated"}
                  onChange={() => setExcessMode("unallocated")}
                />
                {t("excessUnallocated")}
              </label>
            )}
          </fieldset>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.note} className="font-medium text-sm">
            {t("note")}
          </label>
          <Input id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} className="h-11 md:h-9" />
        </div>
        {preview && !preview.ok && (
          <p role="alert" className="text-danger text-sm" data-testid="payment-error">
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
          <details className="rounded-md border p-2 text-sm" open>
            <summary className="cursor-pointer font-medium">{t("preview")}</summary>
            {preview.plan.rows.map((row, i) => (
              <div key={`${row.target.kind}-${row.target.id}`} className="mt-2 flex flex-col gap-1">
                {row.differences
                  .filter((d) => d.vatCorrection?.some((c) => c.vatCents !== 0))
                  .map((d) => (
                    <p key={d.reason} className="text-muted-foreground text-xs">
                      {t("vatCorrection")}{" "}
                      {d.vatCorrection
                        ?.map(
                          (c) =>
                            `${c.rateBp / 100} %: ${t("net")} ${money(c.netCents)} · ${t("vat")} ${money(c.vatCents)}`,
                        )
                        .join(" · ")}
                    </p>
                  ))}
                <ul className="font-mono text-xs" data-testid="booking-preview">
                  {(() => {
                    const p = preview.postings[i];
                    if (p?.status !== "lines") return null;
                    return p.lines.map((l) => (
                      <li key={`${l.account}-${l.debitCents}-${l.creditCents}`}>
                        {l.account} {l.debitCents ? `${money(l.debitCents)} S` : `${money(l.creditCents)} H`}
                      </li>
                    ));
                  })()}
                </ul>
              </div>
            ))}
          </details>
        )}
      </div>
    </ConfirmDialog>
  );
}
