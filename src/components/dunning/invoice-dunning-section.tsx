"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { ChevronDownIcon, SirenIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ConfirmDialog, formatDate, todayBerlin, useCan } from "@/components/catalog/shared";
import { money } from "@/components/invoices/invoice-shared";
import { FactList } from "@/components/layout/list-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { carriesReceivable } from "@/domain/documents/doc-types";
import type { SalesDocType } from "@/domain/documents/snapshot";
import type { CaseActionValues } from "@/domain/schemas/dunning";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import {
  CaseStatusBadge,
  DispatchStatus,
  LimitationBadge,
  ReminderStatusBadge,
  SectionCard,
  useWarningRetry,
} from "./dunning-shared";

type CaseAction = CaseActionValues["action"];

/**
 * Invoice detail „Mahnungen“ (DUN-010): case status, default start, limitation, all reminders with their dispatch
 * status, the next planned action, „Mahnung erstellen“ / „Nächste Mahnstufe“ and the case actions (DUN-034/042/043).
 */
export function InvoiceDunningSection({ invoiceId, type }: { invoiceId: string; type: SalesDocType }) {
  const t = useTranslations("dunning.invoice");
  const tPreview = useTranslations("dunning.preview");
  const router = useRouter();
  const data = useAuthedQuery(
    api.dunning.forInvoice,
    { invoiceId: invoiceId as Id<"salesDocuments"> },
    carriesReceivable(type),
  );
  const canWrite = useCan("dunning.write");
  const createReminder = useMutation(api.dunning.createReminder);
  const { exec, dialog } = useWarningRetry();
  const [action, setAction] = useState<CaseAction | null>(null);
  if (!data) return null;
  if (!data.dunnable && data.reminders.length === 0 && !data.case) return null;
  const active = data.reminders.filter((r) => r.status !== "cancelled");
  const status = data.case?.status ?? null;
  const closed = status === "closed" || status === "handed_over";
  const paused = status === "paused" || data.disputed !== null;
  const create = () =>
    void exec(
      (ack) =>
        createReminder({
          invoiceId: invoiceId as Id<"salesDocuments">,
          values: ack.length ? { acknowledgeWarnings: ack } : {},
        }),
      {
        success: t("created"),
        onSuccess: (r) => router.push(`/mahnungen/${r.id}` as Route),
        confirmLabel: t("createAnyway"),
      },
    );
  const caseActions: CaseAction[] = [];
  if (data.dunnable && !closed) {
    if (!paused) caseActions.push("pause");
    if (paused) caseActions.push("resume");
    if (!data.disputed) caseActions.push("dispute");
    caseActions.push(data.blocked ? "unblock" : "block");
    caseActions.push("hand_over");
  }
  return (
    <SectionCard
      title={t("title")}
      testId="invoice-dunning"
      actions={
        canWrite && data.dunnable ? (
          <>
            {!closed && (
              <Button className="h-11 md:h-9" onClick={create} data-testid="create-reminder">
                <SirenIcon aria-hidden="true" />
                {active.length > 0 ? t("nextLevel") : t("create")}
              </Button>
            )}
            {caseActions.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" className="h-11 md:h-9" />}>
                  {t("caseMenu")}
                  <ChevronDownIcon aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {caseActions.map((a) => (
                    <DropdownMenuItem key={a} onClick={() => setAction(a)}>
                      {t(`actions.${a}`)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <CaseStatusBadge status={status} />
        {data.disputed && <Badge variant="destructive">{t("disputed", { reason: data.disputed.reason })}</Badge>}
        {data.blocked && <Badge variant="outline">{t("blocked", { reason: data.blocked.reason })}</Badge>}
        {data.contactBlocked && <Badge variant="outline">{t("contactBlocked")}</Badge>}
        <LimitationBadge limitation={data.limitation} />
      </div>
      {data.zugangNotice && (data.dunnable || data.zugangNotice.severity === "I") && (
        <p
          role="status"
          data-testid="zugang-notice"
          className={
            data.zugangNotice.severity === "W"
              ? "rounded-md border border-warning/40 bg-warning/5 p-2 text-sm"
              : "text-muted-foreground text-sm"
          }
        >
          {data.zugangNotice.message}
        </p>
      )}
      <FactList
        items={[
          {
            label: t("defaultStart"),
            value: data.defaultStart ? data.defaultStart.label : data.zugang ? t("noDefault") : t("noZugang"),
          },
          { label: t("level"), value: String(data.case?.currentLevel ?? 0) },
          ...(data.case?.pausedUntil
            ? [{ label: t("pausedUntil"), value: formatDate(data.case.pausedUntil) }]
            : data.case?.pausedReason && status === "paused"
              ? [{ label: t("pausedReason"), value: data.case.pausedReason }]
              : []),
          ...(data.case?.handedOver
            ? [
                {
                  label: t("handedOver"),
                  value: data.case.handedOver.partner,
                },
              ]
            : []),
          ...(data.case?.graceUntil ? [{ label: t("graceUntil"), value: formatDate(data.case.graceUntil) }] : []),
          ...(data.limitation ? [{ label: t("limitation"), value: formatDate(data.limitation.date) }] : []),
          ...(data.next
            ? [
                {
                  label: t("next"),
                  value: (
                    <span className="flex flex-col" data-testid="next-action">
                      <span>
                        {tPreview(`kinds.${data.next.kind}`)}
                        {data.next.level ? ` · ${t("levelN", { level: data.next.level })}` : ""}
                        {data.next.earliestDate
                          ? ` · ${t("earliest", { date: formatDate(data.next.earliestDate) })}`
                          : ""}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {data.next.reasonLabel}
                        {data.next.detail ? ` – ${data.next.detail}` : ""}
                      </span>
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
      {data.reminders.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("noReminders")}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm" data-testid="invoice-reminders">
          {data.reminders.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
              <span className="flex min-w-0 flex-col">
                <span className="flex flex-wrap items-center gap-2">
                  <Link href={`/mahnungen/${r.id}` as Route} className="font-medium underline">
                    {r.number ?? t("draft")}
                  </Link>
                  <span>
                    {t("levelN", { level: r.level })} · {r.title}
                  </span>
                  <ReminderStatusBadge status={r.status} />
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatDate(r.documentDate)} · <DispatchStatus reminder={r} />
                </span>
              </span>
              <span className="font-medium tabular-nums">{money(r.totalCents)}</span>
            </li>
          ))}
        </ul>
      )}
      {action && <CaseActionDialog action={action} invoiceId={invoiceId} onClose={() => setAction(null)} exec={exec} />}
      {dialog}
    </SectionCard>
  );
}

/** Pausieren (optional date), Bestritten / Nicht mahnen (reason), An Inkasso übergeben (partner), Fortsetzen. */
function CaseActionDialog({
  action,
  invoiceId,
  onClose,
  exec,
}: {
  action: CaseAction;
  invoiceId: string;
  onClose: () => void;
  exec: ReturnType<typeof useWarningRetry>["exec"];
}) {
  const t = useTranslations("dunning.caseAction");
  const caseAction = useMutation(api.dunning.caseAction);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [partner, setPartner] = useState("");
  const ids = { reason: useId(), until: useId(), partner: useId() };
  const needsReason = action === "dispute" || action === "block";
  const disabled = (needsReason && reason.trim().length < 3) || (action === "hand_over" && partner.trim().length < 2);
  return (
    <ConfirmDialog
      title={t(`${action}.title`)}
      description={t(`${action}.description`)}
      confirmLabel={t(`${action}.confirm`)}
      destructive={action === "hand_over"}
      confirmDisabled={disabled}
      onClose={onClose}
      onConfirm={() =>
        void exec(
          (ack) =>
            caseAction({
              invoiceId: invoiceId as Id<"salesDocuments">,
              values: {
                action,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
                ...(until ? { until } : {}),
                ...(partner.trim() ? { partner: partner.trim() } : {}),
                ...(ack.length ? { acknowledgeWarnings: ack } : {}),
              },
            }),
          { success: t(`${action}.done`), onSuccess: onClose, confirmLabel: t("handOverAnyway") },
        )
      }
    >
      <div className="flex flex-col gap-3">
        {action === "pause" && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.until} className="font-medium text-sm">
              {t("until")}
            </label>
            <Input
              id={ids.until}
              type="date"
              min={todayBerlin()}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="h-11 md:h-9"
            />
          </div>
        )}
        {action === "hand_over" && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.partner} className="font-medium text-sm">
              {t("partner")}
            </label>
            <Input
              id={ids.partner}
              value={partner}
              onChange={(e) => setPartner(e.target.value)}
              className="h-11 md:h-9"
            />
          </div>
        )}
        {(needsReason || action === "pause" || action === "hand_over") && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.reason} className="font-medium text-sm">
              {needsReason ? t("reasonRequired") : t("reasonOptional")}
            </label>
            <Textarea id={ids.reason} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}
