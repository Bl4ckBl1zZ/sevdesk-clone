"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CalculatorIcon, PlayIcon, SendIcon, SettingsIcon, SirenIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, formatDate, formatDateTime, useCan, useRun, useUrlState } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { money } from "@/components/invoices/invoice-shared";
import { EmptyState } from "@/components/layout/empty-state";
import { PageBody } from "@/components/layout/list-layout";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SEND_CHANNEL_LABELS, type SendChannel } from "@/domain/documents/dispatch";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import {
  DispatchStatus,
  LimitationBadge,
  ReminderExportMenu,
  ReminderMarkSentDialog,
  ReminderStatusBadge,
} from "./dunning-shared";
import { InterestCalculatorSheet } from "./interest-calculator";
import { type ListColumn, ResponsiveList } from "./responsive-list";

type Cockpit = FunctionReturnType<typeof api.dunning.cockpit>;
type ReminderRow = Cockpit["drafts"][number];
type InvoiceRow = Cockpit["dueSoon"][number];
type RunRow = Cockpit["runs"][number];
type Preview = FunctionReturnType<typeof api.dunning.preview>;
type PreviewAction = Preview["actions"][number];

/** URL slugs of the cockpit tabs (`?tab=`; the backend links to `/mahnungen?tab=entwuerfe`). */
export const COCKPIT_TABS = [
  "bald-faellig",
  "vorschau",
  "entwuerfe",
  "zu-versenden",
  "versendet",
  "gegenstandslos",
  "ohne-versandmarkierung",
  "pausiert",
  "verjaehrung",
  "laeufe",
] as const;
export type CockpitTab = (typeof COCKPIT_TABS)[number];

export const cockpitTabOf = (value: string): CockpitTab =>
  (COCKPIT_TABS as readonly string[]).includes(value) ? (value as CockpitTab) : "vorschau";

const TAB_KEY: Record<CockpitTab, string> = {
  "bald-faellig": "dueSoon",
  vorschau: "preview",
  entwuerfe: "drafts",
  "zu-versenden": "toSend",
  versendet: "sent",
  gegenstandslos: "withdrawn",
  "ohne-versandmarkierung": "unmarked",
  pausiert: "paused",
  verjaehrung: "limitation",
  laeufe: "runs",
};

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

/** Mahnungen cockpit (F05 §6.4): tabs, „Vorschau nächster Lauf“ with selection run, run log, Verzugszinsrechner. */
export function DunningCockpit() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <CockpitInner />
    </ConvexGuard>
  );
}

