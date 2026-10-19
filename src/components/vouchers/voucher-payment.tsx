"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { useFreshAction } from "@/components/auth/fresh-action";
import { ConfirmDialog, formatDate, useCan, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PAYMENT_MESSAGES, PAYMENT_METHOD_DE, type VoucherPaymentMethod } from "@/domain/vouchers/payment-choice";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { CheckboxInput, TextArea, TextInput } from "./voucher-fields";
import {
  bookButtonLabel,
  type Direction,
  defaultPaymentForm,
  type PaymentForm,
  paymentInput,
  paymentMethodsFor,
} from "./voucher-form";
import { JournalPreview, money, VoucherCheckPanel } from "./voucher-shared";

type VId = Id<"vouchers">;

/** „Bezahlt mit“ segmented control (VOU-136): Bank (offen) · Karte/Lastschrift folgt · Bar · Privat. */
export function PaidWithControl({
  value,
  onChange,
  direction,
  corporation,
  allowed,
}: {
  value: PaymentForm;
  onChange: (p: PaymentForm) => void;
  direction: Direction;
  corporation: boolean;
  /** Restrict the methods (later payments offer Bar and Privat only). */
  allowed?: readonly VoucherPaymentMethod[];
}) {
  const t = useTranslations("vouchers.book");
  const groupId = useId();
  const methods = paymentMethodsFor(direction).filter((m) => !allowed || allowed.includes(m));
  const label = (m: VoucherPaymentMethod) =>
    m === "private" && corporation ? t("privateCorporation") : PAYMENT_METHOD_DE[m];
  return (
    <fieldset className="flex flex-col gap-3" data-testid="paid-with">
      <legend id={groupId} className="mb-1 font-medium text-sm">
        {t("paidWith")}
      </legend>
      <div role="radiogroup" aria-labelledby={groupId} className="grid gap-2 @md/form:grid-cols-2">
        {methods.map((m) => (
          <label
            key={m}
            className={cn(
              "flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm transition-colors",
              value.method === m ? "border-primary bg-primary/5" : "hover:bg-muted",
            )}
          >
            <input
              type="radio"
              name={groupId}
              value={m}
              className="accent-primary"
              checked={value.method === m}
              onChange={() => onChange({ ...value, method: m })}
            />
            {label(m)}
          </label>
        ))}
      </div>
      {value.method === "private" && corporation && (
        <p className="text-muted-foreground text-sm">{PAYMENT_MESSAGES.corporation}</p>
      )}
      {value.method !== "bank" && (
        <div className="grid gap-3 @md/form:grid-cols-2">
          <TextInput
            label={t("date")}
            type="date"
            value={value.date}
            hint={t("dateHint")}
            onChange={(date) => onChange({ ...value, date })}
            testId="payment-date"
          />
          <TextInput
            label={t("amount")}
            value={value.amount}
            inputMode="decimal"
            hint={t("amountHint")}
            onChange={(amount) => onChange({ ...value, amount })}
          />
          {value.method === "cash" && (
            <TextArea
              className="@md/form:col-span-2"
              label={t("backdateReason")}
              hint={t("backdateHint")}
              rows={2}
              value={value.backdateReason}
              onChange={(backdateReason) => onChange({ ...value, backdateReason })}
            />
          )}
        </div>
      )}
    </fieldset>
  );
}

/**
 * „Buchen“ dialog (VOU-007, VOU-136…138): the dry run with the chosen payment shows errors, ⚑ warnings to confirm,
 * the payment, the cash balance before/after and the Buchungssätze. Booking, journal and the cash/private payment are
 * one Convex transaction — a failed cash check books nothing.
 */
