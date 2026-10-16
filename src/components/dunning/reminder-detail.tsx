"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { CheckIcon, CircleAlertIcon, InfoIcon, LockIcon, SendIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, formatDate, formatDateTime, todayBerlin, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { money } from "@/components/invoices/invoice-shared";
import { DetailLayout, FactList, PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SEND_CHANNEL_LABELS, type SendChannel } from "@/domain/documents/dispatch";
import { DEFAULT_ROUTE_LABEL_DE, type DefaultRoute } from "@/domain/dunning/default-start";
import { formatCents } from "@/domain/money/format";
import { parseCents } from "@/domain/money/parse";
import { type ReminderCreateValues, reminderCreateSchema } from "@/domain/schemas/dunning";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import {
  type ReminderDetail as Detail,
  InterestSegments,
  ReminderExportMenu,
  ReminderMarkSentDialog,
  ReminderStatusBadge,
  SectionCard,
  useWarningRetry,
} from "./dunning-shared";

/** Reminder detail (F05 §6.5): the draft editor with compliance panel, or the finalised read-only reminder. */
export function ReminderDetail({ id }: { id: string }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <ReminderDetailInner id={id as Id<"salesDocuments">} />
    </ConvexGuard>
  );
}

function ReminderDetailInner({ id }: { id: Id<"salesDocuments"> }) {
  const t = useTranslations("dunning.reminder");
  const tNav = useTranslations("nav");
  const data = useAuthedQuery(api.dunning.reminder, { id });
  const canWrite = useCan("dunning.write");
  const crumbs = [{ label: tNav("items.mahnungen"), href: "/mahnungen" as Route }];
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
  const r = data.reminder;
  const draft = r.status === "draft";
  const title = draft ? t("draftTitle", { level: r.level }) : t("title", { number: r.number ?? "" });
  return (
    <>
      <PageHeader
        title={title}
        description={`${r.title} · ${r.contactName ?? ""} · ${t("forInvoice", { number: r.invoiceNumber ?? "—" })}`}
        breadcrumbs={[...crumbs, { label: draft ? t("draftCrumb") : (r.number ?? "") }]}
        actions={draft ? undefined : <FinalActions data={data} />}
      />
      <DetailLayout aside={<CompliancePanel data={data} />}>
        <div className="flex flex-wrap items-center gap-2">
          <ReminderStatusBadge status={r.status} />
          {!draft && (
            <span className="inline-flex items-center gap-1 text-muted-foreground text-sm">
              <LockIcon className="size-3.5" aria-hidden="true" />
              {t("locked")}
            </span>
          )}
        </div>
        {draft ? (
          canWrite ? (
            <DraftEditor key={r.version} data={data} />
          ) : (
            <>
              <p>{t("readOnlyDraft")}</p>
              <ClaimSummary data={data} />
            </>
          )
        ) : (
          <FinalView data={data} />
        )}
      </DetailLayout>
    </>
  );
}

// ── draft editor ────────────────────────────────────────────────────────────────────────────────────────────────

/** Only fields the user overrode are sent: the rest stays recomputed at finalisation (DUN-008, §4.5 step 7). */
export function draftValues(
  form: {
    fee: string;
    adjustInterest: boolean;
    interest: string;
    interestReason: string;
    includeFlatFee: boolean;
    newDueDate: string;
    headText: string;
    footText: string;
  },
  computed: { feeCents: number; flatFee40Cents: number; newDueDate: string } | null,
  showFlatFee: boolean,
): { ok: true; values: ReminderCreateValues } | { ok: false; field: "fee" | "interest" | "interestReason" } {
  const values: Record<string, unknown> = { headText: form.headText, footText: form.footText };
  const fee = parseCents(form.fee || "0");
  if (!fee.ok || fee.value < 0) return { ok: false, field: "fee" };
  if (!computed || fee.value !== computed.feeCents) values.feeCents = fee.value;
  if (form.adjustInterest) {
    const interest = parseCents(form.interest || "0");
    if (!interest.ok || interest.value < 0) return { ok: false, field: "interest" };
    if (!form.interestReason.trim()) return { ok: false, field: "interestReason" };
    values.interestCents = interest.value;
    values.interestReason = form.interestReason.trim();
  }
  if (showFlatFee && (!computed || form.includeFlatFee !== computed.flatFee40Cents > 0)) {
    values.includeFlatFee = form.includeFlatFee;
  }
  if (form.newDueDate && (!computed || form.newDueDate !== computed.newDueDate)) values.newDueDate = form.newDueDate;
  const parsed = reminderCreateSchema.safeParse(values);
  if (!parsed.success) return { ok: false, field: "fee" };
  return { ok: true, values: parsed.data };
}

