"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseCents } from "@/domain/money/parse";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { dateDe, euro } from "./format";

type Status = FunctionReturnType<typeof api.accounting.openingBalanceStatus>;
type Part = FunctionArgs<typeof api.accounting.postOpeningBalancePart>["part"];
type Posted = Status["cash"];

const SELECT =
  "h-11 w-full rounded-md border border-input bg-background px-2.5 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm dark:bg-input/30";

/**
 * Eröffnungsbilanz (F08 §6 /buchhaltung/eroeffnung, ACC-013/ACC-014 P1 subset): Buchungsbeginn (owner, frozen after
 * the first posting) → Kasse → bank accounts → open receivables; each part is posted once per fiscal year
 * (E-ACC-13). Other Sachkonten and open payables follow in P2.
 */
export function OpeningBalanceWizard({ canPost, isOwner }: { canPost: boolean; isOwner: boolean }) {
  return (
    <ConvexGuard fallback={null}>
      <WizardInner canPost={canPost} isOwner={isOwner} />
    </ConvexGuard>
  );
}

function WizardInner({ canPost, isOwner }: { canPost: boolean; isOwner: boolean }) {
  const t = useTranslations("accounting.eroeffnung");
  const status = useAuthedQuery(api.accounting.openingBalanceStatus, {});
  if (status === undefined) return <div className="h-96" aria-busy="true" />;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground text-sm">
        {t("openingDate", { year: status.fiscalYear, date: dateDe(status.date) })}
      </p>
      <BookkeepingStartCard status={status} isOwner={isOwner} />
      <AmountCard
        title={t("cash.title")}
        description={t("cash.description")}
        label={t("cash.amount")}
        posted={status.cash}
        canPost={canPost}
        fiscalYear={status.fiscalYear}
        part={(amountCents) => ({ kind: "cash", amountCents })}
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("bank.title")}</h2>
          </CardTitle>
          <CardDescription>{t("bank.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {status.banks.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("bank.none")}</p>
          ) : (
            status.banks.map((b) => (
              <AmountRow
                key={b.id}
                label={t("bank.amount", { name: b.name })}
                hint={b.iban ? `${b.iban} · ${b.ledgerAccount}` : b.ledgerAccount}
                posted={b.posted}
                canPost={canPost}
                fiscalYear={status.fiscalYear}
                part={(amountCents) => ({ kind: "bank", bankAccountId: b.id as Id<"bankAccounts">, amountCents })}
              />
            ))
          )}
        </CardContent>
      </Card>
      <ReceivablesCard status={status} canPost={canPost} />
    </div>
  );
}

function usePost(fiscalYear: number) {
  const t = useTranslations("accounting.eroeffnung");
  const post = useMutation(api.accounting.postOpeningBalancePart);
  const showError = useAdapterErrorToast();
  const [busy, setBusy] = useState(false);
  const run = async (part: Part): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await post({ fiscalYear, part });
      toast.success(r.status === "posted" ? t("postedToast") : t("nothing"));
      return true;
    } catch (e) {
      showError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

function PostedBadge({ posted }: { posted: NonNullable<Posted> }) {
  const t = useTranslations("accounting.eroeffnung");
  return <Badge variant="secondary">{t("posted", { seq: posted.seq, amount: euro(posted.totalCents) })}</Badge>;
}

function BookkeepingStartCard({ status, isOwner }: { status: Status; isOwner: boolean }) {
  const t = useTranslations("accounting.eroeffnung.start");
  const save = useMutation(api.accounting.setBookkeepingStartDate);
  const showError = useAdapterErrorToast();
  const id = useId();
  const [date, setDate] = useState(status.bookkeepingStartDate ?? "");
  const [busy, setBusy] = useState(false);
  const editable = isOwner && status.canChangeBookkeepingStart;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await save({ date });
      toast.success(t("saved"));
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {editable ? (
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={id}>{t("label")}</Label>
              <Input
                id={id}
                type="date"
                required
                className="h-11 w-48 md:h-9"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <Button type="submit" variant="outline" className="h-11 md:h-9" disabled={busy || !date}>
              {t("save")}
            </Button>
          </form>
        ) : (
          <p>
            <span className="font-medium">{t("label")}: </span>
            {status.bookkeepingStartDate ? dateDe(status.bookkeepingStartDate) : t("none")}
          </p>
        )}
        {!status.canChangeBookkeepingStart && <p className="text-muted-foreground">{t("locked")}</p>}
      </CardContent>
    </Card>
  );
}

