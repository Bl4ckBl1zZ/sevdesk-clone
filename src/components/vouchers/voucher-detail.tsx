"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { CopyIcon, LockIcon, PencilIcon, UndoIcon, WalletIcon } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useFreshAction } from "@/components/auth/fresh-action";
import { ConfirmDialog, formatDate, formatDateTime, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { DetailLayout, FactList, PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { type VoucherDetailData, VoucherEditor } from "./voucher-editor";
import { VoucherFiles, type VoucherFileView } from "./voucher-files";
import type { Direction } from "./voucher-form";
import { VoucherGirocode } from "./voucher-girocode";
import { BankSuggestionsPanel, LaterPaymentDialog, ReasonField } from "./voucher-payment";
import { money, VoucherStatusBadge } from "./voucher-shared";

type VId = Id<"vouchers">;

/** `/belege/[id]`: the draft editor, or the booked voucher with payments, Buchungen, files and corrections (F06 §6.3). */
export function VoucherDetail({ id }: { id: string }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <VoucherDetailInner id={id as VId} />
    </ConvexGuard>
  );
}

function VoucherDetailInner({ id }: { id: VId }) {
  const t = useTranslations("vouchers.detail");
  const te = useTranslations("vouchers.editor");
  const tNav = useTranslations("nav");
  const data = useAuthedQuery(api.vouchers.get, { id });
  const crumbs = [{ label: tNav("items.belege"), href: "/belege" as Route }];
  if (data === undefined) return <div className="h-96" aria-busy="true" />;
  if (data === null) {
    return (
      <>
        <PageHeader title={t("notFound")} breadcrumbs={crumbs} />
        <PageBody>
          <p role="alert">{t("notFound")}</p>
        </PageBody>
      </>
    );
  }
  const v = data.voucher;
  if (v.status === "draft") {
    return (
      <>
        <PageHeader
          title={te("draftTitle")}
          description={v.supplierName ?? undefined}
          breadcrumbs={[...crumbs, { label: te("draftTitle") }]}
        />
        <PageBody>
          <VoucherEditor data={data} />
        </PageBody>
      </>
    );
  }
  return <BookedVoucher data={data} crumbs={crumbs} />;
}

function BookedVoucher({ data, crumbs }: { data: VoucherDetailData; crumbs: { label: string; href: Route }[] }) {
  const t = useTranslations("vouchers.detail");
  const router = useRouter();
  const v = data.voucher;
  const id = v._id as VId;
  const canCorrect = useCan("vouchers.correct");
  const canWrite = useCan("vouchers.write");
  const canPay = useCan("vouchers.pay");
  const cancel = useMutation(api.vouchers.cancel);
  const duplicate = useMutation(api.vouchers.duplicate);
  const run = useRun();
  const fresh = useFreshAction();
  const options = useAuthedQuery(api.vouchers.options, { direction: v.direction, taxRule: v.taxRule });
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [paying, setPaying] = useState(false);
  const [reason, setReason] = useState("");
  const locked = !!v.lockedAt;
  const cancelled = v.status === "cancelled";
  const open = v.status === "open" || v.status === "scheduled" || v.status === "partially_paid";
  const number = v.internalNumber ?? "";
  const title = t("title", { number });

  if (editing) {
    return (
      <>
        <PageHeader title={t("correct")} description={title} breadcrumbs={[...crumbs, { label: number }]} />
        <PageBody>
          <p className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">{t("correctHint")}</p>
          <VoucherEditor data={data} mode="correct" onCorrectionDone={() => setEditing(false)} />
        </PageBody>
      </>
    );
  }

  const actions = (
    <div className="flex flex-wrap gap-2">
      {canCorrect && !locked && !cancelled && (
        <Button
          variant="outline"
          className="h-11 md:h-9"
          onClick={() => setEditing(true)}
          data-testid="voucher-correct"
        >
          <PencilIcon aria-hidden="true" />
          {t("correct")}
        </Button>
      )}
      {canCorrect && !cancelled && (
        <Button
          variant="outline"
          className="h-11 md:h-9"
          onClick={() => setCancelling(true)}
          data-testid="voucher-cancel"
        >
          <UndoIcon aria-hidden="true" />
          {t("cancel")}
        </Button>
      )}
      {canWrite && (
        <Button
          variant="outline"
          className="h-11 md:h-9"
          onClick={async () => {
            const r = await run(() => duplicate({ id }), t("duplicated"));
            if (r.ok) router.push(`/belege/${r.value}` as Route);
          }}
        >
          <CopyIcon aria-hidden="true" />
          {t("duplicate")}
        </Button>
      )}
    </div>
  );

  return (
    <>
      <PageHeader
        title={title}
        description={`${v.supplierName ?? ""} · ${v.statusLabel}`}
        breadcrumbs={[...crumbs, { label: number }]}
        actions={actions}
      />
      <DetailLayout
        aside={
          <FactList
            items={[
              { label: t("facts.number"), value: number },
              { label: t("facts.supplier"), value: v.supplierName ?? "—" },
              { label: t("facts.documentNumber"), value: v.documentNumber ?? "—" },
              { label: t("facts.documentDate"), value: formatDate(v.documentDate) },
              { label: t("facts.dueDate"), value: formatDate(v.dueDate) },
              { label: t("facts.taxRule"), value: v.taxRuleLabel },
              { label: t("facts.gross"), value: money(v.totals.grossCents, v.currency), numeric: true },
              { label: t("facts.open"), value: money(v.openAmountCents), numeric: true },
              { label: t("facts.bookedAt"), value: v.bookedAt ? formatDateTime(v.bookedAt) : "—" },
            ]}
          />
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <VoucherStatusBadge status={v.status} label={v.statusLabel} />
          {locked && (
            <span className="inline-flex items-center gap-1 text-muted-foreground text-sm">
              <LockIcon className="size-3.5" aria-hidden="true" />
              {t("locked")}
            </span>
          )}
        </div>
        <Payments data={data} />
        {open && canPay && (
          <Button
            variant="outline"
            className="h-11 self-start md:h-9"
            onClick={() => setPaying(true)}
            data-testid="record-payment"
          >
            <WalletIcon aria-hidden="true" />
            {t("recordPayment")}
          </Button>
        )}
        {data.girocode && (
          <VoucherGirocode
            payload={data.girocode}
            label={t("girocodeAlt", { amount: money(v.openAmountCents), name: v.payee?.name ?? v.supplierName ?? "" })}
          />
        )}
        {!cancelled && <BankSuggestionsPanel id={id} />}
        <Journal data={data} />
        <VoucherFiles
          id={id}
          files={data.files as unknown as VoucherFileView[]}
          eigenbelegFile={data.eigenbelegFile}
          bewirtungFile={data.bewirtungFile}
          canAdd={canWrite && !cancelled}
          canReplace={canWrite && !locked && !cancelled}
          reasonRequired
        />
      </DetailLayout>
      {paying && (
        <LaterPaymentDialog
          id={id}
          direction={v.direction as Direction}
          corporation={options?.corporation ?? false}
          onClose={() => setPaying(false)}
        />
      )}
      {cancelling && (
        <ConfirmDialog
          title={t("cancel")}
          description={t("cancelHint")}
          confirmLabel={t("cancel")}
          destructive
          confirmDisabled={reason.trim().length < 5}
          onClose={() => setCancelling(false)}
          onConfirm={async () => {
            const r = await run(() => fresh(() => cancel({ id, reason: reason.trim() })), t("cancelledToast"));
            if (r.ok) setCancelling(false);
          }}
        >
          <ReasonField label={t("cancelReason")} value={reason} onChange={setReason} />
        </ConfirmDialog>
      )}
    </>
  );
}

function Payments({ data }: { data: VoucherDetailData }) {
  const t = useTranslations("vouchers.detail");
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-xl border p-4"
      data-testid="voucher-payments"
    >
      <h2 id={headingId} className="font-semibold text-base">
        {t("payments")}
      </h2>
      {data.payments.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("noPayments")}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {data.payments.map((p) => (
            <li
              key={p.id}
              className={cn("flex justify-between gap-2", p.reversed && "text-muted-foreground line-through")}
            >
              <span>
                {formatDate(p.date)} · {p.sourceLabel}
                {p.reversed ? ` (${t("reversed")})` : ""}
              </span>
              <span className="tabular-nums">{money(p.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm">
        {t("openAmount")}: <span className="tabular-nums">{money(data.voucher.openAmountCents)}</span>
      </p>
    </section>
  );
}

function Journal({ data }: { data: VoucherDetailData }) {
  const t = useTranslations("vouchers.detail");
  const tb = useTranslations("vouchers.book");
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-xl border p-4"
      data-testid="voucher-journal"
    >
      <h2 id={headingId} className="font-semibold text-base">
        {t("journal")}
      </h2>
      {data.journal.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("journalEmpty")}</p>
      ) : (
        data.journal.map((e) => (
          <div key={e.id} className="flex flex-col gap-1 rounded-md border p-2 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-medium">
                #{e.seq} · {formatDate(e.date)} · {e.text}
              </span>
              <span className="text-muted-foreground text-xs">{e.source.label}</span>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="font-normal">{tb("account")}</th>
                  <th className="text-right font-normal">{tb("debit")}</th>
                  <th className="text-right font-normal">{tb("credit")}</th>
                </tr>
              </thead>
              <tbody>
                {e.lines.map((l, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: posting rows have no id and never reorder
                  <tr key={i}>
                    <td>
                      <span className="tabular-nums">{l.account}</span> {l.accountName}
                    </td>
                    <td className="text-right tabular-nums">{l.debitCents ? money(l.debitCents) : ""}</td>
                    <td className="text-right tabular-nums">{l.creditCents ? money(l.creditCents) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </section>
  );
}
