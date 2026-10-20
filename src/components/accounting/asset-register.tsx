"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CalculatorIcon, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { parseCents } from "@/domain/money/parse";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { dateDe, euro, periodDe } from "./format";

type Row = FunctionReturnType<typeof api.assets.list>[number];
type Detail = FunctionReturnType<typeof api.assets.detail>;
type Method = Row["method"];

const SELECT =
  "h-11 w-full rounded-md border border-input bg-background px-2.5 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm dark:bg-input/30";

const thisYear = () => new Date().getFullYear();
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

/**
 * Anlagen (F08 §6 /buchhaltung/anlagen; AST-001…AST-012): list with book value and AfA of the year, detail sheet with
 * the depreciation plan (planned vs posted), „Anlage erfassen“, „Abgang erfassen“, „AfA jetzt buchen“; tabs
 * „Anlagenspiegel {Jahr}“, „GWG-Verzeichnis“ and „Sammelposten“.
 */
export function AssetRegister({ canWrite }: { canWrite: boolean }) {
  return (
    <ConvexGuard fallback={null}>
      <Inner canWrite={canWrite} />
    </ConvexGuard>
  );
}

function Inner({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations("assets");
  const yearId = useId();
  const [year, setYear] = useState(thisYear());
  const [tab, setTab] = useState("list");
  const [open, setOpen] = useState<Id<"assets"> | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={yearId}>{t("year")}</Label>
          <select
            id={yearId}
            className={`${SELECT} w-32`}
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {[0, 1, 2, 3].map((d) => (
              <option key={d} value={thisYear() - d}>
                {thisYear() - d}
              </option>
            ))}
          </select>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <DepreciateNowButton />
            <Button className="h-11 md:h-9" onClick={() => setCreating(true)}>
              <PlusIcon aria-hidden="true" />
              {t("create")}
            </Button>
          </div>
        )}
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="min-w-0">
        <TabsList className="h-auto w-full justify-start overflow-x-auto">
          <TabsTrigger value="list" className="h-11 flex-none px-3 md:h-9">
            {t("tabs.list")}
          </TabsTrigger>
          <TabsTrigger value="spiegel" className="h-11 flex-none px-3 md:h-9">
            {t("tabs.spiegel", { year })}
          </TabsTrigger>
          <TabsTrigger value="gwg" className="h-11 flex-none px-3 md:h-9">
            {t("tabs.gwg")}
          </TabsTrigger>
          <TabsTrigger value="pools" className="h-11 flex-none px-3 md:h-9">
            {t("tabs.pools")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="list" className="pt-4">
          <AssetList year={year} onOpen={setOpen} />
        </TabsContent>
        <TabsContent value="spiegel" className="pt-4">
          <Anlagenspiegel year={year} />
        </TabsContent>
        <TabsContent value="gwg" className="pt-4">
          <GwgList year={year} />
        </TabsContent>
        <TabsContent value="pools" className="pt-4">
          <Pools year={year} />
        </TabsContent>
      </Tabs>
      <AssetSheet id={open} canWrite={canWrite} onClose={() => setOpen(null)} />
      {creating && <AssetFormDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function DepreciateNowButton() {
  const t = useTranslations("assets");
  const run = useMutation(api.assets.depreciateNow);
  const showError = useAdapterErrorToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      className="h-11 md:h-9"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await run({});
          toast.success(r.posted > 0 ? t("depreciated", { count: r.posted }) : t("nothingToDepreciate"));
          for (const f of r.findings) toast.warning(f.message);
        } catch (e) {
          showError(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      <CalculatorIcon aria-hidden="true" />
      {t("depreciateNow")}
    </Button>
  );
}

function MethodLabel({ method }: { method: Method }) {
  const t = useTranslations("assets.methods");
  return <>{t(method)}</>;
}

function AssetList({ year, onOpen }: { year: number; onOpen: (id: Id<"assets">) => void }) {
  const t = useTranslations("assets");
  const rows = useAuthedQuery(api.assets.list, { year });
  if (rows === undefined) return <div className="h-40" aria-busy="true" />;
  if (rows.length === 0)
    return <p className="rounded-lg border p-6 text-center text-muted-foreground text-sm">{t("empty")}</p>;
  return (
    <>
      <div className="hidden @3xl/main:block">
        <Table aria-label={t("tableLabel")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.number")}</TableHead>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead>{t("columns.account")}</TableHead>
              <TableHead>{t("columns.acquired")}</TableHead>
              <TableHead className="text-right">{t("columns.cost")}</TableHead>
              <TableHead>{t("columns.method")}</TableHead>
              <TableHead className="text-right">{t("columns.bookValue")}</TableHead>
              <TableHead className="text-right">{t("columns.afaYear")}</TableHead>
              <TableHead>{t("columns.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r._id}>
                <TableCell>
                  <button
                    type="button"
                    className="rounded font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2"
                    onClick={() => onOpen(r._id)}
                  >
                    {r.inventoryNumber}
                  </button>
                </TableCell>
                <TableCell className="max-w-64 truncate">{r.name}</TableCell>
                <TableCell className="font-mono text-xs">{r.account}</TableCell>
                <TableCell className="tabular-nums">{dateDe(r.acquisitionDate)}</TableCell>
                <TableCell className="text-right tabular-nums">{euro(r.costCents)}</TableCell>
                <TableCell>
                  <MethodLabel method={r.method} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{euro(r.bookValueCents)}</TableCell>
                <TableCell className="text-right tabular-nums">{euro(r.afaYearCents)}</TableCell>
                <TableCell>
                  <Badge variant={r.status.key === "setup" ? "destructive" : "secondary"}>{r.status.label}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col gap-2 @3xl/main:hidden">
        {rows.map((r) => (
          <li key={r._id}>
            <button
              type="button"
              onClick={() => onOpen(r._id)}
              className="flex min-h-14 w-full flex-col gap-1 rounded-lg border p-3 text-left text-sm hover:bg-muted"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  {r.inventoryNumber} · {r.name}
                </span>
                <Badge variant={r.status.key === "setup" ? "destructive" : "secondary"}>{r.status.label}</Badge>
              </span>
              <span className="text-muted-foreground">
                {dateDe(r.acquisitionDate)} · {euro(r.costCents)} · <MethodLabel method={r.method} />
              </span>
              <span className="tabular-nums">
                {t("columns.bookValue")}: {euro(r.bookValueCents)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function Anlagenspiegel({ year }: { year: number }) {
  const t = useTranslations("assets.spiegel");
  const data = useAuthedQuery(api.assets.anlagenspiegel, { year });
  if (data === undefined) return <div className="h-40" aria-busy="true" />;
  if (data.assets.length === 0) return <p className="text-muted-foreground text-sm">{t("empty", { year })}</p>;
  const cols = [
    ["akStartCents", t("akStart")],
    ["additionsCents", t("additions")],
    ["disposalsCents", t("disposals")],
    ["afaYearCents", t("afaYear")],
    ["accumulatedEndCents", t("accumulated")],
    ["bookValueStartCents", t("bookValueStart")],
    ["bookValueEndCents", t("bookValueEnd")],
  ] as const;
  return (
    <div className="overflow-x-auto">
      <Table aria-label={t("title", { year })}>
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 bg-background">{t("asset")}</TableHead>
            {cols.map(([k, label]) => (
              <TableHead key={k} className="text-right">
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.groups.map((g) => (
            <GroupRows
              key={g.account}
              group={g}
              rows={data.assets.filter((a) => a.account === g.account)}
              cols={cols}
            />
          ))}
          <TableRow className="font-medium">
            <TableCell className="sticky left-0 bg-background">{t("total")}</TableCell>
            {cols.map(([k]) => (
              <TableCell key={k} className="text-right tabular-nums">
                {euro(data.total[k])}
              </TableCell>
            ))}
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

type Spiegel = FunctionReturnType<typeof api.assets.anlagenspiegel>;

function GroupRows({
  group,
  rows,
  cols,
}: {
  group: Spiegel["groups"][number];
  rows: Spiegel["assets"];
  cols: readonly (readonly [keyof Spiegel["total"], string])[];
}) {
  const t = useTranslations("assets.spiegel");
  return (
    <>
      {rows.map((r) => (
        <TableRow key={r.id}>
          <TableCell className="sticky left-0 bg-background">
            <span className="font-mono text-xs">{r.inventoryNumber}</span> {r.name}
          </TableCell>
          {cols.map(([k]) => (
            <TableCell key={k} className="text-right tabular-nums">
              {euro(r[k])}
            </TableCell>
          ))}
        </TableRow>
      ))}
      <TableRow className="bg-muted/50">
        <TableCell className="sticky left-0 bg-muted/50 font-medium">
          {t("account", { account: group.account, count: group.count })}
        </TableCell>
        {cols.map(([k]) => (
          <TableCell key={k} className="text-right font-medium tabular-nums">
            {euro(group[k])}
          </TableCell>
        ))}
      </TableRow>
    </>
  );
}

function GwgList({ year }: { year: number }) {
  const t = useTranslations("assets.gwg");
  const rows = useAuthedQuery(api.assets.gwgList, { year });
  if (rows === undefined) return <div className="h-40" aria-busy="true" />;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">{t("hint")}</p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty", { year })}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table aria-label={t("title")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("number")}</TableHead>
                <TableHead>{t("name")}</TableHead>
                <TableHead>{t("date")}</TableHead>
                <TableHead className="text-right">{t("cost")}</TableHead>
                <TableHead>{t("voucher")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.inventoryNumber}</TableCell>
                  <TableCell>{r.name}</TableCell>
                  <TableCell className="tabular-nums">{dateDe(r.acquisitionDate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{euro(r.costCents)}</TableCell>
                  <TableCell>
                    {r.voucherId ? (
                      <a className="text-primary underline-offset-4 hover:underline" href={`/belege/${r.voucherId}`}>
                        {r.voucherNumber ?? t("voucherLink")}
                      </a>
                    ) : (
                      "–"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function Pools({ year }: { year: number }) {
  const t = useTranslations("assets.pools");
  const pools = useAuthedQuery(api.assets.pools, { year });
  if (pools === undefined) return <div className="h-40" aria-busy="true" />;
  if (pools.length === 0) return <p className="text-muted-foreground text-sm">{t("empty", { year })}</p>;
  return (
    <ul className="flex flex-col gap-3">
      {pools.map((p) => (
        <li key={p.poolYear} className="flex flex-col gap-2 rounded-lg border p-4">
          <h3 className="font-medium">{t("title", { year: p.poolYear })}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t("cost")}</dt>
            <dd className="tabular-nums">{euro(p.costCents)}</dd>
            <dt className="text-muted-foreground">{t("afaYear", { year })}</dt>
            <dd className="tabular-nums">{euro(p.afaYearCents)}</dd>
            <dt className="text-muted-foreground">{t("bookValueEnd")}</dt>
            <dd className="tabular-nums">{euro(p.bookValueEndCents)}</dd>
            <dt className="text-muted-foreground">{t("lastYear")}</dt>
            <dd>{p.lastYear}</dd>
          </dl>
          <p className="text-muted-foreground text-xs">{t("hint")}</p>
          <ul className="text-sm">
            {p.list.map((i) => (
              <li key={i.id}>
                <span className="font-mono text-xs">{i.inventoryNumber}</span> {i.name} · {euro(i.costCents)}
                {i.disposed && <span className="text-muted-foreground"> · {t("disposed")}</span>}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function AssetSheet({ id, canWrite, onClose }: { id: Id<"assets"> | null; canWrite: boolean; onClose: () => void }) {
  const t = useTranslations("assets.detail");
  const data = useAuthedQuery(api.assets.detail, { id: id as Id<"assets"> }, id !== null);
  const [editing, setEditing] = useState(false);
  const [disposing, setDisposing] = useState(false);
  const a = data?.asset;
  return (
    <Sheet open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-2xl">
        {data && a && (
          <>
            <SheetHeader>
              <SheetTitle>
                {a.inventoryNumber} · {a.name}
              </SheetTitle>
              <SheetDescription>
                {t("summary", { date: dateDe(a.acquisitionDate), cost: euro(a.costCents), account: a.account })}
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-5 px-4 pb-6">
              {a.setupRequired && (
                <p role="alert" className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
                  {t("setupRequired")}
                </p>
              )}
              {a.disposal && (
                <p className="rounded-md border p-3 text-sm">
                  {t("disposed", { date: dateDe(a.disposal.date), rbw: euro(a.disposal.rbwCents) })}
                </p>
              )}
              {canWrite && !a.voidedAt && (
                <div className="flex flex-wrap gap-2">
                  {a.firstDepreciationAt === undefined && !a.disposal && (
                    <Button variant="outline" className="h-11 md:h-9" onClick={() => setEditing(true)}>
                      {a.setupRequired ? t("completeSetup") : t("edit")}
                    </Button>
                  )}
                  {!a.disposal && !a.setupRequired && (
                    <Button variant="outline" className="h-11 md:h-9" onClick={() => setDisposing(true)}>
                      {t("dispose")}
                    </Button>
                  )}
                </div>
              )}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t("method")}</dt>
                <dd>
                  <MethodLabel method={a.method} />
                  {a.usefulLifeMonths ? ` · ${t("life", { months: a.usefulLifeMonths })}` : ""}
                  {a.degressiveRateBp ? ` · ${(a.degressiveRateBp / 100).toLocaleString("de-DE")} %` : ""}
                </dd>
                {data.voucher && (
                  <>
                    <dt className="text-muted-foreground">{t("voucher")}</dt>
                    <dd>
                      <a
                        className="text-primary underline-offset-4 hover:underline"
                        href={`/belege/${data.voucher._id}`}
                      >
                        {data.voucher.number ?? t("voucher")}
                      </a>
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">{t("ruleVersion")}</dt>
                <dd className="font-mono text-xs">{a.ruleVersion}</dd>
              </dl>
              <section aria-labelledby="asset-plan" className="flex flex-col gap-2">
                <h3 id="asset-plan" className="font-medium text-sm">
                  {t("plan")}
                </h3>
                {data.plan.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t("noPlan")}</p>
                ) : (
                  <div className="max-h-96 overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("period")}</TableHead>
                          <TableHead className="text-right">{t("amount")}</TableHead>
                          <TableHead className="text-right">{t("bookValue")}</TableHead>
                          <TableHead>{t("state")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.plan.map((r) => (
                          <TableRow key={r.period}>
                            <TableCell className="tabular-nums">{periodDe(r.period)}</TableCell>
                            <TableCell className="text-right tabular-nums">{euro(r.amountCents)}</TableCell>
                            <TableCell className="text-right tabular-nums">{euro(r.bookValueAfterCents)}</TableCell>
                            <TableCell className="text-xs">
                              {r.posted ? t("posted", { seq: r.posted.seq }) : r.preBook ? t("preBook") : t("planned")}
                              {r.switchedToLinear && ` · ${t("switch")}`}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </section>
              {canWrite && <NotesEditor id={a._id} notes={a.notes ?? ""} />}
            </div>
            {editing && <AssetFormDialog asset={data} onClose={() => setEditing(false)} />}
            {disposing && <DisposeDialog id={a._id} onClose={() => setDisposing(false)} />}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function NotesEditor({ id, notes }: { id: Id<"assets">; notes: string }) {
  const t = useTranslations("assets.detail");
  const save = useMutation(api.assets.setNotes);
  const showError = useAdapterErrorToast();
  const fieldId = useId();
  const [value, setValue] = useState(notes);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={fieldId}>{t("notes")}</Label>
      <Textarea id={fieldId} value={value} onChange={(e) => setValue(e.target.value)} />
      <Button
        variant="outline"
        className="h-11 self-start md:h-9"
        disabled={value === notes}
        onClick={() => save({ id, notes: value }).then(() => toast.success(t("notesSaved")), showError)}
      >
        {t("saveNotes")}
      </Button>
    </div>
  );
}

function AssetFormDialog({ asset, onClose }: { asset?: Detail; onClose: () => void }) {
  const t = useTranslations("assets.form");
  const tm = useTranslations("assets.methods");
  const create = useMutation(api.assets.create);
  const update = useMutation(api.assets.update);
  const showError = useAdapterErrorToast();
  const base = useId();
  const a = asset?.asset;
  const fromVoucher = !!a?.voucherId;
  const [name, setName] = useState(a?.name ?? "");
  const [account, setAccount] = useState(a?.account ?? "");
  const [date, setDate] = useState(a?.acquisitionDate ?? today());
  const [cost, setCost] = useState(a ? (a.costCents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2 }) : "");
  const [method, setMethod] = useState<Method>(a?.setupRequired ? "linear" : (a?.method ?? "linear"));
  const [life, setLife] = useState(a?.usefulLifeMonths ? String(a.usefulLifeMonths) : "");
  const [lifeKey, setLifeKey] = useState(a?.usefulLifeKey ?? "");
  const [ev, setEv] = useState(a?.evQualified ?? false);
  const [vat, setVat] = useState(a?.inputVatDeducted ?? true);
  const [erinnerungswert, setErinnerungswert] = useState(a?.erinnerungswert ?? false);
  const [busy, setBusy] = useState(false);
  const parsed = parseCents(cost);
  const costCents = parsed.ok ? Number(parsed.value) : 0;
  const options = useAuthedQuery(
    api.assets.methodOptions,
    { account, acquisitionDate: date, costCents },
    /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{4}$/.test(account),
  );
  const needsLife = method === "linear" || method === "degressive";
  const submit = async () => {
    if (!parsed.ok) {
      toast.error(t("invalidCost"));
      return;
    }
    setBusy(true);
    const input = {
      name,
      account,
      acquisitionDate: date,
      costCents,
      method,
      ...(needsLife && life ? { usefulLifeMonths: Number(life) } : {}),
      ...(lifeKey ? { usefulLifeKey: lifeKey } : {}),
      ...(method === "ev_special" ? { evQualified: ev } : {}),
      erinnerungswert,
      inputVatDeducted: vat,
    };
    try {
      if (a) await update({ id: a._id, ...input });
      else await create(input);
      toast.success(t("saved"));
      onClose();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{a ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription>{fromVoucher ? t("fromVoucher") : t("description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field id={`${base}-name`} label={t("name")}>
            <Input id={`${base}-name`} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id={`${base}-account`} label={t("account")}>
              <Input
                id={`${base}-account`}
                inputMode="numeric"
                value={account}
                disabled={fromVoucher}
                onChange={(e) => setAccount(e.target.value.trim())}
              />
            </Field>
            <Field id={`${base}-date`} label={t("date")}>
              <Input
                id={`${base}-date`}
                type="date"
                value={date}
                disabled={fromVoucher}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <Field id={`${base}-cost`} label={t("cost")}>
              <Input
                id={`${base}-cost`}
                inputMode="decimal"
                value={cost}
                disabled={fromVoucher}
                onChange={(e) => setCost(e.target.value)}
              />
            </Field>
          </div>
          <Field id={`${base}-method`} label={t("method")}>
            <select
              id={`${base}-method`}
              className={SELECT}
              value={method}
              onChange={(e) => setMethod(e.target.value as Method)}
            >
              {(options?.methods ?? []).map((o) => (
                <option key={o.method} value={o.method} disabled={!o.allowed}>
                  {tm(o.method)}
                  {!o.allowed && o.message ? ` – ${o.message}` : ""}
                </option>
              ))}
              {!options && <option value={method}>{tm(method)}</option>}
            </select>
          </Field>
          {options?.yearPolicy && (
            <p className="text-muted-foreground text-xs">{t("yearPolicy", { choice: tm(options.yearPolicy) })}</p>
          )}
          {needsLife && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={`${base}-table`} label={t("afaTable")}>
                <select
                  id={`${base}-table`}
                  className={SELECT}
                  value={lifeKey}
                  onChange={(e) => {
                    setLifeKey(e.target.value);
                    const row = options?.usefulLives.find((r) => r.key === e.target.value);
                    if (row) setLife(String(row.months));
                  }}
                >
                  <option value="">{t("custom")}</option>
                  {(options?.usefulLives ?? []).map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label} ({t("lifeMonths", { months: r.months })})
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={`${base}-life`} label={t("life")}>
                <Input
                  id={`${base}-life`}
                  inputMode="numeric"
                  value={life}
                  onChange={(e) => setLife(e.target.value.replace(/\D/g, ""))}
                />
              </Field>
            </div>
          )}
          {method === "ev_special" && (
            <CheckboxField id={`${base}-ev`} checked={ev} onChange={setEv} label={t("evQualified")} />
          )}
          <CheckboxField
            id={`${base}-vat`}
            checked={vat}
            onChange={setVat}
            label={t("inputVat")}
            disabled={fromVoucher}
          />
          <CheckboxField
            id={`${base}-ew`}
            checked={erinnerungswert}
            onChange={setErinnerungswert}
            label={t("erinnerungswert")}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button className="h-11 md:h-9" disabled={busy || !name.trim() || !account} onClick={submit}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function CheckboxField({
  id,
  checked,
  onChange,
  label,
  disabled,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="font-normal leading-snug">
        {label}
      </Label>
    </div>
  );
}

function DisposeDialog({ id, onClose }: { id: Id<"assets">; onClose: () => void }) {
  const t = useTranslations("assets.dispose");
  const dispose = useMutation(api.assets.dispose);
  const showError = useAdapterErrorToast();
  const base = useId();
  const [date, setDate] = useState(today());
  const [kind, setKind] = useState<"sale" | "scrap" | "withdrawal">("sale");
  const [invoice, setInvoice] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const parsed = parseCents(amount || "0");
  const submit = async () => {
    if (!parsed.ok) {
      toast.error(t("invalidAmount"));
      return;
    }
    setBusy(true);
    try {
      const r = await dispose({
        id,
        date,
        kind,
        ...(kind === "sale" ? { documentNumber: invoice, proceedsCents: Number(parsed.value) } : {}),
        ...(kind === "withdrawal" ? { teilwertCents: Number(parsed.value) } : {}),
      });
      toast.success(r.info ?? t("done", { rbw: euro(r.rbwCents) }));
      if (r.latePosting) toast.info(r.latePosting);
      onClose();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field id={`${base}-date`} label={t("date")}>
            <Input id={`${base}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field id={`${base}-kind`} label={t("kind")}>
            <select
              id={`${base}-kind`}
              className={SELECT}
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="sale">{t("kinds.sale")}</option>
              <option value="scrap">{t("kinds.scrap")}</option>
              <option value="withdrawal">{t("kinds.withdrawal")}</option>
            </select>
          </Field>
          {kind === "sale" && (
            <Field id={`${base}-invoice`} label={t("invoice")}>
              <Input id={`${base}-invoice`} value={invoice} onChange={(e) => setInvoice(e.target.value)} />
            </Field>
          )}
          {kind !== "scrap" && (
            <Field id={`${base}-amount`} label={kind === "sale" ? t("proceeds") : t("teilwert")}>
              <Input
                id={`${base}-amount`}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          )}
          <p className="text-muted-foreground text-xs">{t(`hints.${kind}`)}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button className="h-11 md:h-9" disabled={busy || (kind === "sale" && !invoice.trim())} onClick={submit}>
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