function AmountCard(props: {
  title: string;
  description: string;
  label: string;
  posted: Posted;
  canPost: boolean;
  fiscalYear: number;
  part: (amountCents: number) => Part;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{props.title}</h2>
        </CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <AmountRow {...props} />
      </CardContent>
    </Card>
  );
}

function AmountRow({
  label,
  hint,
  posted,
  canPost,
  fiscalYear,
  part,
}: {
  label: string;
  hint?: string;
  posted: Posted;
  canPost: boolean;
  fiscalYear: number;
  part: (amountCents: number) => Part;
}) {
  const t = useTranslations("accounting");
  const id = useId();
  const errId = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = usePost(fiscalYear);
  if (posted) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{label}</span>
        <PostedBadge posted={posted} />
      </div>
    );
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseCents(value);
    if (!parsed.ok || parsed.value < 0) {
      setError(t("invalidAmount"));
      return;
    }
    setError(null);
    if (await run(part(parsed.value))) setValue("");
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" noValidate>
      <div className="flex min-w-48 flex-col gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        {hint && <span className="font-mono text-muted-foreground text-xs">{hint}</span>}
        <Input
          id={id}
          inputMode="decimal"
          className="h-11 w-48 text-right tabular-nums md:h-9"
          value={value}
          disabled={!canPost}
          aria-invalid={error !== null}
          aria-describedby={error ? errId : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && (
          <p id={errId} className="text-destructive text-xs">
            {error}
          </p>
        )}
      </div>
      {canPost && (
        <Button type="submit" className="h-11 md:h-9" disabled={busy || value.trim() === ""}>
          {t("eroeffnung.postNamed", { name: label })}
        </Button>
      )}
    </form>
  );
}

interface Draft {
  key: number;
  number: string;
  counterpartyName: string;
  documentDate: string;
  gross: string;
  open: string;
  taxedAs: "soll" | "ist";
  rateBp: number;
  vat: string;
}

const emptyDraft = (key: number): Draft => ({
  key,
  number: "",
  counterpartyName: "",
  documentDate: "",
  gross: "",
  open: "",
  taxedAs: "soll",
  rateBp: 1900,
  vat: "",
});

