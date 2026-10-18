"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import { BanknoteIcon, PrinterIcon, Undo2Icon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ConfirmDialog, formatDate, useCan, useRun } from "@/components/catalog/shared";
import { money } from "@/components/invoices/invoice-shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { PaymentDialog } from "./payment-dialog";
import { RefundDialog } from "./refund-dialog";

const DIFF_LABEL: Record<string, string> = {
  skonto: "Skonto",
  bank_fees: "Bankgebühren",
  dunning_fees: "Mahngebühren",
  default_interest: "Verzugszinsen",
  write_off: "Forderungsausfall",
  other: "Preisminderung",
};

/** Opens the archived Quittung or downloads the „Kopie“ (PAY-063, EC-PAY-51). */
export function useReceipt() {
  const receipt = useAction(api.payments.receipt);
  const run = useRun();
  const t = useTranslations("payments");
  return async (paymentId: string) => {
    const r = await run(() => receipt({ paymentId: paymentId as Id<"payments"> }), t("receiptReady"));
    if (!r.ok) return;
    const href = r.value.url
      ? r.value.url
      : URL.createObjectURL(
          new Blob([Uint8Array.from(atob(r.value.pdfBase64 ?? ""), (c) => c.charCodeAt(0))], {
            type: "application/pdf",
          }),
        );
    const a = document.createElement("a");
    a.href = href;
    a.download = r.value.name;
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
  };
}

/**
 * Invoice detail „Zahlungen“ (F05 §6.2): history incl. reversals, „Zahlung buchen“, „Stornieren“, „Quittung drucken“;
 * on a credit correction with an open refund „Erstattung erfassen“ (PAY-033 b).
 */
