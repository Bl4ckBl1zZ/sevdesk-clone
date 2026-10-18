"use client";

import type { FunctionReturnType } from "convex/server";
import {
  AlertTriangleIcon,
  ArrowLeftRightIcon,
  CalculatorIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleCheckIcon,
  FilePlus2Icon,
  UploadIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { canDo, type Permission } from "@/domain/access/permissions";
import { formatEuro } from "@/domain/money";
import type { MemberRole } from "@/domain/schemas/actor";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { formatIsoDate, formatTimestamp } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { api } from "../../../convex/_generated/api";
import { EXPENSE_BAR, INCOME_BAR, ResultChart } from "./result-chart";

/**
 * Übersicht (04 §4.7, DASH-001…011) — sevdesk layout: greeting, four quick actions, „Gewinn vor Steuern“, then the
 * widget grid (1 column on narrow containers, 2 from `@3xl/main`). All numbers come from `dashboard.overview`; this
 * file only formats. A widget whose data the role may not read is `null` and not rendered.
 */

export type DashboardData = FunctionReturnType<typeof api.dashboard.overview>;

export function Dashboard({ todos }: { todos?: React.ReactNode }) {
  return (
    <ConvexGuard fallback={<DashboardLoading />}>
      <DashboardLive todos={todos} />
    </ConvexGuard>
  );
}

function DashboardLive({ todos }: { todos?: React.ReactNode }) {
  const data = useAuthedQuery(api.dashboard.overview, {});
  if (data === undefined) return <DashboardLoading />;
  return <DashboardView data={data} todos={todos} />;
}

function Greeting({ name }: { name: string | null }) {
  const t = useTranslations("pages.start");
  return (
    <h1 id="page-title" tabIndex={-1} className="font-semibold text-2xl tracking-tight outline-none @3xl/main:text-3xl">
      {name ? t("greetingNamed", { name }) : t("greeting")}
    </h1>
  );
}

function DashboardLoading() {
  const t = useTranslations("pages.start");
  return (
    <div className="flex flex-col gap-6 p-4 @3xl/main:p-6" aria-busy="true">
      <Greeting name={null} />
      <p className="sr-only">{t("loading")}</p>
      <div className="grid grid-cols-2 gap-3 @3xl/main:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}

const can = (role: MemberRole | null, p: Permission) => role !== null && canDo(role, p);

export function DashboardView({ data, todos }: { data: DashboardData; todos?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6 p-4 @3xl/main:p-6">
      <Greeting name={data.greetingName} />
      <QuickActions role={data.role} />
      {data.result && <ResultCard result={data.result} />}
      <div className="grid gap-4 @3xl/main:grid-cols-2">
        {data.receivables && <ReceivablesCard r={data.receivables} canWrite={can(data.role, "documents.write")} />}
        {data.ku && <KuCard ku={data.ku} />}
        {data.bank && <BankCard bank={data.bank} />}
        {data.bank && <MatchingCard m={data.matching} canMatch={can(data.role, "banking.match")} />}
        {data.topCustomers && <TopCustomersCard customers={data.topCustomers} />}
        {data.activity && <ActivityCard lines={data.activity} />}
        {todos && (
          <Widget title={<TodosTitle />}>
            <CardContent>{todos}</CardContent>
          </Widget>
        )}
      </div>
    </div>
  );
}

function TodosTitle() {
  return useTranslations("pages.start.todos")("title");
}

// ── building blocks ───────────────────────────────────────────────────────────────────────────────────

function Widget({
  title,
  children,
  className,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("min-w-0", className)}>
      <Card className="h-full">
        <CardHeader>
          <CardTitle>
            <h2 id={id} className="font-semibold text-base">
              {title}
            </h2>
          </CardTitle>
        </CardHeader>
        {children}
      </Card>
    </section>
  );
}

/** Grey summary box (sevdesk „Ausstehender Betrag“, „Umsatz {Jahr}“, „Gesamtsaldo“). */
function SummaryBox({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-muted px-4 py-3">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="font-semibold text-2xl tabular-nums">{value}</span>
      {children}
    </div>
  );
}

const signed = (cents: number) => (cents > 0 ? `+${formatEuro(cents)}` : formatEuro(cents));
const percentText = (n: number) => `${n} %`;

// ── DASH-002 quick actions ────────────────────────────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  { key: "invoice", href: "/rechnungen/neu", icon: FilePlus2Icon, permission: "documents.write" },
  { key: "expense", href: "/posteingang", icon: UploadIcon, permission: "documents.write" },
  { key: "match", href: "/bank/zuordnungen", icon: ArrowLeftRightIcon, permission: "banking.match" },
  { key: "ustva", href: "/steuern/ustva", icon: CalculatorIcon, permission: "accounting.read" },
] as const satisfies readonly { key: string; href: Route; icon: unknown; permission: Permission }[];

function QuickActions({ role }: { role: MemberRole | null }) {
  const t = useTranslations("pages.start.quickActions");
  const actions = QUICK_ACTIONS.filter((a) => can(role, a.permission));
  if (actions.length === 0) return null;
  return (
    <nav aria-label={t("label")}>
      <ul className="grid grid-cols-2 gap-3 @3xl/main:grid-cols-4">
        {actions.map((a) => (
          <li key={a.key}>
            <Link
              href={a.href}
              className="flex h-full min-h-24 flex-col justify-between gap-3 rounded-xl border bg-card p-4 font-semibold text-sm shadow-xs outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <a.icon aria-hidden="true" className="size-6" />
              {t(a.key)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ── DASH-003 Gewinn vor Steuern ───────────────────────────────────────────────────────────────────────

function ResultCard({ result }: { result: NonNullable<DashboardData["result"]> }) {
  const t = useTranslations("pages.start.result");
  const hasData = result.months.some((m) => m.incomeCents !== 0 || m.expenseCents !== 0);
  return (
    <Widget title={t("title")}>
      <CardContent className="gap-4">
        <div className="flex flex-col gap-4 @3xl/main:flex-row @3xl/main:items-start @3xl/main:justify-between">
          <div className="flex flex-col gap-1">
            <span className="font-semibold text-3xl tabular-nums @3xl/main:text-4xl">
              {formatEuro(result.profitCents)}
            </span>
            <span className="text-muted-foreground text-xs">{t("hint")}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <LegendBox label={t("income")} value={formatEuro(result.incomeCents)} swatch={INCOME_BAR} />
            <LegendBox label={t("expense")} value={formatEuro(result.expenseCents)} swatch={EXPENSE_BAR} />
          </div>
        </div>
        {hasData ? (
          <ResultChart months={result.months} />
        ) : (
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        )}
      </CardContent>
      <CardFooter className="text-muted-foreground text-xs">{t("footer")}</CardFooter>
    </Widget>
  );
}

function LegendBox({ label, value, swatch }: { label: string; value: string; swatch: string }) {
  return (
    <div className="flex min-w-36 flex-col gap-1 rounded-lg border px-3 py-2">
      <span className="flex items-center gap-2 text-muted-foreground text-xs">
        <span aria-hidden="true" className={cn("size-2.5 rounded-full", swatch)} />
        {label}
      </span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

// ── DASH-004 Ausstehende Rechnungen ───────────────────────────────────────────────────────────────────

const RECEIVABLE_ROWS = [
  { key: "overdue", href: "/rechnungen?status=overdue" },
  { key: "open", href: "/rechnungen?status=open" },
  // The list has no „teilbezahlt“ filter; „Offen“ contains the partially paid invoices (04 §4.7 follow-up).
  { key: "partiallyPaid", href: "/rechnungen?status=open" },
] as const;

function ReceivablesCard({ r, canWrite }: { r: NonNullable<DashboardData["receivables"]>; canWrite: boolean }) {
  const t = useTranslations("pages.start.receivables");
  return (
    <Widget title={t("title")}>
      <CardContent>
        <SummaryBox label={t("total")} value={formatEuro(r.totalCents)} />
        <ul className="flex flex-col divide-y">
          {RECEIVABLE_ROWS.map((row) => {
            const b = r[row.key];
            return (
              <li key={row.key}>
                <Link
                  href={row.href as Route}
                  aria-label={t("rowLabel", { label: t(row.key), count: b.count, amount: formatEuro(b.cents) })}
                  className="flex min-h-11 items-center gap-3 rounded-md px-1 py-2 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="inline-flex min-w-7 justify-center rounded-full bg-muted px-2 py-0.5 font-medium text-xs tabular-nums">
                    {b.count}
                  </span>
                  <span className="flex-1">{t(row.key)}</span>
                  <span className="tabular-nums">{formatEuro(b.cents)}</span>
                  <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
      {canWrite && (
        <CardFooter className="mt-auto">
          <Link href="/rechnungen/neu" className={buttonVariants({ variant: "outline" })}>
            {t("create")}
          </Link>
        </CardFooter>
      )}
    </Widget>
  );
}

// ── DASH-005 Kleinunternehmergrenze ───────────────────────────────────────────────────────────────────

function KuCard({ ku }: { ku: NonNullable<DashboardData["ku"]> }) {
  const t = useTranslations("pages.start.ku");
  const percent = Math.floor(ku.shareBp / 100);
  return (
    <Widget title={t("title")}>
      <CardContent>
        <SummaryBox label={t("turnover", { year: ku.year })} value={formatEuro(ku.turnoverCents)} />
        {ku.limitCents === null ? (
          <p className="text-muted-foreground text-sm">{t("noRule", { year: ku.year })}</p>
        ) : (
          <>
            <Progress
              value={percent}
              aria-label={t("progressLabel", { year: ku.year, percent, limit: formatEuro(ku.limitCents) })}
              className={cn(
                ku.level === "exceeded" || ku.level === "critical"
                  ? "[&_[data-slot=progress-indicator]]:bg-danger"
                  : ku.level === "warn"
                    ? "[&_[data-slot=progress-indicator]]:bg-warning"
                    : "",
              )}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              {ku.level === "warn" || ku.level === "critical" ? (
                <span className="flex items-center gap-1">
                  <AlertTriangleIcon aria-hidden="true" className="size-4 text-warning" />
                  {t("warn", { percent })}
                </span>
              ) : ku.level === "exceeded" ? (
                <span className="flex items-center gap-1">
                  <AlertTriangleIcon aria-hidden="true" className="size-4 text-danger" />
                  {t("exceeded")}
                </span>
              ) : (
                <span />
              )}
              <span className="text-muted-foreground">{t("limit", { limit: formatEuro(ku.limitCents) })}</span>
            </div>
            {ku.priorYearLimitCents !== null && ku.currentYearLimitCents !== null && (
              <p className="text-muted-foreground text-sm">
                {t("explanation", {
                  prior: formatEuro(ku.priorYearLimitCents),
                  current: formatEuro(ku.currentYearLimitCents),
                })}
                {ku.foundingYear && ku.foundingYearLimitCents !== null && (
                  <> {t("foundingYear", { founding: formatEuro(ku.foundingYearLimitCents) })}</>
                )}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Widget>
  );
}

// ── DASH-006 Bank ─────────────────────────────────────────────────────────────────────────────────────

function BankCard({ bank }: { bank: NonNullable<DashboardData["bank"]> }) {
  const t = useTranslations("pages.start.bank");
  if (bank.accountCount === 0) {
    return (
      <Widget title={t("title")}>
        <CardContent>
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        </CardContent>
        <CardFooter className="mt-auto">
          <Link href="/bank" className={buttonVariants({ variant: "outline" })}>
            {t("addAccount")}
          </Link>
        </CardFooter>
      </Widget>
    );
  }
  return (
    <Widget title={t("title")}>
      <CardContent>
        <SummaryBox label={t("total")} value={formatEuro(bank.totalCents)}>
          {bank.accountsWithoutBalance > 0 && (
            <span className="text-muted-foreground text-xs">
              {t("missingBalance", { count: bank.accountsWithoutBalance })}
            </span>
          )}
        </SummaryBox>
        <h3 className="font-medium text-muted-foreground text-xs">{t("latest")}</h3>
        {bank.latest.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noTransactions")}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {bank.latest.map((tx) => (
              <li key={tx.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{tx.label}</span>
                  <span className="text-muted-foreground text-xs">{formatIsoDate(tx.bookingDate)}</span>
                </span>
                <span className={cn("tabular-nums", tx.amountCents > 0 && "text-success")}>
                  {signed(tx.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <CardFooter className="mt-auto">
        <Link href="/bank" className="text-sm underline-offset-4 hover:underline">
          {t("all")}
        </Link>
      </CardFooter>
    </Widget>
  );
}

// ── DASH-007 Zuordnungsquote ──────────────────────────────────────────────────────────────────────────

const LEVEL_ICON = { low: AlertTriangleIcon, medium: CircleCheckIcon, complete: CheckCircle2Icon } as const;
const LEVEL_COLOR = { low: "text-danger", medium: "text-warning", complete: "text-success" } as const;

function MatchingCard({ m, canMatch }: { m: DashboardData["matching"]; canMatch: boolean }) {
  const t = useTranslations("pages.start.matching");
  return (
    <Widget title={t("title")}>
      <CardContent>
        {m.percent === null || m.level === null ? (
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold text-3xl tabular-nums">{percentText(m.percent)}</span>
              <MatchingLevel level={m.level} />
            </div>
            <div role="img" aria-label={t("scaleLabel", { percent: m.percent })} className="relative pt-2">
              <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
                <span className="flex-[85] bg-danger" />
                <span className="flex-[14] bg-warning" />
                <span className="flex-[1] min-w-1.5 bg-success" />
              </div>
              <span
                aria-hidden="true"
                className="absolute top-0 h-4 w-1 -translate-x-1/2 rounded-full bg-foreground ring-2 ring-card"
                style={{ left: `${m.percent}%` }}
              />
              <div aria-hidden="true" className="mt-1 flex text-muted-foreground text-xs tabular-nums">
                <span className="flex-[85]">0</span>
                <span className="flex-[14]">85</span>
                <span>100</span>
              </div>
            </div>
            <p className="text-sm">{t("unassigned", { count: m.unassigned })}</p>
          </>
        )}
        <p className="text-muted-foreground text-sm">{t("explanation")}</p>
      </CardContent>
      {canMatch && (
        <CardFooter className="mt-auto">
          <Link href="/bank/zuordnungen" className={buttonVariants({ variant: "outline" })}>
            {t("action")}
          </Link>
        </CardFooter>
      )}
    </Widget>
  );
}

function MatchingLevel({ level }: { level: "low" | "medium" | "complete" }) {
  const t = useTranslations("pages.start.matching");
  const Icon = LEVEL_ICON[level];
  return (
    <span className="flex items-center gap-1 text-sm">
      <Icon aria-hidden="true" className={cn("size-4", LEVEL_COLOR[level])} />
      {t(level)}
    </span>
  );
}

// ── DASH-008 Top 5 Kunden ─────────────────────────────────────────────────────────────────────────────

function TopCustomersCard({ customers }: { customers: NonNullable<DashboardData["topCustomers"]> }) {
  const t = useTranslations("pages.start.topCustomers");
  return (
    <Widget title={t("title")}>
      <CardContent>
        <p className="text-muted-foreground text-xs">{t("period")}</p>
        {customers.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        ) : (
          <ol className="flex flex-col divide-y">
            {customers.map((c, i) => (
              <li key={c.contactId ?? c.name} className="flex items-center gap-3 py-2 text-sm">
                <span className="inline-flex size-6 items-center justify-center rounded-full bg-muted font-medium text-xs">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="tabular-nums">{formatEuro(c.amountCents)}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Widget>
  );
}

// ── DASH-009 Verlauf ──────────────────────────────────────────────────────────────────────────────────

function ActivityCard({ lines }: { lines: NonNullable<DashboardData["activity"]> }) {
  const t = useTranslations("pages.start.activity");
  return (
    <Widget title={t("title")}>
      <CardContent>
        {lines.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {lines.map((l) => (
              <li key={`${l.at}-${l.text}`} className="flex flex-col gap-0.5 py-2 text-sm">
                <span>{l.text}</span>
                <span className="text-muted-foreground text-xs">
                  <time dateTime={new Date(l.at).toISOString()}>{formatTimestamp(l.at, { withTime: true })}</time>
                  {" · "}
                  {l.by}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Widget>
  );
}
