"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDownIcon, DownloadIcon, TriangleAlertIcon } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type * as React from "react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, formatDate, selectClass, todayBerlin, useRun } from "@/components/catalog/shared";
import { downloadExport, money } from "@/components/invoices/invoice-shared";
import { adapterErrorMessage, adapterErrorReason } from "@/components/setup/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { SEND_CHANNEL_LABELS, SEND_CHANNELS, type SendChannel } from "@/domain/documents/dispatch";
import { type CalendarDate, isCalendarDate, toEpochDay } from "@/domain/time/calendar-date";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * Shared pieces of the Mahnwesen screens (F05 §6.4–§6.7): the ⚑ warning-acknowledge retry, status badges, the
 * dispatch line of DUN-010, the interest segment table (DUN-005/022), the reminder export menu and the reminder
 * „Als versendet markieren“ dialog with the DUN-056 late-mark check. Rules stay in src/domain and Convex.
 */

// ── ⚑ warnings (WARNINGS_UNACKNOWLEDGED) ─────────────────────────────────────────────────────────────────────────

export interface PendingWarnings {
  codes: string[];
  message: string;
}

/** The warning codes and German message of a `WARNINGS_UNACKNOWLEDGED` error, else null. */
export function warningsOf(error: unknown): PendingWarnings | null {
  if (adapterErrorReason(error) !== "WARNINGS_UNACKNOWLEDGED") return null;
  const data = (error as { data?: { warnings?: unknown } }).data;
  const codes = String(data?.warnings ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return { codes, message: adapterErrorMessage(error) ?? "" };
}

interface RetryOptions<T> {
  success?: string;
  onSuccess?: (value: T) => void;
  /** Label of the confirm button in the warning dialog (default „Trotzdem fortfahren“). */
  confirmLabel?: string;
}

/**
 * Runs a backend call that may answer `WARNINGS_UNACKNOWLEDGED`: the warning is shown in a confirm dialog and, after
 * the user confirms, the call is repeated with the acknowledged codes (F05 ⚑ pattern). `fn` receives the codes so
 * every caller puts them where its function expects them (`values.acknowledgeWarnings` or top level).
 */
export function useWarningRetry() {
  const t = useTranslations("dunning.warnings");
  const showError = useAdapterErrorToast();
  const [pending, setPending] = useState<
    (PendingWarnings & { fn: (ack: string[]) => Promise<unknown>; opts: RetryOptions<unknown> }) | null
  >(null);

  const attempt = async <T,>(fn: (ack: string[]) => Promise<T>, ack: string[], opts: RetryOptions<T>) => {
    try {
      const value = await fn(ack);
      setPending(null);
      if (opts.success) toast.success(opts.success);
      opts.onSuccess?.(value);
      return true;
    } catch (e) {
      const w = warningsOf(e);
      if (w?.codes.some((c) => !ack.includes(c))) {
        setPending({
          codes: [...new Set([...ack, ...w.codes])],
          message: w.message,
          fn: fn as (ack: string[]) => Promise<unknown>,
          opts: opts as RetryOptions<unknown>,
        });
        return false;
      }
      setPending(null);
      showError(e);
      return false;
    }
  };

  const dialog = pending ? (
    <ConfirmDialog
      title={t("title")}
      description={t("description")}
      confirmLabel={pending.opts.confirmLabel ?? t("confirm")}
      onClose={() => setPending(null)}
      onConfirm={() => void attempt(pending.fn, pending.codes, pending.opts)}
    >
      <p
        role="alert"
        className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm"
        data-testid="dunning-warning"
      >
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <span>{pending.message}</span>
      </p>
    </ConfirmDialog>
  ) : null;

  return {
    exec: <T,>(fn: (ack: string[]) => Promise<T>, opts: RetryOptions<T> = {}) => attempt(fn, [], opts),
    dialog,
  };
}

// ── badges and labels ────────────────────────────────────────────────────────────────────────────────────────────

export type ReminderStatus = "draft" | "finalized" | "sent" | "cancelled";

export function ReminderStatusBadge({ status }: { status: string }) {
  const t = useTranslations("dunning.status");
  const s = (["draft", "finalized", "sent", "cancelled"].includes(status) ? status : "draft") as ReminderStatus;
  const variant = s === "finalized" ? "default" : s === "sent" ? "secondary" : "outline";
  return (
    <Badge variant={variant} data-status={s}>
      {t(s)}
    </Badge>
  );
}

export type CaseStatus = "active" | "paused" | "closed" | "handed_over";

export function CaseStatusBadge({ status }: { status: string | null }) {
  const t = useTranslations("dunning.caseStatus");
  if (!status) return <Badge variant="outline">{t("none")}</Badge>;
  const s = (["active", "paused", "closed", "handed_over"].includes(status) ? status : "active") as CaseStatus;
  return <Badge variant={s === "active" ? "default" : "outline"}>{t(s)}</Badge>;
}

export interface LimitationView {
  date: string;
  state: string;
  message: string | null;
}

/** DUN-040/041 badge: „verjährt am 31.12.2026“ (from 01.10. of the year) or „verjährt“. */
export function LimitationBadge({ limitation }: { limitation: LimitationView | null }) {
  const t = useTranslations("dunning.limitation");
  if (!limitation || limitation.state === "ok") return null;
  return (
    <Badge variant="destructive" title={limitation.message ?? undefined} data-testid="limitation-badge">
      {limitation.state === "expired" ? t("expired") : t("soon", { date: formatDate(limitation.date) })}
    </Badge>
  );
}

export interface DispatchView {
  status: string;
  sentOn: string | null;
  zugang: { date: string; basis: string } | null;
}

const basisLabel = (basis: string, manual: string) =>
  basis === "manual" ? manual : (SEND_CHANNEL_LABELS[basis as SendChannel] ?? basis);

/** DUN-010 dispatch line: „versendet am … · Zugang … (Post)“ or „noch nicht als versendet markiert“. */
export function DispatchStatus({ reminder }: { reminder: DispatchView }) {
  const t = useTranslations("dunning.dispatch");
  if (reminder.status === "draft") return <span className="text-muted-foreground">{t("draft")}</span>;
  if (reminder.status === "cancelled" && !reminder.sentOn) {
    return <span className="text-muted-foreground">{t("withdrawn")}</span>;
  }
  if (!reminder.sentOn) return <span className="text-warning">{t("notMarked")}</span>;
  return (
    <span>
      {t("sentOn", { date: formatDate(reminder.sentOn) })}
      {reminder.zugang
        ? ` · ${t("zugang", { date: formatDate(reminder.zugang.date), basis: basisLabel(reminder.zugang.basis, t("manual")) })}`
        : ""}
    </span>
  );
}

// ── interest segments (DUN-005, DUN-022) ─────────────────────────────────────────────────────────────────────────

export interface SegmentView {
  from: string;
  to: string;
  days: number;
  principalCents: number;
  rateBp: number;
  amountCents: number;
}

export const formatRateBp = (bp: number): string =>
  `${(bp / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;

/** Zeitraum · Tage · Zinssatz · Kapital · Betrag; a stacked list on narrow containers. */
export function InterestSegments({ segments, totalCents }: { segments: readonly SegmentView[]; totalCents?: number }) {
  const t = useTranslations("dunning.interest");
  if (segments.length === 0) return <p className="text-muted-foreground text-sm">{t("noSegments")}</p>;
  return (
    <div className="@container/segments" data-testid="interest-segments">
      <ul className="flex flex-col divide-y text-sm @lg/segments:hidden">
        {segments.map((s) => (
          <li key={`${s.from}-${s.to}`} className="flex flex-col gap-0.5 py-2">
            <span className="flex justify-between gap-3">
              <span>
                {formatDate(s.from)} – {formatDate(s.to)}
              </span>
              <span className="font-medium tabular-nums">{money(s.amountCents)}</span>
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {t("daysCount", { days: s.days })} · {formatRateBp(s.rateBp)} · {money(s.principalCents)}
            </span>
          </li>
        ))}
        {totalCents !== undefined && (
          <li className="flex justify-between gap-3 py-2 font-semibold">
            <span>{t("total")}</span>
            <span className="tabular-nums">{money(totalCents)}</span>
          </li>
        )}
      </ul>
      <div className="hidden @lg/segments:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("period")}</TableHead>
              <TableHead className="text-right">{t("days")}</TableHead>
              <TableHead className="text-right">{t("rate")}</TableHead>
              <TableHead className="text-right">{t("principal")}</TableHead>
              <TableHead className="text-right">{t("amount")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {segments.map((s) => (
              <TableRow key={`${s.from}-${s.to}`}>
                <TableCell className="whitespace-nowrap">
                  {formatDate(s.from)} – {formatDate(s.to)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{s.days}</TableCell>
                <TableCell className="text-right tabular-nums">{formatRateBp(s.rateBp)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(s.principalCents)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(s.amountCents)}</TableCell>
              </TableRow>
            ))}
            {totalCents !== undefined && (
              <TableRow>
                <TableCell colSpan={4} className="font-semibold">
                  {t("total")}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{money(totalCents)}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ── export and „Als versendet markieren“ (DUN-058, DUN-056) ──────────────────────────────────────────────────────

/** „Exportieren ▾“ for a finalised reminder: PDF or ZIP of the archived files (the „Kopie“ once marked sent). */
export function ReminderExportMenu({
  id,
  disabled,
  size = "default",
}: {
  id: string;
  disabled?: boolean;
  size?: "default" | "sm";
}) {
  const t = useTranslations("dunning.export");
  const run = useRun();
  const exportFiles = useAction(api.documentArtifacts.exportFiles);
  const doExport = (entry: "pdf" | "zip") =>
    void run(async () => {
      const res = await exportFiles({ id: id as Id<"salesDocuments">, request: { entry } });
      await downloadExport(res.files, res.zipName);
      return res;
    }, t("done"));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            className={size === "sm" ? "h-11 md:h-8" : "h-11 md:h-9"}
            disabled={disabled}
            data-testid="reminder-export"
          />
        }
      >
        <DownloadIcon aria-hidden="true" />
        {t("label")}
        <ChevronDownIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => doExport("pdf")}>{t("pdf")}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => doExport("zip")}>{t("zip")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** DUN-056 / EC-DUN-33: the reminder is marked sent more than 3 days after its document date. */
export function isLateMark(documentDate: string | null, sentOn: string): boolean {
  if (!documentDate || !isCalendarDate(documentDate) || !isCalendarDate(sentOn)) return false;
  return toEpochDay(sentOn as CalendarDate) - toEpochDay(documentDate as CalendarDate) > 3;
}

const ARTIFACT_LABELS: Record<string, string> = { pdf: "PDF" };
const VARIANT_LABELS: Record<string, string> = { original: "Original", copy: "Kopie", reading: "Lesefassung" };

/**
 * „Als versendet markieren“ for a reminder (F04 §3.5 mechanism via `invoices.markSent`, DUN-058): date, channel,
 * note and the handed-over files. DUN-056: a sent date more than 3 days after the document date shows the warning
 * with „Trotzdem als versendet markieren“ / „Gegenstandslos setzen und neu erstellen“ before anything is recorded.
 */
export function ReminderMarkSentDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const data = useAuthedQuery(api.dunning.reminder, { id: id as Id<"salesDocuments"> });
  if (!data) return null;
  return <MarkSentForm data={data} onClose={onClose} />;
}

export type ReminderDetail = NonNullable<FunctionReturnType<typeof api.dunning.reminder>>;

function MarkSentForm({ data, onClose }: { data: ReminderDetail; onClose: () => void }) {
  const t = useTranslations("dunning.mark");
  const run = useRun();
  const router = useRouter();
  const markSent = useMutation(api.invoices.markSent);
  const withdraw = useMutation(api.dunning.withdraw);
  const createReminder = useMutation(api.dunning.createReminder);
  const [sentOn, setSentOn] = useState<string>(data.today ?? todayBerlin());
  const [channel, setChannel] = useState<SendChannel>("email_manual");
  const [note, setNote] = useState("");
  const selectable = data.artifacts.filter((a) => !a.kind.startsWith("validation_report"));
  const [selected, setSelected] = useState<string[]>(
    data.defaultMarkSelection.length > 0 ? data.defaultMarkSelection : selectable.map((a) => a._id),
  );
  const ids = { date: useId(), channel: useId(), note: useId() };
  const r = data.reminder;
  const late = isLateMark(r.documentDate, sentOn);
  const noteMissing = channel === "other" && !note.trim();

  const submit = async () => {
    const res = await run(
      () =>
        markSent({
          id: r.id,
          values: {
            sentOn,
            channel,
            ...(note.trim() ? { note: note.trim() } : {}),
            artifactIds: selected,
          },
        }),
      t("done"),
    );
    if (res.ok) {
      for (const w of res.value?.warnings ?? []) toast.warning(w);
      onClose();
    }
  };

  const withdrawAndRecreate = async () => {
    const res = await run(async () => {
      await withdraw({ id: r.id, values: { reason: t("lateWithdrawReason") } });
      if (!r.invoiceId) return null;
      return createReminder({ invoiceId: r.invoiceId, values: {} });
    }, t("recreated"));
    if (res.ok) {
      onClose();
      if (res.value) router.push(`/mahnungen/${res.value.id}` as Route);
    }
  };

  return (
    <ConfirmDialog
      title={t("title", { number: r.number ?? "" })}
      description={t("description")}
      confirmLabel={late ? t("confirmLate") : t("confirm")}
      confirmDisabled={selected.length === 0 || noteMissing}
      onConfirm={submit}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.date} className="font-medium text-sm">
            {t("sentOn")}
          </label>
          <Input
            id={ids.date}
            type="date"
            max={data.today ?? todayBerlin()}
            value={sentOn}
            onChange={(e) => setSentOn(e.target.value)}
            className="h-11 md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.channel} className="font-medium text-sm">
            {t("channel")}
          </label>
          <select
            id={ids.channel}
            className={selectClass}
            value={channel}
            onChange={(e) => setChannel(e.target.value as SendChannel)}
          >
            {SEND_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {SEND_CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
          {channel === "post" && <p className="text-muted-foreground text-sm">{t("postHint")}</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.note} className="font-medium text-sm">
            {channel === "other" ? t("noteRequired") : t("note")}
          </label>
          <Textarea id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-medium text-sm">{t("files")}</legend>
          {selectable.length === 0 && <p className="text-muted-foreground text-sm">{t("noFiles")}</p>}
          {selectable.map((a) => (
            <label key={a._id} className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
              <input
                type="checkbox"
                className="size-5 accent-primary md:size-4"
                checked={selected.includes(a._id)}
                onChange={(e) => setSelected((s) => (e.target.checked ? [...s, a._id] : s.filter((x) => x !== a._id)))}
              />
              {a.name} · {ARTIFACT_LABELS[a.kind] ?? a.kind} ({VARIANT_LABELS[a.variant] ?? a.variant})
            </label>
          ))}
        </fieldset>
        {late && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm"
            data-testid="late-mark-warning"
          >
            <p className="flex items-start gap-2">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              <span>{t("lateWarning")}</span>
            </p>
            <Button variant="outline" className="h-11 self-start md:h-9" onClick={() => void withdrawAndRecreate()}>
              {t("withdrawAndRecreate")}
            </Button>
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

/** Small labelled section card used across the dunning screens. */
export function SectionCard({
  title,
  actions,
  children,
  testId,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-xl border p-4" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="font-semibold text-base">
          {title}
        </h2>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
