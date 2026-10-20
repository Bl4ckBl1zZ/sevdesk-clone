"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, formatDate, formatPercentBp, formatPrice, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { FactList, PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";
import { InvoiceEntriesDialog } from "@/components/time/invoice-dialog";
import { TimeEntryList } from "@/components/time/time-entries";
import { BudgetBar } from "@/components/time/time-shared";
import { TimerCard } from "@/components/time/timer";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SalesDocStatus } from "@/domain/documents/lifecycle";
import { formatEuro } from "@/domain/money/format";
import { formatMinutes } from "@/domain/projects/time-entries";
import { VOUCHER_STATUS_DE } from "@/domain/vouchers/lifecycle";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { ProjectSettingsForm } from "./project-form";

type Bundle = NonNullable<FunctionReturnType<typeof api.projects.get>>;
const TABS = ["overview", "times", "documents", "vouchers", "settings"] as const;

/** Project page (F11 §6 `/projekte/[id]`, PRJ-002/003/004): tabs and the primary action „Zeiten abrechnen“. */
export function ProjectDetail({ id }: { id: string }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <ProjectDetailInner id={id as Id<"projects">} />
    </ConvexGuard>
  );
}

function ProjectDetailInner({ id }: { id: Id<"projects"> }) {
  const t = useTranslations("projects.detail");
  const tl = useTranslations("projects.list");
  const tNav = useTranslations("nav");
  const data = useAuthedQuery(api.projects.get, { id });
  const canWrite = useCan("projects.write");
  const canTime = useCan("time.write");
  const [tab, setTab] = useState<string>("overview");
  if (data === undefined) return <div className="h-96" aria-busy="true" />;
  if (data === null) {
    return (
      <>
        <PageHeader title={t("notFound")} breadcrumbs={[{ label: tNav("items.projekte"), href: "/projekte" }]} />
        <PageBody>
          <p role="alert">{t("notFound")}</p>
        </PageBody>
      </>
    );
  }
  const p = data.project;
  const tabs = TABS.filter((k) => k !== "settings" || canWrite);
  return (
    <>
      <PageHeader
        title={p.name}
        description={`${p.number} · ${tl(`status.${p.status}`)}`}
        breadcrumbs={[{ label: tNav("items.projekte"), href: "/projekte" }, { label: p.name }]}
        actions={
          <>
            {canTime && p.billingMode !== "non_billable" && <InvoiceAction projectId={p._id} />}
            {canWrite && <StatusActions data={data} />}
          </>
        }
      />
      <PageBody className="@container/detail">
        {p.status === "archived" && (
          <p role="status" className="rounded-md border bg-muted p-3 text-sm">
            {t("archivedNotice")}
          </p>
        )}
        <div className="grid gap-4 @4xl/detail:grid-cols-[minmax(0,1fr)_20rem]">
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="min-w-0">
            <TabsList className="h-auto w-full justify-start overflow-x-auto">
              {tabs.map((k) => (
                <TabsTrigger key={k} value={k} className="h-11 flex-none px-3 md:h-9">
                  {t(`tabs.${k}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="overview" className="flex flex-col gap-4 pt-4">
              <Overview data={data} />
            </TabsContent>
            <TabsContent value="times" className="flex flex-col gap-4 pt-4">
              {p.status !== "archived" && <TimerCard projectId={p._id} />}
              <div className="-m-4 @3xl/main:-m-6">
                <TimeEntryList args={{ projectId: p._id }} projectId={p._id} pristine />
              </div>
            </TabsContent>
            <TabsContent value="documents" className="pt-4">
              <Documents data={data} />
            </TabsContent>
            <TabsContent value="vouchers" className="pt-4">
              <Vouchers data={data} />
            </TabsContent>
            {canWrite && (
              <TabsContent value="settings" className="pt-4">
                <ProjectSettingsForm
                  key={p._id}
                  project={p}
                  contact={
                    data.summary.contactId
                      ? { _id: data.summary.contactId, displayName: data.summary.contactName ?? "" }
                      : null
                  }
                  defaultProduct={data.defaultProduct}
                />
              </TabsContent>
            )}
          </Tabs>
          <Facts data={data} />
        </div>
      </PageBody>
    </>
  );
}

/** PRJ-010 primary action: the project's open billable entries in the „Zeiten abrechnen“ dialog. */
function InvoiceAction({ projectId }: { projectId: Id<"projects"> }) {
  const t = useTranslations("projects.detail");
  const [open, setOpen] = useState(false);
  const candidates = useAuthedQuery(api.timeEntries.list, { projectId, forInvoicing: true }, open);
  return (
    <>
      <Button className="h-11 md:h-9" onClick={() => setOpen(true)}>
        {t("invoice")}
      </Button>
      {open && candidates && <InvoiceEntriesDialog candidates={candidates} onClose={() => setOpen(false)} />}
    </>
  );
}

function StatusActions({ data }: { data: Bundle }) {
  const t = useTranslations("projects.detail");
  const router = useRouter();
  const run = useRun();
  const setStatus = useMutation(api.projects.setStatus);
  const remove = useMutation(api.projects.remove);
  const [confirm, setConfirm] = useState(false);
  const p = data.project;
  const change = async (status: "active" | "done" | "archived") => {
    const r = await run(() => setStatus({ id: p._id, status }), t("statusChanged"));
    if (r.ok && r.value.warning) toast.warning(r.value.warning);
  };
  return (
    <>
      {p.status === "active" && (
        <Button variant="outline" className="h-11 md:h-9" onClick={() => void change("done")}>
          {t("markDone")}
        </Button>
      )}
      {p.status !== "archived" ? (
        <Button variant="outline" className="h-11 md:h-9" onClick={() => void change("archived")}>
          {t("archive")}
        </Button>
      ) : (
        <Button variant="outline" className="h-11 md:h-9" onClick={() => void change("active")}>
          {t("reactivate")}
        </Button>
      )}
      {p.status === "done" && (
        <Button variant="outline" className="h-11 md:h-9" onClick={() => void change("active")}>
          {t("reactivate")}
        </Button>
      )}
      <Button variant="outline" className="h-11 text-danger md:h-9" onClick={() => setConfirm(true)}>
        {t("delete")}
      </Button>
      {confirm && (
        <ConfirmDialog
          title={t("deleteTitle")}
          description={t("deleteDescription")}
          confirmLabel={t("delete")}
          destructive
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            const r = await run(() => remove({ id: p._id }), t("deleted"));
            if (r.ok) router.push("/projekte");
            else setConfirm(false);
          }}
        />
      )}
    </>
  );
}

function Card({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-xl border p-4 text-sm" data-testid={testId}>
      <h2 id={id} className="font-semibold text-base">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Overview({ data }: { data: Bundle }) {
  const t = useTranslations("projects.detail");
  const s = data.summary;
  return (
    <>
      <Card title={t("budget")} testId="project-budget">
        {s.budget ? (
          <BudgetBar budget={s.budget} label={t("budgetProgress", { percent: Math.floor(s.budget.ratioBp / 100) })} />
        ) : (
          <p className="text-muted-foreground">{t("noBudget")}</p>
        )}
      </Card>
      <div className="grid gap-4 @xl/detail:grid-cols-2">
        <Card title={t("tracked")}>
          <p className="font-semibold text-xl tabular-nums">{formatMinutes(s.trackedMinutes)}</p>
        </Card>
        <Card title={t("unbilled")}>
          <p className="font-semibold text-xl tabular-nums">{formatEuro(s.unbilledValueCents)}</p>
          <p className="text-muted-foreground tabular-nums">{formatMinutes(s.unbilledMinutes)}</p>
        </Card>
      </div>
      <Profitability data={data} />
    </>
  );
}

/** PRJ-004: revenue after Storno/corrections − voucher costs − time costs; accrual or cash basis. */
function Profitability({ data }: { data: Bundle }) {
  const t = useTranslations("projects.detail");
  const [basis, setBasis] = useState<"accrual" | "cash">("accrual");
  const cash = useAuthedQuery(api.projects.profitability, { id: data.project._id, basis: "cash" }, basis === "cash");
  const r = basis === "cash" ? cash : data.profitability;
  const groupId = useId();
  return (
    <Card title={t("profitability")} testId="project-profitability">
      <div role="radiogroup" aria-labelledby={groupId} className="flex flex-wrap items-center gap-2">
        <span id={groupId} className="text-muted-foreground">
          {t("basis")}
        </span>
        {(["accrual", "cash"] as const).map((b) => (
          <Button
            key={b}
            role="radio"
            aria-checked={basis === b}
            variant={basis === b ? "default" : "outline"}
            className="h-11 md:h-8"
            onClick={() => setBasis(b)}
          >
            {t(`bases.${b}`)}
          </Button>
        ))}
      </div>
      {r ? (
        <FactList
          items={[
            { label: t("revenue"), value: formatEuro(r.revenueCents), numeric: true },
            { label: t("voucherCosts"), value: formatEuro(-r.voucherCostCents), numeric: true },
            { label: t("timeCosts"), value: formatEuro(-r.timeCostCents), numeric: true },
            { label: t("margin"), value: <strong>{formatEuro(r.marginCents)}</strong>, numeric: true },
            { label: t("marginPct"), value: formatPercentBp(r.marginBp), numeric: true },
          ]}
        />
      ) : (
        <div className="h-24" aria-busy="true" />
      )}
      <p className="text-muted-foreground text-xs">{t("profitHint")}</p>
    </Card>
  );
}

function Documents({ data }: { data: Bundle }) {
  const t = useTranslations("projects.detail");
  if (data.documents.length === 0) return <p className="text-muted-foreground text-sm">{t("noDocuments")}</p>;
  return (
    <div className="overflow-x-auto">
      <Table data-testid="project-documents">
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.number")}</TableHead>
            <TableHead>{t("columns.type")}</TableHead>
            <TableHead>{t("columns.date")}</TableHead>
            <TableHead>{t("columns.status")}</TableHead>
            <TableHead className="text-right">{t("columns.net")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.documents.map((d) => (
            <TableRow key={d._id}>
              <TableCell>
                <Link href={d.href as Route} className="font-medium hover:underline">
                  {d.number ?? t("draft")}
                </Link>
              </TableCell>
              <TableCell>{d.typeLabel}</TableCell>
              <TableCell className="tabular-nums">{formatDate(d.documentDate)}</TableCell>
              <TableCell>{t(`docStatus.${d.status as SalesDocStatus}`)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatEuro(d.netCents)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Vouchers({ data }: { data: Bundle }) {
  const t = useTranslations("projects.detail");
  if (data.vouchers.length === 0) return <p className="text-muted-foreground text-sm">{t("noVouchers")}</p>;
  return (
    <div className="overflow-x-auto">
      <Table data-testid="project-vouchers">
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.number")}</TableHead>
            <TableHead>{t("columns.supplier")}</TableHead>
            <TableHead>{t("columns.date")}</TableHead>
            <TableHead>{t("columns.status")}</TableHead>
            <TableHead className="text-right">{t("columns.net")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.vouchers.map((v) => (
            <TableRow key={v._id}>
              <TableCell>
                <Link href={v.href as Route} className="font-medium hover:underline">
                  {v.number ?? t("draft")}
                </Link>
              </TableCell>
              <TableCell>{v.supplierName ?? "—"}</TableCell>
              <TableCell className="tabular-nums">{formatDate(v.documentDate)}</TableCell>
              <TableCell>{VOUCHER_STATUS_DE[v.status]}</TableCell>
              <TableCell className="text-right tabular-nums">{formatEuro(v.netCents)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Facts({ data }: { data: Bundle }) {
  const t = useTranslations("projects.detail");
  const tf = useTranslations("projects.form");
  const p = data.project;
  const s = data.summary;
  return (
    <aside aria-label={t("facts")} className="flex flex-col gap-3 rounded-xl border p-4 text-sm">
      <h2 className="font-semibold text-base">{t("facts")}</h2>
      <FactList
        items={[
          { label: t("number"), value: p.number },
          {
            label: t("contact"),
            value: s.contactId ? (
              <Link href={`/kontakte/${s.contactId}` as Route} className="hover:underline">
                {s.contactName}
              </Link>
            ) : (
              "—"
            ),
          },
          { label: t("billingMode"), value: tf(`billingModes.${p.billingMode}`) },
          { label: t("rate"), value: p.hourlyRateMicros !== undefined ? formatPrice(p.hourlyRateMicros) : "—" },
          ...(data.defaultProduct ? [{ label: t("defaultProduct"), value: data.defaultProduct.name }] : []),
          ...(p.startDate || p.endDate
            ? [{ label: t("period"), value: `${formatDate(p.startDate)} – ${formatDate(p.endDate)}` }]
            : []),
        ]}
      />
    </aside>
  );
}