function ReceivablesCard({ status, canPost }: { status: Status; canPost: boolean }) {
  const t = useTranslations("accounting.eroeffnung");
  const tA = useTranslations("accounting");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = usePost(status.fiscalYear);
  const update = (key: number, patch: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const submit = async () => {
    const items = [];
    for (const d of drafts) {
      const gross = parseCents(d.gross);
      const open = parseCents(d.open || d.gross);
      const vat = d.taxedAs === "ist" ? parseCents(d.vat || "0") : null;
      if (!gross.ok || !open.ok || (vat && !vat.ok)) {
        setError(`${d.number || t("receivables.item", { n: drafts.indexOf(d) + 1 })}: ${tA("invalidAmount")}`);
        return;
      }
      items.push({
        number: d.number.trim(),
        counterpartyName: d.counterpartyName.trim(),
        documentDate: d.documentDate,
        grossCents: gross.value,
        openCents: open.value,
        taxedAs: d.taxedAs,
        ...(vat?.ok && vat.value > 0 ? { notDueVat: [{ rateBp: d.rateBp, vatCents: vat.value }] } : {}),
      });
    }
    setError(null);
    if (await run({ kind: "receivables", items })) setDrafts([]);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("receivables.title")}</h2>
        </CardTitle>
        <CardDescription>{t("receivables.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status.receivables ? (
          <>
            <PostedBadge posted={status.receivables} />
            <ul aria-label={t("receivables.list")} className="flex flex-col divide-y rounded-lg border text-sm">
              {status.openingItems.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <span>
                    <span className="font-medium">{i.number}</span> · {i.counterpartyName} · {dateDe(i.documentDate)}
                  </span>
                  <span className="tabular-nums">
                    {euro(i.openCents)} <Badge variant="outline">{i.taxedAs === "ist" ? "Ist" : "Soll"}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            {drafts.length === 0 && <p className="text-muted-foreground text-sm">{t("receivables.empty")}</p>}
            {drafts.map((d, i) => (
              <ReceivableFields
                key={d.key}
                draft={d}
                n={i + 1}
                onChange={(p) => update(d.key, p)}
                onRemove={() => setDrafts((ds) => ds.filter((x) => x.key !== d.key))}
              />
            ))}
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            {canPost && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="h-11 md:h-9"
                  onClick={() => setDrafts((ds) => [...ds, emptyDraft(Date.now() + ds.length)])}
                >
                  <PlusIcon aria-hidden="true" />
                  {t("receivables.add")}
                </Button>
                {drafts.length > 0 && (
                  <Button className="h-11 md:h-9" disabled={busy} onClick={() => void submit()}>
                    {t("postNamed", { name: t("receivables.title") })}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ReceivableFields({
  draft: d,
  n,
  onChange,
  onRemove,
}: {
  draft: Draft;
  n: number;
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("accounting.eroeffnung.receivables");
  const base = useId();
  const field = (name: string) => `${base}-${name}`;
  const text = (name: keyof Draft, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={field(name)}>{label}</Label>
      <Input
        id={field(name)}
        className="h-11 md:h-9"
        value={String(d[name])}
        onChange={(e) => onChange({ [name]: e.target.value } as Partial<Draft>)}
        {...props}
      />
    </div>
  );
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
      <legend className="px-1 font-medium text-sm">{t("item", { n })}</legend>
      <div className="grid gap-3 @2xl/main:grid-cols-3">
        {text("number", t("number"), { required: true })}
        {text("counterpartyName", t("customer"), { required: true })}
        {text("documentDate", t("date"), { type: "date", required: true })}
        {text("gross", t("gross"), { inputMode: "decimal", className: "h-11 text-right tabular-nums md:h-9" })}
        {text("open", t("open"), { inputMode: "decimal", className: "h-11 text-right tabular-nums md:h-9" })}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={field("taxedAs")}>{t("taxedAs")}</Label>
          <select
            id={field("taxedAs")}
            className={SELECT}
            value={d.taxedAs}
            onChange={(e) => onChange({ taxedAs: e.target.value as Draft["taxedAs"] })}
          >
            <option value="soll">{t("soll")}</option>
            <option value="ist">{t("ist")}</option>
          </select>
        </div>
        {d.taxedAs === "ist" && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={field("rateBp")}>{t("rate")}</Label>
              <select
                id={field("rateBp")}
                className={SELECT}
                value={d.rateBp}
                onChange={(e) => onChange({ rateBp: Number(e.target.value) })}
              >
                <option value={1900}>19 %</option>
                <option value={700}>7 %</option>
              </select>
            </div>
            {text("vat", t("vat"), { inputMode: "decimal", className: "h-11 text-right tabular-nums md:h-9" })}
          </>
        )}
      </div>
      <Button variant="ghost" size="sm" className="h-11 self-end md:h-8" onClick={onRemove}>
        <Trash2Icon aria-hidden="true" />
        {t("remove", { n })}
      </Button>
    </fieldset>
  );
}