export function PaymentsSection({ documentId, number }: { documentId: Id<"salesDocuments">; number: string }) {
  const t = useTranslations("payments");
  const data = useAuthedQuery(api.payments.forDocument, { documentId });
  const canWrite = useCan("payments.write");
  const canReverse = useCan("payments.reverse");
  const canReceipt = useCan("payments.receipt");
  const printReceipt = useReceipt();
  const [dialog, setDialog] = useState(false);
  const [refund, setRefund] = useState(false);
  const [reverse, setReverse] = useState<string | null>(null);
  const [lastCash, setLastCash] = useState<string | null>(null);
  if (!data) return null;
  const s = data.settlement;
  const differences = s.settledCents - s.receivedCents;
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4" aria-labelledby="payments-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="payments-heading" className="font-semibold text-base">
          {t("title")}
        </h2>
        {canWrite && s.openAmountCents > 0 && data.settlement.paymentStatus !== "written_off" && (
          <Button className="h-11 md:h-9" onClick={() => setDialog(true)} data-testid="record-payment">
            <BanknoteIcon aria-hidden="true" />
            {t("record")}
          </Button>
        )}
        {canWrite && s.openAmountCents < 0 && (
          <Button className="h-11 md:h-9" onClick={() => setRefund(true)} data-testid="record-refund">
            <BanknoteIcon aria-hidden="true" />
            {t("refund")}
          </Button>
        )}
      </div>
      {lastCash && canReceipt && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
          <span>{t("cashRecorded")}</span>
          <Button variant="outline" className="h-11 md:h-9" onClick={() => void printReceipt(lastCash)}>
            <PrinterIcon aria-hidden="true" />
            {t("printReceipt")}
          </Button>
        </div>
      )}
      {data.payments.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("none")}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="payment-history">
          {data.payments.map((p) => {
            const reversed = Boolean(p.reversedById);
            return (
              <li key={p.id} className="flex flex-col gap-1 rounded-md border p-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="tabular-nums">{formatDate(p.date)}</span>
                    <Badge variant="outline">{p.sourceLabel}</Badge>
                    {p.accountName && <span className="text-muted-foreground">{p.accountName}</span>}
                    {p.reversalOfId && <Badge variant="secondary">{t("reversal")}</Badge>}
                    {reversed && <Badge variant="secondary">{t("reversed")}</Badge>}
                    {p.match?.auto && <Badge variant="secondary">{t("autoMatched")}</Badge>}
                  </span>
                  <span className="font-medium tabular-nums">{money(p.amountCents)}</span>
                </div>
                {p.differences.length > 0 && (
                  <span className="flex flex-wrap gap-1">
                    {p.differences.map((d) => (
                      <Badge key={d.reason} variant="outline">
                        {DIFF_LABEL[d.reason] ?? d.reason} {money(d.amountCents)}
                      </Badge>
                    ))}
                  </span>
                )}
                {(p.reason || p.note || p.backdateReason) && (
                  <span className="text-muted-foreground">
                    {[p.reason, p.note, p.backdateReason].filter(Boolean).join(" · ")}
                  </span>
                )}
                <span className="flex flex-wrap gap-1">
                  {p.bankTransactionId && (
                    <Link
                      className="inline-flex min-h-11 items-center underline md:min-h-9"
                      href={`/bank/zuordnungen` as Route}
                    >
                      {t("openTransaction")}
                    </Link>
                  )}
                  {p.canPrintReceipt && canReceipt && !reversed && (
                    <Button variant="ghost" className="h-11 md:h-9" onClick={() => void printReceipt(p.id)}>
                      <PrinterIcon aria-hidden="true" />
                      {p.receipt ? t("printReceiptCopy") : t("printReceipt")}
                    </Button>
                  )}
                  {canReverse && !reversed && !p.reversalOfId && (
                    <Button variant="ghost" className="h-11 md:h-9" onClick={() => setReverse(p.id)}>
                      <Undo2Icon aria-hidden="true" />
                      {t("reverse")}
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <dl
        className="ml-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm"
        data-testid="settlement"
      >
        <dt className="text-muted-foreground">{t("payable")}</dt>
        <dd className="text-right tabular-nums">{money(s.payableCents)}</dd>
        <dt className="text-muted-foreground">{t("paid")}</dt>
        <dd className="text-right tabular-nums">{money(s.receivedCents)}</dd>
        {differences !== 0 && (
          <>
            <dt className="text-muted-foreground">{t("differences")}</dt>
            <dd className="text-right tabular-nums">{money(differences)}</dd>
          </>
        )}
        <dt className="font-semibold">{t("openAmount")}</dt>
        <dd className="text-right font-semibold tabular-nums" data-testid="open-amount">
          {money(s.openAmountCents)}
        </dd>
      </dl>
      {data.creditBalanceCents > 0 && (
        <p className="text-sm">{t("creditBalance", { amount: money(data.creditBalanceCents) })}</p>
      )}
      {dialog && (
        <PaymentDialog
          documentId={documentId}
          number={number}
          data={data}
          onClose={() => setDialog(false)}
          onRecorded={(r) => {
            setDialog(false);
            if (r.cash && r.paymentIds[0]) setLastCash(r.paymentIds[0]);
          }}
        />
      )}
      {refund && (
        <RefundDialog
          documentId={documentId}
          number={number}
          data={data}
          onClose={() => setRefund(false)}
          onRecorded={(r) => {
            setRefund(false);
            if (r.cash) setLastCash(r.paymentId);
          }}
        />
      )}
      {reverse && <ReverseDialog paymentId={reverse} onClose={() => setReverse(null)} />}
    </section>
  );
}

function ReverseDialog({ paymentId, onClose }: { paymentId: string; onClose: () => void }) {
  const t = useTranslations("payments");
  const run = useRun();
  const reverse = useMutation(api.payments.reverse);
  const [reason, setReason] = useState("");
  const id = useId();
  return (
    <ConfirmDialog
      title={t("reverseTitle")}
      description={t("reverseHint")}
      confirmLabel={t("reverse")}
      destructive
      confirmDisabled={reason.trim().length < 5}
      onConfirm={async () => {
        const r = await run(
          () => reverse({ paymentId: paymentId as Id<"payments">, reason: reason.trim() }),
          t("reversedDone"),
        );
        if (r.ok) onClose();
      }}
      onClose={onClose}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="font-medium text-sm">
          {t("reason")}
        </label>
        <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}
