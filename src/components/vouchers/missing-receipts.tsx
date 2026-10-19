"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { FileSignatureIcon, UploadIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { ConfirmDialog, formatDate, useCan, useRun, useUrlState } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EmptyState } from "@/components/layout/empty-state";
import { PageBody, StatusFilter } from "@/components/layout/list-layout";
import { Button } from "@/components/ui/button";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { ReasonField } from "./voucher-payment";
import { money, useVoucherUpload, VoucherStatusBadge } from "./voucher-shared";
import { voucherPath } from "./vouchers-list";

/**
 * „Fehlende Belege“ (VOU-110, F06 §6.5): (a) bank transactions without a voucher — upload a receipt (a draft
 * prefilled from the transaction; the debit is matched after booking), create an Eigenbeleg, or „Beleg nicht
 * erforderlich“ with a reason; (b) overdue open vouchers; (c) recurring vouchers without a bank debit.
 */
const TABS = ["transactions", "overdue", "recurring"] as const;
type Tab = (typeof TABS)[number];

export function MissingReceipts() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <MissingInner />
    </ConvexGuard>
  );
}

function MissingInner() {
  const t = useTranslations("vouchers.missing");
  const url = useUrlState();
  const router = useRouter();
  const tab: Tab = (TABS as readonly string[]).includes(url.get("tab")) ? (url.get("tab") as Tab) : "transactions";
  const data = useAuthedQuery(api.vouchers.missing, {});
  const canWrite = useCan("vouchers.write");
  const upload = useVoucherUpload();
  const create = useMutation(api.vouchers.create);
  const update = useMutation(api.vouchers.updateDraft);
  const waive = useMutation(api.vouchers.waiveReceipt);
  const run = useRun();
  const fileRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<NonNullable<typeof data>["transactions"][number] | null>(null);
  const [waiving, setWaiving] = useState<Id<"bankTransactions"> | null>(null);
  const [reason, setReason] = useState("");

  type Tx = NonNullable<typeof data>["transactions"][number];
  const prefill = (tx: Tx, kind?: "eigenbeleg") => ({
    direction: tx.amountCents < 0 ? ("expense" as const) : ("income" as const),
    documentDate: tx.bookingDate,
    ...(tx.counterpartyName ? { supplierName: tx.counterpartyName } : {}),
    ...(kind ? { kind } : {}),
    internalNote: tx.purpose,
  });

  const counts = {
    transactions: data?.transactions.length,
    overdue: data?.overdue.length,
    recurring: data?.recurringWithoutDebit.length,
  };
  const filters = (
    <StatusFilter
      label={t("tabsLabel")}
      current={tab}
      options={TABS.map((s) => ({
        value: s,
        label: t(`tabs.${s}`),
        ...(counts[s] !== undefined ? { count: counts[s] } : {}),
        href: url.hrefWith({ tab: s === "transactions" ? "" : s }),
      }))}
    />
  );
  if (!data) {
    return (
      <PageBody>
        {filters}
        <div className="h-64" aria-busy="true" />
      </PageBody>
    );
  }
  const rows = tab === "overdue" ? data.overdue : data.recurringWithoutDebit;
  return (
    <PageBody>
      {filters}
      {tab === "transactions" ? (
        data.transactions.length === 0 ? (
          <EmptyState icon={FileSignatureIcon} title={t("none")} />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="missing-transactions">
            {data.transactions.map((tx) => (
              <li
                key={tx.id}
                className="flex flex-col gap-2 rounded-lg border p-3 @3xl/main:flex-row @3xl/main:items-center"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">
                    {tx.counterpartyName ?? tx.purpose} · <span className="tabular-nums">{money(tx.amountCents)}</span>
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {formatDate(tx.bookingDate)} · {tx.purpose}
                  </span>
                  {tx.suggestions.length > 0 && (
                    <span className="flex flex-wrap gap-2 text-sm">
                      {tx.suggestions.map((s) => (
                        <Link
                          key={s.id}
                          href={voucherPath(s.id)}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {t("takeSuggestion")} ({money(s.grossCents)})
                        </Link>
                      ))}
                    </span>
                  )}
                </div>
                {canWrite && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      className="h-11 md:h-9"
                      onClick={() => {
                        setTarget(tx);
                        fileRef.current?.click();
                      }}
                    >
                      <UploadIcon aria-hidden="true" />
                      {t("upload")}
                    </Button>
                    <Button
                      variant="outline"
                      className="h-11 md:h-9"
                      onClick={async () => {
                        const r = await run(() => create({ input: prefill(tx, "eigenbeleg") }));
                        if (r.ok) router.push(voucherPath(r.value));
                      }}
                    >
                      {t("eigenbeleg")}
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-11 md:h-9"
                      onClick={() => setWaiving(tx.id as Id<"bankTransactions">)}
                    >
                      {t("waive")}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )
      ) : rows.length === 0 ? (
        <EmptyState icon={FileSignatureIcon} title={t("none")} />
      ) : (
        <ul className="flex flex-col gap-2" data-testid={`missing-${tab}`}>
          {rows.map((r) => (
            <li key={r._id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="flex min-w-0 flex-col items-start gap-1">
                <Link href={voucherPath(r._id)} className="font-medium hover:underline">
                  {r.internalNumber ?? r.supplierName ?? "—"}
                </Link>
                <span className="text-muted-foreground text-sm">
                  {r.supplierName ?? "—"} · {formatDate(r.dueDate ?? r.documentDate)}
                </span>
                <VoucherStatusBadge status={r.status} label={r.statusLabel} overdue={r.overdue} />
              </div>
              <span className="font-medium text-sm tabular-nums">{money(r.openAmountCents)}</span>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/*,.xml,application/xml"
        capture="environment"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file || !target) return;
          const r = await run(async () => {
            const up = await upload(file);
            await update({ id: up.voucherId, input: prefill(target) });
            return up.voucherId;
          });
          setTarget(null);
          if (r.ok) router.push(voucherPath(r.value) as Route);
        }}
      />
      {waiving && (
        <ConfirmDialog
          title={t("waiveTitle")}
          description={t("waiveHint")}
          confirmLabel={t("waive")}
          confirmDisabled={reason.trim().length < 5}
          onClose={() => setWaiving(null)}
          onConfirm={async () => {
            const r = await run(() => waive({ transactionId: waiving, reason: reason.trim() }), t("waived"));
            if (r.ok) {
              setWaiving(null);
              setReason("");
            }
          }}
        >
          <ReasonField label={t("waiveReason")} value={reason} onChange={setReason} />
        </ConfirmDialog>
      )}
    </PageBody>
  );
}
