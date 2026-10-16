"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import { PauseIcon, PlayIcon, Trash2Icon, ZapIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, formatDate, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { InvoiceStatusBadge, money } from "@/components/invoices/invoice-shared";
import { PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DisplayStatus } from "@/domain/documents/display-status";
import { documentPath } from "@/domain/documents/doc-types";
import type { RecurringTemplateValues } from "@/domain/schemas/recurring";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { RecurringEditor } from "./recurring-editor";

const BASE = "/rechnungen/wiederkehrend";

/** Vorlage (F04 §6.5): header with state and actions, the editor and the generated documents. */
export function RecurringDetail({ id }: { id: string }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <RecurringDetailInner id={id as Id<"recurringTemplates">} />
    </ConvexGuard>
  );
}

function RecurringDetailInner({ id }: { id: Id<"recurringTemplates"> }) {
  const t = useTranslations("recurring.detail");
  const tl = useTranslations("recurring.list");
  const te = useTranslations("recurring.editor");
  const tNav = useTranslations("nav");
  const router = useRouter();
  const run = useRun();
  const tpl = useAuthedQuery(api.recurring.get, { id });
  const canWrite = useCan("documents.write");
  const canFinalize = useCan("invoices.finalize");
  const runNow = useAction(api.recurring.runNow);
  const pause = useMutation(api.recurring.pause);
  const remove = useMutation(api.recurring.remove);
  const confirmAutomation = useMutation(api.recurring.confirmAutomation);
  const [resume, setResume] = useState(false);
  const [del, setDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const crumbs = [
    { label: tNav("items.rechnungen"), href: "/rechnungen" as Route },
    { label: tNav("items.wiederkehrend"), href: BASE as Route },
  ];
  if (tpl === undefined) return <div className="h-96" aria-busy="true" />;
  if (tpl === null) {
    return (
      <>
        <PageHeader title={t("notFound")} breadcrumbs={crumbs} />
        <PageBody>
          <p className="text-muted-foreground">{t("notFound")}</p>
        </PageBody>
      </>
    );
  }
  const values = {
    name: tpl.name,
    ...(tpl.contractReference ? { contractReference: tpl.contractReference } : {}),
    draft: tpl.draft,
    schedule: {
      interval: tpl.schedule.interval,
      firstDate: tpl.schedule.firstDate,
      ...(tpl.schedule.endDate ? { endDate: tpl.schedule.endDate } : {}),
      ...(tpl.schedule.maxCount !== undefined ? { maxCount: tpl.schedule.maxCount } : {}),
      billing: tpl.schedule.billing,
      periodTextEnabled: tpl.schedule.periodTextEnabled,
    },
    automation: tpl.automation,
  } as unknown as RecurringTemplateValues;
  const editable = canWrite && !tpl.archived;
  const actions = editable && (
    <div className="flex flex-wrap gap-2">
      {tpl.state === "active" && (
        <Button
          className="h-11 md:h-9"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await run(() => runNow({ id }));
            setBusy(false);
            if (r.ok) toast.success(tl("runNowDone", { created: r.value.created, finalized: r.value.finalized }));
          }}
        >
          <ZapIcon aria-hidden="true" />
          {tl("runNow")}
        </Button>
      )}
      {tpl.state === "active" && (
        <Button variant="outline" className="h-11 md:h-9" onClick={() => void run(() => pause({ id }), tl("paused"))}>
          <PauseIcon aria-hidden="true" />
          {tl("pause")}
        </Button>
      )}
      {tpl.state === "paused" && (
        <Button variant="outline" className="h-11 md:h-9" onClick={() => setResume(true)}>
          <PlayIcon aria-hidden="true" />
          {tl("resume")}
        </Button>
      )}
      <Button variant="ghost" className="h-11 md:h-9" onClick={() => setDel(true)}>
        <Trash2Icon aria-hidden="true" />
        {t("delete")}
      </Button>
    </div>
  );

  return (
    <>
      <PageHeader
        title={tpl.name}
        description={[
          t(`state.${tpl.state}`),
          tpl.intervalLabel,
          tpl.contactName ?? "—",
          tpl.nextDate ? t("next", { date: formatDate(tpl.nextDate) }) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        breadcrumbs={[...crumbs, { label: tpl.name }]}
        actions={actions}
      />
      <PageBody>
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" data-testid="template-state">
              {t(`state.${tpl.state}`)}
            </Badge>
            <span className="text-muted-foreground text-sm">
              {tpl.automationEffective
                ? tl("automationOn")
                : tpl.automation.finalize
                  ? tl("automationPending")
                  : tl("automationOff")}
            </span>
            {tpl.automation.finalize && !tpl.automationConfirmed && canFinalize && !tpl.archived && (
              <Button
                variant="outline"
                size="sm"
                className="h-11 md:h-8"
                onClick={() => void run(() => confirmAutomation({ id }), te("saved"))}
              >
                {te("confirmAutomation")}
              </Button>
            )}
            {tpl.skippedOccurrences.length > 0 && (
              <span className="text-muted-foreground text-xs">
                {t("skipped", { dates: tpl.skippedOccurrences.map((d) => formatDate(d)).join(", ") })}
              </span>
            )}
          </div>

          {editable && (
            <RecurringEditor
              key={tpl.version}
              id={id}
              initial={values}
              version={tpl.version}
              automationConfirmed={tpl.automationConfirmed}
              started={tpl.generatedCount > 0 || tpl.skippedOccurrences.length > 0}
              inlineActions
            />
          )}

          <section aria-label={t("documents")} className="flex flex-col gap-3 rounded-xl border p-4">
            <h2 className="font-semibold text-base">{t("documents")}</h2>
            {tpl.documents.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("noDocuments")}</p>
            ) : (
              <ul className="flex flex-col divide-y text-sm" data-testid="generated-documents">
                {tpl.documents.map((d) => (
                  <li key={d._id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="flex flex-col gap-0.5">
                      <Link href={documentPath(d.type, d._id) as Route} className="font-medium hover:underline">
                        {d.number ?? t("draft")}
                      </Link>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {t("period")}:{" "}
                        {d.supplyDate?.kind === "period"
                          ? `${formatDate(d.supplyDate.from)} – ${formatDate(d.supplyDate.to)}`
                          : formatDate(d.occurrence)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="tabular-nums">{money(d.grossCents, d.currency)}</span>
                      <InvoiceStatusBadge
                        token={d.displayStatus.token as DisplayStatus}
                        label={d.displayStatus.label}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </PageBody>
      {resume && <ResumeDialog id={id} onClose={() => setResume(false)} />}
      {del && (
        <ConfirmDialog
          title={t("deleteTitle")}
          description={t("deleteDescription")}
          confirmLabel={t("delete")}
          destructive
          onConfirm={async () => {
            const r = await run(() => remove({ id }));
            if (r.ok) {
              toast.success(r.value.result === "deleted" ? t("deleted") : t("archived"));
              router.push(BASE as Route);
            }
          }}
          onClose={() => setDel(false)}
        />
      )}
    </>
  );
}

/** REC-10: on resume the owner chooses „Nachberechnen“ or „Überspringen“ (audited). */
export function ResumeDialog({ id, onClose }: { id: Id<"recurringTemplates">; onClose: () => void }) {
  const t = useTranslations("recurring.detail");
  const tl = useTranslations("recurring.list");
  const run = useRun();
  const resume = useMutation(api.recurring.resume);
  const [catchUp, setCatchUp] = useState(false);
  return (
    <ConfirmDialog
      title={t("resumeTitle")}
      description={t("resumeDescription")}
      confirmLabel={tl("resume")}
      onConfirm={async () => {
        const r = await run(() => resume({ id, catchUp }), tl("resumed"));
        if (r.ok) onClose();
      }}
      onClose={onClose}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{t("resumeTitle")}</legend>
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input
            type="radio"
            name="resume-mode"
            className="mt-1 size-5 accent-primary md:size-4"
            checked={!catchUp}
            onChange={() => setCatchUp(false)}
          />
          <span>
            <span className="font-medium">{t("skip")}</span>
            <span className="block text-muted-foreground text-xs">{t("skipHint")}</span>
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-2 text-sm">
          <input
            type="radio"
            name="resume-mode"
            className="mt-1 size-5 accent-primary md:size-4"
            checked={catchUp}
            onChange={() => setCatchUp(true)}
          />
          <span>
            <span className="font-medium">{t("catchUp")}</span>
            <span className="block text-muted-foreground text-xs">{t("catchUpHint")}</span>
          </span>
        </label>
      </fieldset>
    </ConfirmDialog>
  );
}
