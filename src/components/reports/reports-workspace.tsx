"use client";

import { api } from "@convex/_generated/api";
import { cn } from "cn";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  Building2Icon,
  ChartColumnIcon,
  FileDownIcon,
  ListChecksIcon,
  ListTreeIcon,
  PercentIcon,
  ScaleIcon,
  TrendingUpIcon,
  UsersIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { dateDe, euro } from "@/components/accounting/format";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { SELECT } from "@/components/tax/ustva-workspace";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { metaLines, type ReportMeta } from "@/domain/reports/meta";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * /auswertungen (F08 §6; RPT-001, RPT-003…RPT-007, RPT-014): tiles for every report; a report opens with its
 * parameters in the URL (`?bericht=bwa&monat=2026-03`), the „vorläufig“ badge while a covered month is not
 * festgeschrieben, the RPT-001 facts (Erstellt am, Parameter, Regelversionen) and PDF/CSV export.
 */

type ReportKey = "bwa" | "susa" | "kontenblatt" | "opos" | "umsatz";
const REPORTS: ReportKey[] = ["bwa", "susa", "kontenblatt", "opos", "umsatz"];

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
const yearStart = () => `${today().slice(0, 4)}-01-01`;
const lastMonth = () => {
  const d = today();
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

function useParams() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const get = (k: string, fallback: string) => params.get(k) || fallback;
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}` as Route, { scroll: false });
  };
  return { get, set, report: params.get("bericht") as ReportKey | null };
}

export function ReportsWorkspace() {
  return (
    <ConvexGuard fallback={null}>
      <Inner />
    </ConvexGuard>
  );
}

function Inner() {
  const p = useParams();
  const report = p.report && REPORTS.includes(p.report) ? p.report : null;
  return report ? <ReportView report={report} p={p} /> : <Tiles />;
}

type TileKey = ReportKey | "journal" | "anlagenspiegel" | "verprobung" | "liquiditaet";

const TILES: { key: TileKey; href: string; icon: typeof ChartColumnIcon }[] = [
  { key: "bwa", href: "/auswertungen?bericht=bwa", icon: ChartColumnIcon },
  { key: "susa", href: "/auswertungen?bericht=susa", icon: ScaleIcon },
  { key: "kontenblatt", href: "/auswertungen?bericht=kontenblatt", icon: ListTreeIcon },
  { key: "opos", href: "/auswertungen?bericht=opos", icon: ListChecksIcon },
  { key: "umsatz", href: "/auswertungen?bericht=umsatz", icon: UsersIcon },
  { key: "journal", href: "/buchhaltung/journal", icon: BookOpenIcon },
  { key: "anlagenspiegel", href: "/buchhaltung/anlagen", icon: Building2Icon },
  { key: "verprobung", href: "/steuern/ust-jahr", icon: PercentIcon },
  { key: "liquiditaet", href: "/auswertungen/liquiditaet", icon: TrendingUpIcon },
];

export function Tiles() {
  const t = useTranslations("reports.tiles");
  return (
    <ul className="@container grid grid-cols-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-3">
      {TILES.map(({ key, href, icon: Icon }) => (
        <li key={key}>
          <Link
            href={href as Route}
            className="flex h-full gap-3 rounded-lg border p-4 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <span className="flex flex-col gap-1">
              <span className="font-medium">{t(`${key}.title`)}</span>
              <span className="text-muted-foreground text-sm">{t(`${key}.description`)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

type P = ReturnType<typeof useParams>;

function ReportView({ report, p }: { report: ReportKey; p: P }) {
  const t = useTranslations("reports");
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/auswertungen" className={cn(buttonVariants({ variant: "ghost" }), "h-11 md:h-9")}>
          <ArrowLeftIcon aria-hidden="true" />
          {t("back")}
        </Link>
      </div>
      <h2 className="font-semibold text-lg">{t(`tiles.${report}.title`)}</h2>
      {report === "bwa" && <BwaReport p={p} />}
      {report === "susa" && <SusaReport p={p} />}
      {report === "kontenblatt" && <LedgerReport p={p} />}
      {report === "opos" && <OposReport p={p} />}
      {report === "umsatz" && <RevenueReport p={p} />}
    </div>
  );
}

// ── shared pieces ──────────────────────────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
    </div>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      {(id) => <Input id={id} type="date" className="w-44" value={value} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <select id={id} className={`${SELECT} w-56`} value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

type DownloadArgs = {
  report: "susa" | "ledger" | "bwa" | "opos" | "revenue";
  params: Record<string, string | boolean>;
};

function Downloads(args: DownloadArgs) {
  const t = useTranslations("reports");
  const download = useAction(api.reportsNode.download);
  const showError = useAdapterErrorToast();
  const [busy, setBusy] = useState(false);
  const get = async (format: "pdf" | "csv") => {
    setBusy(true);
    try {
      const r = await download({ ...args, format });
      const url = URL.createObjectURL(new Blob([r.data], { type: r.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ml-auto flex gap-2">
      {(["pdf", "csv"] as const).map((f) => (
        <Button key={f} variant="outline" className="h-11 md:h-9" disabled={busy} onClick={() => get(f)}>
          <FileDownIcon aria-hidden="true" />
          {t(f)}
        </Button>
      ))}
    </div>
  );
}

export function MetaFacts({ meta }: { meta: ReportMeta }) {
  const t = useTranslations("reports");
  return (
    <div className="flex flex-col gap-2">
      {meta.provisional ? (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Badge variant="outline">{t("provisional")}</Badge>
          <span className="text-muted-foreground">{meta.notice}</span>
        </p>
      ) : (
        <p className="text-sm">
          <Badge variant="secondary">{t("locked")}</Badge>
        </p>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
        {metaLines(meta).map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const Num = ({ cents, className = "" }: { cents: number | null; className?: string }) => (
  <TableCell className={`text-right tabular-nums ${className}`}>{cents === null ? "—" : euro(cents)}</TableCell>
);
const HeadNum = ({ children }: { children: ReactNode }) => <TableHead className="text-right">{children}</TableHead>;

const Busy = () => <div className="h-60" aria-busy="true" />;

// ── BWA ────────────────────────────────────────────────────────────────────────────────────────────────

function BwaReport({ p }: { p: P }) {
  const t = useTranslations("reports.bwa");
  const month = p.get("monat", lastMonth());
  const variant = p.get("variante", "accrual") as "accrual" | "cash";
  const data = useAuthedQuery(api.reports.bwa, { month, variant });
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("month")}>
          {(id) => (
            <Input
              id={id}
              type="month"
              className="w-44"
              value={month}
              onChange={(e) => p.set({ monat: e.target.value })}
            />
          )}
        </Field>
        <Choice
          label={t("variant")}
          value={variant}
          options={[
            { value: "accrual", label: t("accrual") },
            { value: "cash", label: t("cash") },
          ]}
          onChange={(v) => p.set({ variante: v })}
        />
        <Downloads report="bwa" params={{ month, variant }} />
      </div>
      {data === undefined ? (
        <Busy />
      ) : (
        <>
          <MetaFacts meta={data.meta} />
          <Table aria-label={t("tableLabel")} scrollLabel={t("tableLabel")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("row")}</TableHead>
                <HeadNum>{t("monthCol")}</HeadNum>
                <HeadNum>{t("ytd")}</HeadNum>
                <HeadNum>{t("share")}</HeadNum>
                <HeadNum>{t("priorYtd")}</HeadNum>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r) => (
                <TableRow key={r.key} className={r.sum ? "font-medium" : undefined}>
                  <TableCell>{r.label}</TableCell>
                  <Num cents={r.monthCents} />
                  <Num cents={r.ytdCents} />
                  <TableCell className="text-right tabular-nums">
                    {r.ytdShareBp === null ? "—" : `${(r.ytdShareBp / 100).toLocaleString("de-DE")} %`}
                  </TableCell>
                  <Num cents={r.priorYtdCents} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </>
  );
}

// ── SuSa ───────────────────────────────────────────────────────────────────────────────────────────────

function SusaReport({ p }: { p: P }) {
  const t = useTranslations("reports.susa");
  const from = p.get("von", yearStart());
  const to = p.get("bis", today());
  const accountClass = p.get("klasse", "");
  const data = useAuthedQuery(api.reports.susa, { from, to, ...(accountClass ? { accountClass } : {}) });
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <DateField label={t("from")} value={from} onChange={(v) => p.set({ von: v })} />
        <DateField label={t("to")} value={to} onChange={(v) => p.set({ bis: v })} />
        <Choice
          label={t("accountClass")}
          value={accountClass}
          options={[
            { value: "", label: t("allClasses") },
            ...Array.from({ length: 10 }, (_, i) => ({ value: String(i), label: t("class", { n: i }) })),
          ]}
          onChange={(v) => p.set({ klasse: v })}
        />
        <Downloads report="susa" params={{ from, to, ...(accountClass ? { accountClass } : {}) }} />
      </div>
      {data === undefined ? (
        <Busy />
      ) : (
        <>
          <MetaFacts meta={data.meta} />
          <Table aria-label={t("tableLabel")} scrollLabel={t("tableLabel")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("account")}</TableHead>
                <TableHead>{t("name")}</TableHead>
                <HeadNum>{t("opening")}</HeadNum>
                <HeadNum>{t("periodDebit")}</HeadNum>
                <HeadNum>{t("periodCredit")}</HeadNum>
                <HeadNum>{t("ytdDebit")}</HeadNum>
                <HeadNum>{t("ytdCredit")}</HeadNum>
                <HeadNum>{t("balance")}</HeadNum>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground">
                    {t("empty")}
                  </TableCell>
                </TableRow>
              )}
              {data.rows.map((r) => (
                <TableRow key={r.account}>
                  <TableCell>
                    <Link
                      className="underline-offset-4 hover:underline"
                      href={`/auswertungen?bericht=kontenblatt&konto=${r.account}&von=${from}&bis=${to}` as Route}
                    >
                      {r.account}
                    </Link>
                  </TableCell>
                  <TableCell>{r.name}</TableCell>
                  <Num cents={r.openingCents} />
                  <Num cents={r.periodDebitCents} />
                  <Num cents={r.periodCreditCents} />
                  <Num cents={r.ytdDebitCents} />
                  <Num cents={r.ytdCreditCents} />
                  <Num cents={r.balanceCents} />
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2}>{t("total")}</TableCell>
                <Num cents={data.totals.openingCents} />
                <Num cents={data.totals.periodDebitCents} />
                <Num cents={data.totals.periodCreditCents} />
                <Num cents={data.totals.ytdDebitCents} />
                <Num cents={data.totals.ytdCreditCents} />
                <Num cents={data.totals.balanceCents} />
              </TableRow>
            </TableFooter>
          </Table>
        </>
      )}
    </>
  );
}

// ── Kontenblatt ────────────────────────────────────────────────────────────────────────────────────────

function LedgerReport({ p }: { p: P }) {
  const t = useTranslations("reports.ledger");
  const from = p.get("von", yearStart());
  const to = p.get("bis", today());
  const account = p.get("konto", "");
  const [draft, setDraft] = useState(account);
  const data = useAuthedQuery(api.reports.ledger, { account, from, to }, account !== "");
  return (
    <>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          p.set({ konto: draft.trim() });
        }}
      >
        <Field label={t("account")}>
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              className="w-32"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => p.set({ konto: draft.trim() })}
            />
          )}
        </Field>
        <DateField label={t("from")} value={from} onChange={(v) => p.set({ von: v })} />
        <DateField label={t("to")} value={to} onChange={(v) => p.set({ bis: v })} />
        <Button type="submit" variant="secondary" className="h-11 md:h-9">
          {t("show")}
        </Button>
        {account && <Downloads report="ledger" params={{ account, from, to }} />}
      </form>
      {!account ? (
        <p className="text-muted-foreground text-sm">{t("pick")}</p>
      ) : data === undefined ? (
        <Busy />
      ) : (
        <>
          <MetaFacts meta={data.meta} />
          <p className="text-sm">
            {data.account} {data.name}
          </p>
          <Table aria-label={t("tableLabel")} scrollLabel={t("tableLabel")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("date")}</TableHead>
                <TableHead>{t("beleg")}</TableHead>
                <TableHead>{t("text")}</TableHead>
                <TableHead>{t("contra")}</TableHead>
                <HeadNum>{t("debit")}</HeadNum>
                <HeadNum>{t("credit")}</HeadNum>
                <HeadNum>{t("balance")}</HeadNum>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell colSpan={6}>{t("opening")}</TableCell>
                <Num cents={data.openingCents} />
              </TableRow>
              {data.rows.map((r) => (
                <TableRow key={`${r.entryId}-${r.seq}-${r.debitCents}-${r.creditCents}`}>
                  <TableCell>{dateDe(r.date)}</TableCell>
                  <TableCell>
                    {r.href ? (
                      <Link className="underline-offset-4 hover:underline" href={r.href as Route}>
                        {r.belegfeld1 || t("source")}
                      </Link>
                    ) : (
                      r.belegfeld1
                    )}
                  </TableCell>
                  <TableCell>{r.text}</TableCell>
                  <TableCell>{r.contra}</TableCell>
                  <Num cents={r.debitCents || null} />
                  <Num cents={r.creditCents || null} />
                  <Num cents={r.balanceCents} />
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4}>{t("total")}</TableCell>
                <Num cents={data.debitCents} />
                <Num cents={data.creditCents} />
                <Num cents={data.closingCents} />
              </TableRow>
            </TableFooter>
          </Table>
        </>
      )}
    </>
  );
}

// ── Offene Posten (Stichtag) ───────────────────────────────────────────────────────────────────────────

type Opos = FunctionReturnType<typeof api.reports.openItems>;

function OposReport({ p }: { p: P }) {
  const t = useTranslations("reports.opos");
  const side = p.get("seite", "debtors") as "debtors" | "creditors";
  const asOf = p.get("stichtag", today());
  const data = useAuthedQuery(api.reports.openItems, { side, asOf });
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Choice
          label={t("side")}
          value={side}
          options={[
            { value: "debtors", label: t("debtors") },
            { value: "creditors", label: t("creditors") },
          ]}
          onChange={(v) => p.set({ seite: v })}
        />
        <DateField label={t("asOf")} value={asOf} onChange={(v) => p.set({ stichtag: v })} />
        <Downloads report="opos" params={{ side, asOf }} />
      </div>
      {data === undefined ? <Busy /> : <OposTable data={data} />}
    </>
  );
}

function OposTable({ data }: { data: Opos }) {
  const t = useTranslations("reports.opos");
  const rec = data.reconciliation;
  return (
    <>
      <MetaFacts meta={data.meta} />
      {rec.message && (
        <section role="alert" className="flex flex-col gap-1 rounded-md border border-destructive/50 p-3 text-sm">
          <p className="font-medium">{rec.message}</p>
          <p className="text-muted-foreground">
            {t("reconciliation", { account: data.account ?? "—", balance: euro(rec.accountBalanceCents) })}
          </p>
          {rec.causes.length > 0 && (
            <>
              <p>{t("causes")}</p>
              <ul className="list-disc pl-5">
                {rec.causes.map((c) => (
                  <li key={`${c.entryId}-${c.cents}`}>
                    {dateDe(c.date)} · {c.text} · {euro(c.cents)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      <Table aria-label={t("tableLabel")} scrollLabel={t("tableLabel")}>
        <TableHeader>
          <TableRow>
            <TableHead>{t("number")}</TableHead>
            <TableHead>{t("contact")}</TableHead>
            <TableHead>{t("date")}</TableHead>
            <TableHead>{t("due")}</TableHead>
            <HeadNum>{t("amount")}</HeadNum>
            <HeadNum>{t("open")}</HeadNum>
            <TableHead>{t("bucket")}</TableHead>
            {data.side === "debtors" && <TableHead>{t("dunning")}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-muted-foreground">
                {t("empty")}
              </TableCell>
            </TableRow>
          )}
          {data.items.map((i) => (
            <TableRow key={i.id}>
              <TableCell>
                {i.href ? (
                  <Link className="underline-offset-4 hover:underline" href={i.href as Route}>
                    {i.number}
                  </Link>
                ) : (
                  i.number
                )}
              </TableCell>
              <TableCell>{i.contactName}</TableCell>
              <TableCell>{dateDe(i.documentDate)}</TableCell>
              <TableCell>{i.dueDate ? dateDe(i.dueDate) : "—"}</TableCell>
              <Num cents={i.payableCents} />
              <Num cents={i.openCents} />
              <TableCell>{data.totals.buckets.find((b) => b.key === i.bucket)?.label ?? i.bucket}</TableCell>
              {data.side === "debtors" && (
                <TableCell>
                  {data.dunningLevels[i.id] ? t("level", { n: data.dunningLevels[i.id] ?? 0 }) : "—"}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={5}>{t("total")}</TableCell>
            <Num cents={rec.openItemsCents} />
            <TableCell colSpan={2} />
          </TableRow>
        </TableFooter>
      </Table>
    </>
  );
}

// ── Umsatz ─────────────────────────────────────────────────────────────────────────────────────────────

function RevenueReport({ p }: { p: P }) {
  const t = useTranslations("reports.revenue");
  const from = p.get("von", yearStart());
  const to = p.get("bis", today());
  const groupBy = p.get("gruppe", "customer") as "customer" | "product" | "month" | "cost_center";
  const basis = p.get("basis", "document_date") as "document_date" | "supply_date" | "cash";
  const data = useAuthedQuery(api.reports.revenue, { from, to, groupBy, basis });
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <DateField label={t("from")} value={from} onChange={(v) => p.set({ von: v })} />
        <DateField label={t("to")} value={to} onChange={(v) => p.set({ bis: v })} />
        <Choice
          label={t("groupBy")}
          value={groupBy}
          options={(["customer", "product", "month", "cost_center"] as const).map((g) => ({
            value: g,
            label: t(`groups.${g}`),
          }))}
          onChange={(v) => p.set({ gruppe: v })}
        />
        <Choice
          label={t("basis")}
          value={basis}
          options={(["document_date", "supply_date", "cash"] as const).map((b) => ({
            value: b,
            label: t(`bases.${b}`),
          }))}
          onChange={(v) => p.set({ basis: v })}
        />
        <Downloads report="revenue" params={{ from, to, groupBy, basis }} />
      </div>
      {data === undefined ? (
        <Busy />
      ) : (
        <>
          <MetaFacts meta={data.meta} />
          <Table aria-label={t("tableLabel")} scrollLabel={t("tableLabel")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t(`groups.${groupBy}`)}</TableHead>
                <HeadNum>{t("documents")}</HeadNum>
                <HeadNum>{t("net")}</HeadNum>
                <HeadNum>{t("gross")}</HeadNum>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.groups.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    {t("empty")}
                  </TableCell>
                </TableRow>
              )}
              {data.groups.map((g) => (
                <TableRow key={g.key}>
                  <TableCell>{g.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{g.documents}</TableCell>
                  <Num cents={g.netCents} />
                  <Num cents={g.grossCents} />
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2}>{t("total")}</TableCell>
                <Num cents={data.totals.netCents} />
                <Num cents={data.totals.grossCents} />
              </TableRow>
            </TableFooter>
          </Table>
        </>
      )}
    </>
  );
}
