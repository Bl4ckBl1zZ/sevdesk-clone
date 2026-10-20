"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import { CheckCircle2Icon, DownloadIcon, FileArchiveIcon, ListChecksIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useFreshAction } from "@/components/auth/fresh-action";
import {
  ConfirmDialog,
  formatDate,
  formatDateTime,
  selectClass,
  todayBerlin,
  useCan,
  useRun,
} from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { DatevReport, DatevScope } from "@/domain/datev/run";
import { formatEuro } from "@/domain/money";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * F09 §6 DATEV card on /export (P3, low priority; shown once Berater-/Mandantennummer exist): range presets, scope,
 * mode, Festschreibung → „Prüfen" (validation report drawer, EXP-007) → „Export erstellen" (job); the export history
 * with the stored ZIPs (EXP-009) and the advisor acceptance (EXP-016). Until the acceptance is recorded a banner is
 * shown and every download needs the „Testexport" confirmation (audited, E-EXP-18).
 */
export function DatevCard() {
  return (
    <ConvexGuard fallback={null}>
      <Inner />
    </ConvexGuard>
  );
}

const SCOPES: readonly DatevScope[] = [
  "revenue",
  "vouchers",
  "payments",
  "assets",
  "manual",
  "master_data",
  "documents",
];
type Fest = "auto" | "yes" | "no";

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Range presets relative to today: previous month, previous quarter, previous calendar year. */
export function presetRange(kind: "month" | "quarter" | "year", today: string): { from: string; to: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  if (kind === "month") {
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    return { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(lastDay(py, pm))}` };
  }
  if (kind === "quarter") {
    const q = Math.floor((m - 1) / 3);
    const py = q === 0 ? y - 1 : y;
    const pq = q === 0 ? 3 : q - 1;
    const fm = pq * 3 + 1;
    return { from: `${py}-${pad(fm)}-01`, to: `${py}-${pad(fm + 2)}-${pad(lastDay(py, fm + 2))}` };
  }
  return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
}

function Inner() {
  const t = useTranslations("exports.datev");
  const canRead = useCan("exports.datev.read");
  const canStart = useCan("exports.datev");
  const canAccept = useCan("exports.datev.acceptance");
  const status = useAuthedQuery(api.datev.status, {}, canRead);
  const list = useAuthedQuery(api.datev.list, {}, canRead);
  if (!canRead || !status?.configured) return null;
  const accepted = status.acceptance !== null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="@container flex flex-col gap-6">
        {!accepted && (
          <div role="status" className="flex gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{t("notAccepted")}</span>
          </div>
        )}
        {canStart && <ExportForm />}
        <History list={list} accepted={accepted} />
        <Acceptance status={status} canAccept={canAccept} />
      </CardContent>
    </Card>
  );
}

function ExportForm() {
  const t = useTranslations("exports.datev");
  const validate = useAction(api.datev.validate);
  const start = useMutation(api.datev.start);
  const startWithLock = useMutation(api.datev.startWithLock);
  const fresh = useFreshAction();
  const [lockPeriod, setLockPeriod] = useState(false);
  const run = useRun();
  const initial = presetRange("month", todayBerlin());
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [scope, setScope] = useState<DatevScope[]>([...SCOPES]);
  const [mode, setMode] = useState<"new" | "full">("new");
  const [fest, setFest] = useState<Fest>("auto");
  const [report, setReport] = useState<DatevReport | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = { from: useId(), to: useId(), mode: useId(), fest: useId(), lock: useId(), replace: useId() };
  const args = {
    from,
    to,
    scope,
    mode,
    ...(fest === "auto" ? {} : { festschreibung: fest === "yes" }),
    ...(confirmReplace ? { confirmReplace: true } : {}),
  };
  const check = async () => {
    setBusy(true);
    const r = await run(() => validate({ ...args, ...(lockPeriod ? { lockPeriod: true } : {}) }));
    setBusy(false);
    if (r.ok) setReport(r.value);
  };
  const create = async () => {
    setBusy(true);
    const r = await run(() => (lockPeriod ? fresh(() => startWithLock(args)) : start(args)), t("started"));
    setBusy(false);
    if (r.ok) {
      setReport(null);
      setConfirmReplace(false);
    }
  };
  return (
    <section aria-label={t("formLabel")} className="flex flex-col gap-4">
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">{t("presets")}</legend>
        {(["month", "quarter", "year"] as const).map((k) => (
          <Button
            key={k}
            variant="outline"
            className="h-11 md:h-8"
            onClick={() => {
              const r = presetRange(k, todayBerlin());
              setFrom(r.from);
              setTo(r.to);
            }}
          >
            {t(`preset.${k}`)}
          </Button>
        ))}
      </fieldset>
      <div className="grid gap-3 @lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.from}>{t("from")}</Label>
          <Input id={ids.from} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.to}>{t("to")}</Label>
          <Input id={ids.to} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.mode}>{t("mode")}</Label>
          <select
            id={ids.mode}
            className={selectClass}
            value={mode}
            onChange={(e) => setMode(e.target.value as "new" | "full")}
          >
            <option value="new">{t("modeNew")}</option>
            <option value="full">{t("modeFull")}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.fest}>{t("festschreibung")}</Label>
          <select id={ids.fest} className={selectClass} value={fest} onChange={(e) => setFest(e.target.value as Fest)}>
            <option value="auto">{t("festAuto")}</option>
            <option value="yes">{t("festYes")}</option>
            <option value="no">{t("festNo")}</option>
          </select>
        </div>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium text-sm">{t("scope")}</legend>
        <div className="grid gap-2 @md:grid-cols-2 @2xl:grid-cols-4">
          {SCOPES.map((s) => (
            <ScopeBox
              key={s}
              label={t(`scopes.${s}`)}
              checked={scope.includes(s)}
              onChange={(on) => setScope((cur) => (on ? [...cur, s] : cur.filter((x) => x !== s)))}
            />
          ))}
        </div>
      </fieldset>
      <div className="flex items-start gap-2">
        <Checkbox
          id={ids.lock}
          checked={lockPeriod}
          onCheckedChange={(v) => {
            setLockPeriod(v === true);
            setReport(null);
          }}
          aria-describedby={`${ids.lock}-hint`}
        />
        <div className="flex flex-col">
          <Label htmlFor={ids.lock} className="font-normal">
            {t("lockPeriod")}
          </Label>
          <span id={`${ids.lock}-hint`} className="text-muted-foreground text-xs">
            {t("lockPeriodHint")}
          </span>
        </div>
      </div>
      <div>
        <Button className="h-11 md:h-9" disabled={busy} onClick={check}>
          <ListChecksIcon aria-hidden="true" />
          {t("check")}
        </Button>
      </div>
      {report && (
        <Sheet open onOpenChange={(open) => !open && setReport(null)}>
          <SheetContent className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-lg">
            <SheetHeader>
              <SheetTitle>{t("reportTitle")}</SheetTitle>
              <SheetDescription>
                {t("reportSummary", {
                  rows: report.rowCount,
                  entries: report.entryCount,
                  sum: formatEuro(report.sumUmsatzCents),
                  fest: report.festschreibung,
                })}
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-4 px-4">
              {report.files.length > 0 && (
                <ul className="text-sm" aria-label={t("files")}>
                  {report.files.map((f) => (
                    <li key={f.name}>
                      {f.name} · {t("rows", { rows: f.rows })}
                    </li>
                  ))}
                </ul>
              )}
              {(["error", "warning", "info"] as const).map((level) => {
                const items = report.issues.filter((i) => i.level === level);
                if (items.length === 0) return null;
                return (
                  <section key={level} aria-label={t(`level.${level}`)} className="flex flex-col gap-1">
                    <h3 className="font-medium text-sm">
                      {t(`level.${level}`)} ({items.length})
                    </h3>
                    <ul className="list-disc pl-5 text-sm">
                      {items.map((i, n) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: messages may repeat
                        <li key={`${i.code}-${n}`}>{i.message}</li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              {report.issues.length === 0 && (
                <p className="flex items-center gap-2 text-sm">
                  <CheckCircle2Icon aria-hidden="true" className="size-4" />
                  {t("noIssues")}
                </p>
              )}
              {report.needsConfirmation && (
                <div className="flex items-start gap-2">
                  <Checkbox
                    id={ids.replace}
                    checked={confirmReplace}
                    onCheckedChange={(v) => setConfirmReplace(v === true)}
                  />
                  <Label htmlFor={ids.replace} className="font-normal">
                    {report.needsConfirmation}
                  </Label>
                </div>
              )}
            </div>
            <SheetFooter>
              <Button
                className="h-11 md:h-9"
                disabled={
                  busy || report.blocking || report.nothingToExport || (!!report.needsConfirmation && !confirmReplace)
                }
                onClick={create}
              >
                <FileArchiveIcon aria-hidden="true" />
                {t("create")}
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      )}
    </section>
  );
}

function ScopeBox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-center gap-2 md:min-h-8">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}

interface HistoryRow {
  id: string;
  from: string;
  to: string;
  scope: string[];
  mode: "new" | "full";
  festschreibung: boolean;
  isRepeat: boolean;
  doNotReimport: boolean;
  rowCount: number;
  sumUmsatzCents: number;
  sha256: string;
  name: string;
  actor: string;
  at: number;
}

function History({ list, accepted }: { list: HistoryRow[] | undefined; accepted: boolean }) {
  const t = useTranslations("exports.datev");
  const download = useMutation(api.datev.download);
  const run = useRun();
  const [confirming, setConfirming] = useState<HistoryRow | null>(null);
  const [ack, setAck] = useState(false);
  const ackId = useId();
  const fetchFile = async (row: HistoryRow, testConfirmed: boolean) => {
    const r = await run(() =>
      download({ id: row.id as Id<"datevExports">, ...(testConfirmed ? { testConfirmed: true } : {}) }),
    );
    if (r.ok && r.value.url) window.location.assign(r.value.url);
  };
  return (
    <section aria-label={t("history")} className="flex flex-col gap-2">
      <h3 className="font-medium text-sm">{t("history")}</h3>
      {!list ? (
        <div className="h-16" aria-busy="true" />
      ) : list.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-2 rounded-md border p-3 @md:flex-row @md:items-center @md:justify-between"
            >
              <span className="text-sm">
                <span className="font-medium">
                  {formatDate(r.from)} – {formatDate(r.to)}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  · {r.mode === "new" ? t("modeNew") : t("modeFull")}
                  {r.isRepeat ? ` · ${t("repeat")}` : ""}
                  {r.doNotReimport ? ` · ${t("doNotReimport")}` : ""} · {r.festschreibung ? t("festYes") : t("festNo")}{" "}
                  · {t("rows", { rows: r.rowCount })} · {formatEuro(r.sumUmsatzCents)} · SHA-256 {r.sha256.slice(0, 12)}
                  … · {formatDateTime(r.at)} · {r.scope.map((s) => t(`scopes.${s as DatevScope}`)).join(", ")}
                </span>
              </span>
              <Button
                variant="outline"
                className="h-11 md:h-8"
                onClick={() => {
                  if (accepted) void fetchFile(r, false);
                  else {
                    setAck(false);
                    setConfirming(r);
                  }
                }}
              >
                <DownloadIcon aria-hidden="true" />
                {t("download", { name: r.name })}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {confirming && (
        <ConfirmDialog
          title={t("testTitle")}
          description={t("notAccepted")}
          confirmLabel={t("testDownload")}
          confirmDisabled={!ack}
          onClose={() => setConfirming(null)}
          onConfirm={async () => {
            const row = confirming;
            setConfirming(null);
            await fetchFile(row, true);
          }}
        >
          <div className="flex items-start gap-2">
            <Checkbox id={ackId} checked={ack} onCheckedChange={(v) => setAck(v === true)} />
            <Label htmlFor={ackId} className="font-normal">
              {t("testAck")}
            </Label>
          </div>
        </ConfirmDialog>
      )}
    </section>
  );
}

interface StatusView {
  acceptance: {
    testedOn: string;
    formatVersion: 12 | 13;
    buKeysConfirmed: boolean;
    advisorName?: string | undefined;
    recordedAt: number;
  } | null;
  formatVersion: 12 | 13;
}

function Acceptance({ status, canAccept }: { status: StatusView; canAccept: boolean }) {
  const t = useTranslations("exports.datev");
  const record = useMutation(api.datev.recordAcceptance);
  const run = useRun();
  const [testedOn, setTestedOn] = useState(todayBerlin());
  const [version, setVersion] = useState<12 | 13>(status.formatVersion);
  const [bu, setBu] = useState(false);
  const [advisor, setAdvisor] = useState("");
  const [remarks, setRemarks] = useState("");
  const ids = { date: useId(), version: useId(), bu: useId(), advisor: useId(), remarks: useId() };
  const a = status.acceptance;
  return (
    <section aria-label={t("acceptance")} className="flex flex-col gap-3">
      <h3 className="font-medium text-sm">{t("acceptance")}</h3>
      {a ? (
        <p className="text-sm">
          {t("acceptedLine", {
            date: formatDate(a.testedOn),
            advisor: a.advisorName ?? "—",
            version: a.formatVersion,
          })}
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">{t("acceptanceHint")}</p>
      )}
      {canAccept && !a && (
        <form
          className="grid gap-3 @lg:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await run(
              () =>
                record({
                  testedOn,
                  formatVersion: version,
                  buKeysConfirmed: bu,
                  ...(advisor ? { advisorName: advisor } : {}),
                  ...(remarks ? { remarks } : {}),
                }),
              t("acceptanceSaved"),
            );
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.date}>{t("testedOn")}</Label>
            <Input id={ids.date} type="date" value={testedOn} onChange={(e) => setTestedOn(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.version}>{t("formatVersion")}</Label>
            <select
              id={ids.version}
              className={selectClass}
              value={version}
              onChange={(e) => setVersion(Number(e.target.value) as 12 | 13)}
            >
              <option value={13}>13</option>
              <option value={12}>12</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.advisor}>{t("advisorName")}</Label>
            <Input id={ids.advisor} value={advisor} onChange={(e) => setAdvisor(e.target.value)} />
          </div>
          <div className="flex min-h-11 items-center gap-2 md:min-h-9">
            <Checkbox id={ids.bu} checked={bu} onCheckedChange={(v) => setBu(v === true)} />
            <Label htmlFor={ids.bu} className="font-normal">
              {t("buKeysConfirmed")}
            </Label>
          </div>
          <div className="flex flex-col gap-1 @lg:col-span-2">
            <Label htmlFor={ids.remarks}>{t("remarks")}</Label>
            <Textarea id={ids.remarks} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>
          <div>
            <Button type="submit" className="h-11 md:h-9">
              {t("recordAcceptance")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