export function BookDialog({
  id,
  version,
  direction,
  corporation,
  initialMethod = "bank",
  onClose,
  onBooked,
}: {
  id: VId;
  version: number;
  direction: Direction;
  corporation: boolean;
  initialMethod?: VoucherPaymentMethod;
  onClose: () => void;
  onBooked?: (number: string) => void;
}) {
  const t = useTranslations("vouchers.book");
  const finalize = useMutation(api.vouchers.finalize);
  const run = useRun();
  const fresh = useFreshAction();
  const [pay, setPay] = useState<PaymentForm>(defaultPaymentForm(initialMethod));
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const { payment, issues } = paymentInput(pay);
  const preview = useAuthedQuery(api.vouchers.preview, { id, ...(payment ? { payment: payment as never } : {}) });
  const warnings = preview?.warnings ?? [];
  const blocked = !preview || preview.errors.length > 0 || issues.length > 0 || (warnings.length > 0 && !ack);

  const book = async () => {
    setBusy(true);
    const r = await run(() =>
      fresh(() =>
        finalize({
          id,
          version,
          ...(warnings.length > 0 ? { acknowledgeWarnings: warnings.map((w) => w.code) } : {}),
          ...(payment ? { payment: payment as never } : {}),
        }),
      ),
    );
    setBusy(false);
    if (r.ok) {
      toast.success(t("booked", { number: r.value.number }));
      onBooked?.(r.value.number);
      onClose();
    }
  };

  return (
    <ConfirmDialog
      title={t("title")}
      description={t("description")}
      confirmLabel={bookButtonLabel(pay.method)}
      confirmDisabled={blocked || busy}
      onConfirm={book}
      onClose={onClose}
    >
      <div className="@container/form flex flex-col gap-4" data-testid="book-dialog">
        <PaidWithControl value={pay} onChange={setPay} direction={direction} corporation={corporation} />
        {issues.map((i) => (
          <p key={i.field} className="text-danger text-sm">
            {i.message}
          </p>
        ))}
        {preview === undefined ? (
          <div className="h-24" aria-busy="true" />
        ) : (
          <>
            <VoucherCheckPanel
              check={{
                errors: preview.errors,
                warnings: preview.warnings,
                infos: preview.infos,
                inputVatAtRisk: preview.inputVatAtRisk,
              }}
            />
            {pay.method !== "bank" && (
              <p className="text-sm" data-testid="payment-summary">
                {PAYMENT_METHOD_DE[pay.method]} · {formatDate(preview.payment.date)} ·{" "}
                {money(preview.payment.amountCents)}
              </p>
            )}
            {preview.cash && (
              <p className="text-sm" data-testid="cash-balance">
                {t("cashBalance", {
                  before: money(preview.cash.balanceCents),
                  after: money(preview.cash.balanceAfterCents),
                })}
              </p>
            )}
            {warnings.length > 0 && (
              <CheckboxInput label={t("acknowledge")} checked={ack} onChange={setAck} testId="ack-warnings" />
            )}
            <JournalPreview journal={preview.journal} />
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}

/** Later „Bar/Privat bezahlt“ on an open voucher (VOU-131, VOU-137/138). */
export function LaterPaymentDialog({
  id,
  direction,
  corporation,
  onClose,
}: {
  id: VId;
  direction: Direction;
  corporation: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("vouchers.detail");
  const record = useMutation(api.vouchers.recordPayment);
  const run = useRun();
  const [pay, setPay] = useState<PaymentForm>(defaultPaymentForm("cash"));
  const { payment, issues } = paymentInput(pay);
  const submit = async () => {
    if (!payment || issues.length > 0) return;
    const p = payment as { method: "cash" | "private"; date?: string; amountCents?: number; backdateReason?: string };
    const r = await run(() => record({ id, ...p }), t("paymentRecorded"));
    if (r.ok) onClose();
  };
  return (
    <ConfirmDialog
      title={t("recordPayment")}
      confirmLabel={t("recordPayment")}
      confirmDisabled={!payment || issues.length > 0}
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="@container/form">
        <PaidWithControl
          value={pay}
          onChange={setPay}
          direction={direction}
          corporation={corporation}
          allowed={["cash", "private"]}
        />
      </div>
    </ConfirmDialog>
  );
}

/**
 * Bank debits matching an open voucher (VOU-131). When the voucher was already settled bar/privat, a match is not
 * offered; „Zahlung umbuchen“ reverses that payment and matches the debit in one step (VOU-139, EC-VOU-43).
 */
export function BankSuggestionsPanel({ id }: { id: VId }) {
  const t = useTranslations("vouchers.detail");
  const data = useAuthedQuery(api.vouchers.bankSuggestions, { id });
  const record = useMutation(api.vouchers.recordPayment);
  const rebook = useMutation(api.vouchers.rebookPayment);
  const canPay = useCan("vouchers.pay");
  const run = useRun();
  const [rebooking, setRebooking] = useState<Id<"bankTransactions"> | null>(null);
  const [reason, setReason] = useState("");
  const headingId = useId();
  if (!data) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-xl border p-4"
      data-testid="bank-suggestions"
    >
      <h2 id={headingId} className="font-semibold text-base">
        {t("bankSuggestions")}
      </h2>
      {data.alreadySettledLabel && <p className="text-muted-foreground text-sm">{data.alreadySettledLabel}</p>}
      {data.suggestions.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("noSuggestions")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.suggestions.map((s) => (
            <li
              key={s.transactionId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
            >
              <span className="min-w-0">
                {formatDate(s.bookingDate)} · {money(s.amountCents)} · {s.counterpartyName ?? s.purpose}
                <span className="ml-1 text-muted-foreground text-xs">({s.reasons.join(", ")})</span>
              </span>
              {canPay &&
                (data.alreadySettled ? (
                  <Button variant="outline" className="h-11 md:h-9" onClick={() => setRebooking(s.transactionId)}>
                    {t("rebook")}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    className="h-11 md:h-9"
                    onClick={() =>
                      void run(() => record({ id, method: "bank", transactionId: s.transactionId }), t("matched"))
                    }
                  >
                    {t("match")}
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      )}
      {rebooking && (
        <ConfirmDialog
          title={t("rebook")}
          description={t("rebookHint")}
          confirmLabel={t("rebook")}
          confirmDisabled={reason.trim().length < 5}
          onClose={() => setRebooking(null)}
          onConfirm={async () => {
            const r = await run(() => rebook({ id, transactionId: rebooking, reason: reason.trim() }), t("rebooked"));
            if (r.ok) setRebooking(null);
          }}
        >
          <ReasonField label={t("rebookReason")} value={reason} onChange={setReason} />
        </ConfirmDialog>
      )}
    </section>
  );
}

export function ReasonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        rows={3}
        className="rounded-md border border-input bg-background p-2 text-base md:text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid="reason"
      />
    </div>
  );
}