function CockpitInner() {
  const t = useTranslations("dunning.cockpit");
  const { get, set } = useUrlState();
  const tab = cockpitTabOf(get("tab"));
  const data = useAuthedQuery(api.dunning.cockpit, {});
  const [calculator, setCalculator] = useState(false);
  const counts: Partial<Record<CockpitTab, number>> = data
    ? {
        "bald-faellig": data.dueSoon.length,
        entwuerfe: data.drafts.length,
        "zu-versenden": data.toSend.length,
        versendet: data.sent.length,
        gegenstandslos: data.withdrawn.length,
        "ohne-versandmarkierung": data.unmarked.length,
        pausiert: data.paused.length,
        verjaehrung: data.limitation.length,
      }
    : {};
  return (
    <PageBody className="@container/cockpit">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" className="h-11 md:h-9" onClick={() => setCalculator(true)}>
          <CalculatorIcon aria-hidden="true" />
          {t("calculator")}
        </Button>
        <Link
          href={"/einstellungen/mahnwesen" as Route}
          className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}
        >
          <SettingsIcon aria-hidden="true" />
          {t("settings")}
        </Link>
      </div>
      <Tabs value={tab} onValueChange={(v) => set({ tab: String(v) === "vorschau" ? "" : String(v) })}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto" aria-label={t("tabsLabel")}>
          {COCKPIT_TABS.map((k) => (
            <TabsTrigger key={k} value={k} className="h-11 flex-none px-3 md:h-9">
              {t(`tabs.${TAB_KEY[k]}` as "tabs.preview")}
              {counts[k] ? (
                <Badge variant="secondary" className="ml-1 tabular-nums">
                  {counts[k]}
                </Badge>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        {data === undefined ? (
          <div className="h-64" aria-busy="true" />
        ) : (
          <>
            <TabsContent value="bald-faellig" className="pt-4">
              <InvoiceTable rows={data.dueSoon} variant="dueSoon" empty={t("empty.dueSoon")} />
            </TabsContent>
            <TabsContent value="vorschau" className="pt-4">
              {tab === "vorschau" && <PreviewPanel />}
            </TabsContent>
            <TabsContent value="entwuerfe" className="pt-4">
              <ReminderTable rows={data.drafts} variant="drafts" empty={t("empty.drafts")} />
            </TabsContent>
            <TabsContent value="zu-versenden" className="pt-4">
              <ReminderTable rows={data.toSend} variant="toSend" empty={t("empty.toSend")} />
            </TabsContent>
            <TabsContent value="versendet" className="pt-4">
              <ReminderTable rows={data.sent} variant="sent" empty={t("empty.sent")} />
            </TabsContent>
            <TabsContent value="gegenstandslos" className="pt-4">
              <ReminderTable rows={data.withdrawn} variant="withdrawn" empty={t("empty.withdrawn")} />
            </TabsContent>
            <TabsContent value="ohne-versandmarkierung" className="pt-4">
              <p className="mb-3 text-muted-foreground text-sm">{t("unmarkedHint")}</p>
              <InvoiceTable rows={data.unmarked} variant="unmarked" empty={t("empty.unmarked")} />
            </TabsContent>
            <TabsContent value="pausiert" className="pt-4">
              <InvoiceTable rows={data.paused} variant="paused" empty={t("empty.paused")} />
            </TabsContent>
            <TabsContent value="verjaehrung" className="pt-4">
              <p className="mb-3 text-muted-foreground text-sm">{t("limitationHint")}</p>
              <InvoiceTable rows={data.limitation} variant="limitation" empty={t("empty.limitation")} />
            </TabsContent>
            <TabsContent value="laeufe" className="pt-4">
              <RunsTable rows={data.runs} />
            </TabsContent>
          </>
        )}
      </Tabs>
      {calculator && <InterestCalculatorSheet onClose={() => setCalculator(false)} />}
    </PageBody>
  );
}

// ── reminder tabs ───────────────────────────────────────────────────────────────────────────────────────────────

function ReminderTable({
  rows,
  variant,
  empty,
}: {
  rows: readonly ReminderRow[];
  variant: "drafts" | "toSend" | "sent" | "withdrawn";
  empty: string;
}) {
  const t = useTranslations("dunning.columns");
  const tc = useTranslations("dunning.cockpit");
  const canSend = useCan("invoices.send");
  const [mark, setMark] = useState<string | null>(null);
  if (rows.length === 0) return <EmptyState icon={SirenIcon} title={empty} />;
  const now = Date.now();
  const overdueTodo = (r: ReminderRow) =>
    variant === "toSend" && r.finalizedAt !== null && now - r.finalizedAt > TWO_DAYS_MS;
  const columns: ListColumn<ReminderRow>[] = [
    {
      key: "reminder",
      header: t("reminder"),
      cell: (r) => (
        <span className="flex flex-col">
          <Link href={`/mahnungen/${r.id}` as Route} className="font-medium underline">
            {r.number ?? tc("draftLabel", { level: r.level })}
          </Link>
          <span className="text-muted-foreground text-xs">{r.title}</span>
        </span>
      ),
    },
    {
      key: "invoice",
      header: t("invoice"),
      cell: (r) =>
        r.invoiceId ? (
          <Link href={`/rechnungen/${r.invoiceId}` as Route} className="underline">
            {r.invoiceNumber ?? "—"}
          </Link>
        ) : (
          "—"
        ),
    },
    { key: "customer", header: t("customer"), cell: (r) => r.contactName ?? "—" },
    { key: "level", header: t("level"), cell: (r) => r.level, numeric: true },
    ...(variant === "drafts"
      ? [
          {
            key: "origin",
            header: t("origin"),
            cell: (r: ReminderRow) => (r.createdByRun ? tc("byRun") : tc("manual")),
          },
        ]
      : [{ key: "date", header: t("documentDate"), cell: (r: ReminderRow) => formatDate(r.documentDate) }]),
    { key: "total", header: t("total"), cell: (r) => money(r.totalCents), numeric: true },
    ...(variant === "sent"
      ? [
          {
            key: "channel",
            header: t("channel"),
            cell: (r: ReminderRow) =>
              r.zugang ? (SEND_CHANNEL_LABELS[r.zugang.basis as SendChannel] ?? tc("manualZugang")) : "—",
          },
          { key: "sentOn", header: t("sentOn"), cell: (r: ReminderRow) => formatDate(r.sentOn) },
          { key: "zugang", header: t("zugang"), cell: (r: ReminderRow) => formatDate(r.zugang?.date) },
        ]
      : []),
    ...(variant === "withdrawn"
      ? [
          { key: "dispatch", header: t("dispatch"), cell: (r: ReminderRow) => <DispatchStatus reminder={r} /> },
          { key: "reason", header: t("reason"), cell: (r: ReminderRow) => r.cancellation?.reason ?? "—" },
        ]
      : []),
    ...(variant === "toSend"
      ? [
          {
            key: "state",
            header: t("state"),
            cell: (r: ReminderRow) =>
              r.artifactStatus !== "ready" ? (
                <span className="text-muted-foreground">{tc("artifactsPending")}</span>
              ) : overdueTodo(r) ? (
                <Badge variant="destructive">{tc("todoOverdue")}</Badge>
              ) : (
                <ReminderStatusBadge status={r.status} />
              ),
          },
          {
            key: "actions",
            header: <span className="sr-only">{t("actions")}</span>,
            cell: (r: ReminderRow) => (
              <span className="flex flex-wrap justify-end gap-2">
                <ReminderExportMenu id={r.id} disabled={r.artifactStatus !== "ready"} size="sm" />
                {canSend && (
                  <Button
                    className="h-11 md:h-8"
                    disabled={r.artifactStatus !== "ready"}
                    onClick={() => setMark(r.id)}
                    data-testid="reminder-mark-sent"
                  >
                    <SendIcon aria-hidden="true" />
                    {tc("markSent")}
                  </Button>
                )}
              </span>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <ResponsiveList
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        label={empty}
        testId={`reminders-${variant}`}
        rowClassName={(r) => (overdueTodo(r) ? "bg-danger/5" : undefined)}
      />
      {mark && <ReminderMarkSentDialog id={mark} onClose={() => setMark(null)} />}
    </>
  );
}

// ── invoice tabs ────────────────────────────────────────────────────────────────────────────────────────────────

function InvoiceTable({
  rows,
  variant,
  empty,
}: {
  rows: readonly InvoiceRow[];
  variant: "dueSoon" | "unmarked" | "paused" | "limitation";
  empty: string;
}) {
  const t = useTranslations("dunning.columns");
  const tc = useTranslations("dunning.cockpit");
  if (rows.length === 0) return <EmptyState icon={SirenIcon} title={empty} />;
  const columns: ListColumn<InvoiceRow>[] = [
    {
      key: "invoice",
      header: t("invoice"),
      cell: (r) => (
        <Link href={`/rechnungen/${r.id}` as Route} className="font-medium underline">
          {r.number || "—"}
        </Link>
      ),
    },
    { key: "customer", header: t("customer"), cell: (r) => r.contactName || "—" },
    { key: "due", header: t("dueDate"), cell: (r) => formatDate(r.dueDate) },
    { key: "open", header: t("open"), cell: (r) => money(r.openAmountCents), numeric: true },
  ];
  if (variant === "unmarked") {
    columns.push({
      key: "exported",
      header: t("exported"),
      cell: (r) =>
        r.firstExportedAt ? tc("exportedOn", { date: formatDateTime(r.firstExportedAt) }) : tc("notExported"),
    });
  }
  if (variant === "paused") {
    columns.push({
      key: "state",
      header: t("state"),
      cell: (r) =>
        r.disputed
          ? tc("disputed", { reason: r.disputed.reason })
          : r.blocked
            ? tc("blocked", { reason: r.blocked.reason })
            : r.caseStatus === "handed_over"
              ? tc("handedOver")
              : r.pausedUntil
                ? tc("pausedUntil", { date: formatDate(r.pausedUntil) })
                : tc("paused", { reason: r.pausedReason ?? "" }),
    });
  }
  if (variant === "limitation") {
    columns.push({
      key: "limitation",
      header: t("limitation"),
      cell: (r) => (
        <span className="flex flex-col gap-1">
          <LimitationBadge limitation={r.limitation} />
          {r.limitation?.message && <span className="text-muted-foreground text-xs">{r.limitation.message}</span>}
        </span>
      ),
    });
  }
  if (variant !== "dueSoon") columns.push({ key: "level", header: t("level"), cell: (r) => r.level, numeric: true });
  return (
    <ResponsiveList rows={rows} columns={columns} rowKey={(r) => r.id} label={empty} testId={`invoices-${variant}`} />
  );
}

// ── Läufe (DUN-037) ─────────────────────────────────────────────────────────────────────────────────────────────

function RunsTable({ rows }: { rows: readonly RunRow[] }) {
  const t = useTranslations("dunning.runs");
  if (rows.length === 0) return <EmptyState icon={SirenIcon} title={t("empty")} />;
  const columns: ListColumn<RunRow>[] = [
    { key: "date", header: t("date"), cell: (r) => formatDateTime(r.startedAt) },
    { key: "mode", header: t("mode"), cell: (r) => (r.mode === "auto" ? t("auto") : t("manual")) },
    { key: "evaluated", header: t("evaluated"), cell: (r) => r.evaluated, numeric: true },
    { key: "drafts", header: t("drafts"), cell: (r) => r.drafts, numeric: true },
    { key: "finalized", header: t("finalized"), cell: (r) => r.finalized, numeric: true },
    { key: "todos", header: t("todos"), cell: (r) => r.todos, numeric: true },
    { key: "errors", header: t("errors"), cell: (r) => r.errors, numeric: true },
    {
      key: "skipped",
      header: t("skipped"),
      cell: (r) =>
        r.skipped.length === 0 ? (
          "—"
        ) : (
          <ul className="flex flex-col gap-0.5 text-xs">
            {r.skipped.map((s) => (
              <li key={s.reason}>
                {s.label}: {s.count}
              </li>
            ))}
          </ul>
        ),
    },
  ];
  return <ResponsiveList rows={rows} columns={columns} rowKey={(r) => r.id} label={t("label")} testId="runs" />;
}

// ── Vorschau (DUN-031) and „Ausgewählte jetzt ausführen“ ────────────────────────────────────────────────────────

export const isActionable = (a: Pick<PreviewAction, "kind">): boolean =>
  a.kind === "create_draft" || a.kind === "finalize";

function PreviewPanel() {
  const t = useTranslations("dunning.preview");
  const preview = useAuthedQuery(api.dunning.preview, {});
  const canRun = useCan("dunning.run");
  const [deselected, setDeselected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  if (preview === undefined) return <div className="h-64" aria-busy="true" />;
  const actionable = preview.actions.filter(isActionable);
  const selected = actionable.map((a) => a.invoiceId).filter((id) => !deselected.includes(id));
  return (
    <div className="flex flex-col gap-3" data-testid="dunning-preview">
      <p className="text-muted-foreground text-sm">{t("intro", { date: formatDate(preview.date) })}</p>
      {!preview.bankDataCurrent && (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
          {preview.bankDataNote ?? t("bankDataStale")}
        </p>
      )}
      {preview.actions.length === 0 ? (
        <EmptyState icon={SirenIcon} title={t("empty")} />
      ) : (
        <PreviewList
          actions={preview.actions}
          selected={selected}
          onToggle={(id, on) => setDeselected((d) => (on ? d.filter((x) => x !== id) : [...d, id]))}
          selectable={canRun}
        />
      )}
      {canRun && actionable.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="h-11 md:h-9"
            disabled={selected.length === 0}
            onClick={() => setConfirm(true)}
            data-testid="run-selected"
          >
            <PlayIcon aria-hidden="true" />
            {t("runSelected")}
          </Button>
          <span className="text-muted-foreground text-sm">{t("selectedCount", { count: selected.length })}</span>
        </div>
      )}
      {confirm && <RunDialog invoiceIds={selected} onClose={() => setConfirm(false)} />}
    </div>
  );
}

export function PreviewList({
  actions,
  selected,
  onToggle,
  selectable,
}: {
  actions: readonly PreviewAction[];
  selected: readonly string[];
  onToggle: (invoiceId: string, on: boolean) => void;
  selectable: boolean;
}) {
  const t = useTranslations("dunning.preview");
  const tCol = useTranslations("dunning.columns");
  const box = (a: PreviewAction) =>
    selectable && isActionable(a) ? (
      <input
        type="checkbox"
        className="size-5 accent-primary md:size-4"
        aria-label={t("select", { number: a.number })}
        checked={selected.includes(a.invoiceId)}
        onChange={(e) => onToggle(a.invoiceId, e.target.checked)}
      />
    ) : null;
  const columns: ListColumn<PreviewAction>[] = [
    ...(selectable
      ? [
          {
            key: "select",
            header: <span className="sr-only">{t("selectColumn")}</span>,
            cell: box,
            tableOnly: true,
          },
        ]
      : []),
    {
      key: "invoice",
      header: tCol("invoice"),
      cell: (a) => (
        <span className="flex flex-col">
          <Link href={`/rechnungen/${a.invoiceId}` as Route} className="font-medium underline">
            {a.number}
          </Link>
          <span className="text-muted-foreground text-xs">{a.contactName}</span>
        </span>
      ),
    },
    {
      key: "action",
      header: tCol("action"),
      cell: (a) => (
        <span className="flex flex-col gap-0.5">
          <Badge variant={isActionable(a) ? "default" : "outline"} data-kind={a.kind}>
            {t(`kinds.${a.kind}`)}
          </Badge>
          <span className="text-xs">{a.reasonLabel}</span>
          {a.detail && <span className="text-muted-foreground text-xs">{a.detail}</span>}
        </span>
      ),
    },
    { key: "level", header: tCol("level"), cell: (a) => a.level ?? "—", numeric: true },
    { key: "fee", header: tCol("fee"), cell: (a) => (a.claim ? money(a.claim.feeCents) : "—"), numeric: true },
    {
      key: "interest",
      header: tCol("interest"),
      cell: (a) => (a.claim ? money(a.claim.interestCents) : "—"),
      numeric: true,
    },
    {
      key: "flatFee",
      header: tCol("flatFee"),
      cell: (a) =>
        a.claim ? (a.claim.flatFeeAlreadyClaimed ? t("flatFeeClaimed") : money(a.claim.flatFee40Cents)) : "—",
      numeric: true,
    },
    { key: "deadline", header: tCol("newDueDate"), cell: (a) => formatDate(a.claim?.newDueDate) },
    { key: "total", header: tCol("total"), cell: (a) => (a.claim ? money(a.claim.totalCents) : "—"), numeric: true },
    {
      key: "notes",
      header: tCol("notes"),
      cell: (a) =>
        a.notes.length === 0 ? (
          "—"
        ) : (
          <ul className="flex flex-col gap-0.5 text-xs">
            {a.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ),
    },
  ];
  return (
    <ResponsiveList
      rows={actions}
      columns={columns}
      rowKey={(a) => a.invoiceId}
      label={t("label")}
      testId="preview-actions"
      cardLead={selectable ? box : undefined}
    />
  );
}

/**
 * Confirm dialog of „Ausgewählte jetzt ausführen“: re-evaluates exactly the selection (its digest binds the run,
 * DUN-031 — a changed evaluation fails with `preview_outdated`), creates drafts or finalises. Never sends.
 */
function RunDialog({ invoiceIds, onClose }: { invoiceIds: string[]; onClose: () => void }) {
  const t = useTranslations("dunning.run");
  const run = useRun();
  const runDunning = useMutation(api.dunning.run);
  const canFinalize = useCan("invoices.finalize");
  const preview = useAuthedQuery(api.dunning.preview, { invoiceIds });
  const [mode, setMode] = useState<"drafts" | "finalize">("finalize");
  const drafts = preview?.actions.filter((a) => a.kind === "create_draft").length ?? 0;
  const finals = preview?.actions.filter((a) => a.kind === "finalize").length ?? 0;
  const offerFinalize = canFinalize && finals > 0;
  const effectiveMode = offerFinalize ? mode : "drafts";
  return (
    <ConfirmDialog
      title={t("title")}
      description={t("description")}
      confirmLabel={t("confirm")}
      confirmDisabled={!preview || drafts + finals === 0}
      onClose={onClose}
      onConfirm={async () => {
        if (!preview) return;
        const r = await run(() =>
          runDunning({
            mode: effectiveMode,
            invoiceIds: invoiceIds as Id<"salesDocuments">[],
            expectedDigest: preview.digest,
          }),
        );
        if (r.ok) {
          toast.success(
            t("done", { drafts: r.value.drafts, finalized: r.value.finalized.length, skipped: r.value.skipped }),
          );
          onClose();
        }
      }}
    >
      {preview === undefined ? (
        <div className="h-16" aria-busy="true" />
      ) : (
        <div className="flex flex-col gap-3 text-sm" data-testid="run-summary">
          <ul className="flex flex-col gap-1">
            <li>{t("drafts", { count: drafts })}</li>
            {finals > 0 && <li>{t("finalize", { count: finals })}</li>}
          </ul>
          {offerFinalize && (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 font-medium">{t("mode")}</legend>
              {(["finalize", "drafts"] as const).map((m) => (
                <label key={m} className="flex min-h-11 items-center gap-2 md:min-h-9">
                  <input
                    type="radio"
                    name="dunning-run-mode"
                    className="size-5 accent-primary md:size-4"
                    checked={mode === m}
                    onChange={() => setMode(m)}
                  />
                  {t(`modes.${m}`)}
                </label>
              ))}
            </fieldset>
          )}
          <p className="text-muted-foreground">{t("nothingSent")}</p>
        </div>
      )}
    </ConfirmDialog>
  );
}