function DraftEditor({ data }: { data: Detail }) {
  const t = useTranslations("dunning.editor");
  const router = useRouter();
  const run = useRun();
  const update = useMutation(api.dunning.updateReminder);
  const finalize = useMutation(api.dunning.finalize);
  const remove = useMutation(api.dunning.deleteReminder);
  const canFinalize = useCan("invoices.finalize");
  const { exec, dialog } = useWarningRetry();
  const r = data.reminder;
  const d = data.detail;
  const c = data.computed;
  const manual = d.manual ?? {};
  const flatFeeClaimed = c?.flatFeeAlreadyClaimed ?? data.case?.flatFeeCharged ?? false;
  const showFlatFee = !data.isConsumer;
  const initial = {
    fee: formatCents(manual.feeCents ?? c?.feeCents ?? d.feeCents),
    adjustInterest: manual.interestCents !== undefined,
    interest: formatCents(manual.interestCents ?? c?.interestCents ?? d.interestCents),
    interestReason: manual.interestReason ?? "",
    includeFlatFee: manual.includeFlatFee ?? (c?.flatFee40Cents ?? d.flatFee40Cents) > 0,
    newDueDate: manual.newDueDate ?? c?.newDueDate ?? d.newDueDate,
    headText: data.texts.headText,
    footText: data.texts.footText,
  };
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"finalize" | "delete" | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const patch = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const ids = {
    fee: useId(),
    interest: useId(),
    reason: useId(),
    due: useId(),
    head: useId(),
    foot: useId(),
    flat: useId(),
    flatHint: useId(),
  };
  const blocking = data.findings.some((f) => f.severity === "E") || c === null;

  /** Saves the form; resolves with the new version (or the current one when nothing changed), null on failure. */
  const save = async (): Promise<number | null> => {
    if (!dirty) return r.version;
    const built = draftValues(form, c, showFlatFee);
    if (!built.ok) {
      setError(t(`errors.${built.field}`));
      return null;
    }
    setError(null);
    let version: number | null = null;
    await exec(
      (ack) =>
        update({
          id: r.id,
          version: r.version,
          values: { ...built.values, ...(ack.length ? { acknowledgeWarnings: ack } : {}) },
        }),
      {
        success: t("saved"),
        onSuccess: (v) => {
          version = v.version;
        },
      },
    );
    return version;
  };

  const doFinalize = async () => {
    const version = await save();
    if (version === null) return;
    await exec((ack) => finalize({ id: r.id, version, ...(ack.length ? { acknowledgeWarnings: ack } : {}) }), {
      onSuccess: (res) => {
        setConfirm(null);
        toast.success(t("finalized", { number: res.number }));
      },
      confirmLabel: t("finalizeAnyway"),
    });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="reminder-editor">
      <SectionCard title={t("amounts")}>
        <div className="@container/form grid gap-4 @lg/form:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.fee} className="font-medium text-sm">
              {t("fee")}
            </label>
            <Input
              id={ids.fee}
              inputMode="decimal"
              value={form.fee}
              onChange={(e) => patch({ fee: e.target.value })}
              className="h-11 md:h-9"
            />
            {c && <p className="text-muted-foreground text-xs">{t("computedFee", { amount: money(c.feeCents) })}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.due} className="font-medium text-sm">
              {t("newDueDate")}
            </label>
            <Input
              id={ids.due}
              type="date"
              min={todayBerlin()}
              value={form.newDueDate}
              onChange={(e) => patch({ newDueDate: e.target.value })}
              className="h-11 md:h-9"
            />
            {c && (
              <p className="text-muted-foreground text-xs">{t("computedDue", { date: formatDate(c.newDueDate) })}</p>
            )}
          </div>
        </div>
        {showFlatFee && (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={ids.flat} className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
              <input
                id={ids.flat}
                type="checkbox"
                className="size-5 accent-primary md:size-4"
                checked={!flatFeeClaimed && form.includeFlatFee}
                disabled={flatFeeClaimed}
                aria-describedby={flatFeeClaimed ? ids.flatHint : undefined}
                onChange={(e) => patch({ includeFlatFee: e.target.checked })}
              />
              {t("flatFee")}
            </label>
            {flatFeeClaimed && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button variant="ghost" size="icon" className="size-11 md:size-8" aria-label={t("flatFeeWhy")} />
                  }
                >
                  <InfoIcon aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent>{t("flatFeeClaimed")}</TooltipContent>
              </Tooltip>
            )}
            {flatFeeClaimed && (
              <p id={ids.flatHint} className="w-full text-muted-foreground text-xs">
                {t("flatFeeClaimed")}
              </p>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard title={t("interest")}>
        {c ? (
          <>
            <p className="text-sm">
              {c.inDefault && c.defaultStartDate
                ? t("interestComputed", { amount: money(c.interestCents), date: formatDate(c.defaultStartDate) })
                : t("interestNoDefault")}
            </p>
            <InterestSegments segments={c.interestSegments} totalCents={c.interestCents} />
          </>
        ) : (
          <p className="text-muted-foreground text-sm">{t("noComputation")}</p>
        )}
        <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
          <input
            type="checkbox"
            className="size-5 accent-primary md:size-4"
            checked={form.adjustInterest}
            onChange={(e) => patch({ adjustInterest: e.target.checked })}
          />
          {t("adjustInterest")}
        </label>
        {form.adjustInterest && (
          <div className="@container/form grid gap-4 @lg/form:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.interest} className="font-medium text-sm">
                {t("interestAmount")}
              </label>
              <Input
                id={ids.interest}
                inputMode="decimal"
                value={form.interest}
                onChange={(e) => patch({ interest: e.target.value })}
                className="h-11 md:h-9"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.reason} className="font-medium text-sm">
                {t("interestReason")}
              </label>
              <Textarea
                id={ids.reason}
                value={form.interestReason}
                onChange={(e) => patch({ interestReason: e.target.value })}
              />
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard title={t("texts")}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.head} className="font-medium text-sm">
            {t("headText")}
          </label>
          <Textarea
            id={ids.head}
            rows={5}
            value={form.headText}
            onChange={(e) => patch({ headText: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.foot} className="font-medium text-sm">
            {t("footText")}
          </label>
          <Textarea
            id={ids.foot}
            rows={4}
            value={form.footText}
            onChange={(e) => patch({ footText: e.target.value })}
          />
        </div>
      </SectionCard>

      <ClaimSummary data={data} />

      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="h-11 md:h-9" disabled={!dirty} onClick={() => void save()}>
          {t("save")}
        </Button>
        {canFinalize && (
          <Button className="h-11 md:h-9" disabled={blocking} onClick={() => setConfirm("finalize")}>
            <CheckIcon aria-hidden="true" />
            {t("finalize")}
          </Button>
        )}
        <Button variant="ghost" className="h-11 text-danger md:h-9" onClick={() => setConfirm("delete")}>
          <Trash2Icon aria-hidden="true" />
          {t("delete")}
        </Button>
      </div>
      {confirm === "finalize" && (
        <ConfirmDialog
          title={t("finalizeTitle")}
          description={t("finalizeDescription")}
          confirmLabel={t("finalizeConfirm")}
          onClose={() => setConfirm(null)}
          onConfirm={doFinalize}
        >
          {dirty && <p className="text-sm">{t("finalizeSavesFirst")}</p>}
        </ConfirmDialog>
      )}
      {confirm === "delete" && (
        <ConfirmDialog
          title={t("deleteTitle")}
          description={t("deleteDescription")}
          confirmLabel={t("delete")}
          destructive
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const res = await run(() => remove({ id: r.id }), t("deleted"));
            if (res.ok) router.push((r.invoiceId ? `/rechnungen/${r.invoiceId}` : "/mahnungen") as Route);
          }}
        />
      )}
      {dialog}
    </div>
  );
}

// ── claim summary, compliance ───────────────────────────────────────────────────────────────────────────────────

function ClaimSummary({ data }: { data: Detail }) {
  const t = useTranslations("dunning.claim");
  const r = data.reminder;
  return (
    <SectionCard title={t("title")} testId="claim-summary">
      <dl className="grid w-full max-w-md grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("open")}</dt>
        <dd className="text-right tabular-nums">{money(r.openAmountCents)}</dd>
        <dt className="text-muted-foreground">{t("fee")}</dt>
        <dd className="text-right tabular-nums">{money(r.feeCents)}</dd>
        <dt className="text-muted-foreground">{t("interest")}</dt>
        <dd className="text-right tabular-nums">{money(r.interestCents)}</dd>
        {!data.isConsumer && (
          <>
            <dt className="text-muted-foreground">{t("flatFee")}</dt>
            <dd className="text-right tabular-nums">
              {r.flatFee40Cents > 0
                ? money(r.flatFee40Cents)
                : data.case?.flatFeeCharged
                  ? t("flatFeeClaimed")
                  : money(0)}
            </dd>
          </>
        )}
        <dt className="font-semibold">{t("total")}</dt>
        <dd className="text-right font-semibold tabular-nums" data-testid="claim-total">
          {money(r.totalCents)}
        </dd>
        <dt className="text-muted-foreground">{t("newDueDate")}</dt>
        <dd className="text-right">{formatDate(r.newDueDate)}</dd>
      </dl>
      {r.status === "draft" && <p className="text-muted-foreground text-xs">{t("draftHint")}</p>}
    </SectionCard>
  );
}

function CompliancePanel({ data }: { data: Detail }) {
  const t = useTranslations("dunning.compliance");
  const tDispatch = useTranslations("dunning.dispatch");
  const headingId = useId();
  const inv = data.invoice;
  const c = data.computed;
  const route = data.case?.defaultRoute as DefaultRoute | null | undefined;
  const defaultStart = c?.defaultStartDate ?? data.case?.defaultStartDate ?? data.reminder.defaultStartDate;
  const inDefault = c ? c.inDefault : Boolean(defaultStart);
  const errors = data.findings.filter((f) => f.severity === "E").length;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border p-4"
      data-testid="reminder-compliance"
    >
      <h2 id={headingId} className="font-semibold text-base">
        {t("title")}
      </h2>
      <FactList
        items={[
          {
            label: t("defaultStatus"),
            value:
              inDefault && defaultStart
                ? t("inDefault", {
                    date: formatDate(defaultStart),
                    route: route ? DEFAULT_ROUTE_LABEL_DE[route] : t("routeUnknown"),
                  })
                : inv?.zugang
                  ? t("notInDefault")
                  : t("noZugang"),
          },
          {
            label: t("invoice"),
            value: inv ? (
              <Link href={`/rechnungen/${inv.id}` as Route} className="underline">
                {inv.number}
              </Link>
            ) : (
              "—"
            ),
          },
          { label: t("dueDate"), value: formatDate(inv?.dueDate) },
          {
            label: t("invoiceZugang"),
            value: inv?.zugang
              ? `${formatDate(inv.zugang.date)} (${inv.zugang.basis === "manual" ? tDispatch("manual") : (SEND_CHANNEL_LABELS[inv.zugang.basis as SendChannel] ?? inv.zugang.basis)})`
              : tDispatch("notMarked"),
          },
          { label: t("openAmount"), value: money(inv?.openAmountCents), numeric: true },
          { label: t("level"), value: String(data.reminder.level) },
        ]}
      />
      {data.reminder.status === "draft" && (
        <>
          <p role="status" className={cn("text-sm", errors > 0 ? "text-danger" : "text-success")}>
            {errors > 0 ? t("blocked", { count: errors }) : t("ready")}
          </p>
          {data.findings.length > 0 && (
            <ul className="flex flex-col gap-1.5" data-testid="reminder-findings">
              {data.findings.map((f) => (
                <li
                  key={`${f.code}-${f.message}`}
                  data-code={f.code}
                  className={cn(
                    "flex items-start gap-2 rounded-md border p-2 text-sm",
                    f.severity === "E" && "border-danger/40 bg-danger/5",
                    f.severity === "W" && "border-warning/40 bg-warning/5",
                  )}
                >
                  {f.severity === "E" ? (
                    <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                  ) : f.severity === "W" ? (
                    <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                  ) : (
                    <InfoIcon className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="sr-only">
                      {t(`severity.${f.severity === "E" ? "E" : f.severity === "W" ? "W" : "I"}`)}:{" "}
                    </span>
                    {f.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// ── finalised reminder ──────────────────────────────────────────────────────────────────────────────────────────

function FinalActions({ data }: { data: Detail }) {
  const t = useTranslations("dunning.reminder");
  const canSend = useCan("invoices.send");
  const canWrite = useCan("dunning.write");
  const [dialog, setDialog] = useState<"mark" | "withdraw" | null>(null);
  const r = data.reminder;
  const ready = r.artifactStatus === "ready";
  const active = r.status === "finalized" || r.status === "sent";
  return (
    <>
      <ReminderExportMenu id={r.id} disabled={!ready} />
      {canSend && active && (
        <Button className="h-11 md:h-9" disabled={!ready} onClick={() => setDialog("mark")} data-testid="mark-sent">
          <SendIcon aria-hidden="true" />
          {r.sentOn ? t("markAgain") : t("markSent")}
        </Button>
      )}
      {canWrite && active && (
        <Button variant="outline" className="h-11 md:h-9" onClick={() => setDialog("withdraw")}>
          {t("withdraw")}
        </Button>
      )}
      {dialog === "mark" && <ReminderMarkSentDialog id={r.id} onClose={() => setDialog(null)} />}
      {dialog === "withdraw" && <WithdrawDialog data={data} onClose={() => setDialog(null)} />}
    </>
  );
}

/** DUN-009 „Gegenstandslos setzen“ with a reason (≥ 5 characters). */
function WithdrawDialog({ data, onClose }: { data: Detail; onClose: () => void }) {
  const t = useTranslations("dunning.withdraw");
  const run = useRun();
  const withdraw = useMutation(api.dunning.withdraw);
  const [reason, setReason] = useState("");
  const rid = useId();
  return (
    <ConfirmDialog
      title={t("title", { number: data.reminder.number ?? "" })}
      description={data.reminder.sentOn ? t("descriptionSent") : t("description")}
      confirmLabel={t("confirm")}
      destructive
      confirmDisabled={reason.trim().length < 5}
      onClose={onClose}
      onConfirm={async () => {
        const res = await run(() => withdraw({ id: data.reminder.id, values: { reason: reason.trim() } }), t("done"));
        if (res.ok) onClose();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={rid} className="font-medium text-sm">
          {t("reason")}
        </label>
        <Textarea id={rid} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}

function FinalView({ data }: { data: Detail }) {
  const t = useTranslations("dunning.reminder");
  const tDispatch = useTranslations("dunning.dispatch");
  const r = data.reminder;
  const d = data.detail;
  const canWrite = useCan("dunning.write");
  const [zugang, setZugang] = useState(false);
  return (
    <>
      {r.artifactStatus !== "ready" && (
        <p role="status" className="rounded-lg border border-info/30 bg-info/5 p-3 text-sm">
          {r.artifactStatus === "blocked" ? t("artifactsBlocked") : t("artifactsPending")}
        </p>
      )}
      {r.status === "cancelled" && r.cancellation && (
        <p role="status" className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
          {t("withdrawnInfo", { date: formatDateTime(r.cancellation.at), reason: r.cancellation.reason })}
        </p>
      )}
      <ClaimSummary data={data} />
      {(d.interestSegments?.length ?? 0) > 0 && (
        <SectionCard title={t("interestTable")}>
          <InterestSegments segments={d.interestSegments ?? []} totalCents={r.interestCents} />
        </SectionCard>
      )}
      {(data.snapshot?.texts.headText || data.snapshot?.texts.footText) && (
        <SectionCard title={t("texts")}>
          {data.snapshot?.texts.headText && (
            <p className="whitespace-pre-line text-sm">{data.snapshot.texts.headText}</p>
          )}
          {data.snapshot?.texts.footText && (
            <p className="whitespace-pre-line text-sm">{data.snapshot.texts.footText}</p>
          )}
        </SectionCard>
      )}
      <SectionCard
        title={t("dispatch")}
        actions={
          canWrite && r.sentOn && r.status !== "cancelled" ? (
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setZugang(true)}>
              {t("overrideZugang")}
            </Button>
          ) : undefined
        }
        testId="reminder-dispatch"
      >
        <FactList
          items={[
            { label: t("documentDate"), value: formatDate(r.documentDate) },
            { label: t("sentOn"), value: r.sentOn ? formatDate(r.sentOn) : tDispatch("notMarked") },
            {
              label: t("zugang"),
              value: r.zugang
                ? `${formatDate(r.zugang.date)} (${r.zugang.basis === "manual" ? tDispatch("manual") : (SEND_CHANNEL_LABELS[r.zugang.basis as SendChannel] ?? r.zugang.basis)})`
                : "—",
            },
          ]}
        />
        {data.sendLog.length > 0 && (
          <ul className="flex flex-col gap-2 text-sm" data-testid="reminder-send-log">
            {data.sendLog.map((x) => (
              <li key={x._id} className="rounded-md border p-2">
                {x.kind === "mark_sent"
                  ? t("markedOn", {
                      date: formatDate(x.sentOn),
                      channel: SEND_CHANNEL_LABELS[x.channel as SendChannel] ?? x.channel,
                    })
                  : t("retractedOn", { date: formatDateTime(x.at) })}
                {x.note ? ` – ${x.note}` : ""}
                {x._id === data.effectiveMarkId ? ` (${t("effective")})` : ""}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      {data.artifacts.length > 0 && (
        <SectionCard title={t("files")}>
          <ul className="flex flex-col gap-1 text-sm" data-testid="reminder-artifacts">
            {data.artifacts.map((a) => (
              <li key={a._id} className="flex flex-col">
                <span>{a.name}</span>
                <span className="break-all font-mono text-muted-foreground text-xs">SHA-256 {a.sha256}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
      {zugang && <ZugangDialog data={data} onClose={() => setZugang(false)} />}
    </>
  );
}

/** PAY-052 manual Zugang override (Rückschein, Bestätigung) with a reason. */
function ZugangDialog({ data, onClose }: { data: Detail; onClose: () => void }) {
  const t = useTranslations("dunning.zugang");
  const run = useRun();
  const override = useMutation(api.dunning.overrideZugang);
  const r = data.reminder;
  const [date, setDate] = useState(r.zugang?.date ?? r.sentOn ?? todayBerlin());
  const [reason, setReason] = useState("");
  const ids = { date: useId(), reason: useId() };
  return (
    <ConfirmDialog
      title={t("title")}
      description={t("description")}
      confirmLabel={t("confirm")}
      confirmDisabled={reason.trim().length < 5 || !date}
      onClose={onClose}
      onConfirm={async () => {
        const res = await run(() => override({ id: r.id, values: { date, reason: reason.trim() } }), t("done"));
        if (res.ok) onClose();
      }}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.date} className="font-medium text-sm">
            {t("date")}
          </label>
          <Input
            id={ids.date}
            type="date"
            min={r.sentOn ?? undefined}
            max={data.today ?? todayBerlin()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-11 md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.reason} className="font-medium text-sm">
            {t("reason")}
          </label>
          <Textarea id={ids.reason} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>
    </ConfirmDialog>
  );
}
