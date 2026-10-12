"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { berlinCalendarDate } from "@/domain/time/berlin";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { dateDe, euro } from "./format";

type ChartData = FunctionReturnType<typeof api.accounting.chartOfAccounts>;
type Account = ChartData["accounts"][number];
type Role = ChartData["roles"][number];

const SELECT =
  "h-11 w-full rounded-md border border-input bg-background px-2.5 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm dark:bg-input/30";

/**
 * Kontenplan (F08 §6 /buchhaltung/konten, ACC-007/ACC-008): accounts of the fiscal year's chart with balances
 * (filter: search, only used) and the tab „Rollen & Standardkonten“ with ⚠ for uncertain research, a red
 * „nicht zugeordnet“ badge for roles that block postings and — for the owner — „Konto zuordnen“.
 */
export function ChartOfAccounts({ isOwner }: { isOwner: boolean }) {
  return (
    <ConvexGuard fallback={null}>
      <ChartOfAccountsInner isOwner={isOwner} />
    </ConvexGuard>
  );
}

function ChartOfAccountsInner({ isOwner }: { isOwner: boolean }) {
  const t = useTranslations("accounting.konten");
  const data = useAuthedQuery(api.accounting.chartOfAccounts, {});
  if (data === undefined) return <div className="h-96" aria-busy="true" />;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        {t("summary", { chart: data.chart, from: dateDe(data.from), to: dateDe(data.to) })}
      </p>
      <Tabs defaultValue="konten">
        <TabsList className="h-auto w-full justify-start overflow-x-auto">
          <TabsTrigger value="konten" className="h-9 flex-none px-3">
            {t("tabAccounts")}
          </TabsTrigger>
          <TabsTrigger value="rollen" className="h-9 flex-none px-3">
            {t("tabRoles")}
            {data.roles.some((r) => r.unmapped) && <span className="ml-1 size-2 rounded-full bg-destructive" />}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="konten">
          <AccountsPanel accounts={data.accounts} />
        </TabsContent>
        <TabsContent value="rollen">
          <RolesPanel roles={data.roles} accounts={data.accounts} isOwner={isOwner} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AccountsPanel({ accounts }: { accounts: Account[] }) {
  const t = useTranslations("accounting.konten");
  const searchId = useId();
  const usedId = useId();
  const [search, setSearch] = useState("");
  const [usedOnly, setUsedOnly] = useState(false);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return accounts.filter(
      (a) => (!usedOnly || a.used) && (!q || a.number.startsWith(q) || a.name.toLowerCase().includes(q)),
    );
  }, [accounts, search, usedOnly]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-1 flex-col gap-1.5 @3xl/main:max-w-sm">
          <Label htmlFor={searchId}>{t("searchLabel")}</Label>
          <Input
            id={searchId}
            type="search"
            className="h-11 md:h-9"
            placeholder={t("searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex min-h-11 items-center gap-2 md:min-h-9">
          <input
            id={usedId}
            type="checkbox"
            className="size-5 accent-primary md:size-4"
            checked={usedOnly}
            onChange={(e) => setUsedOnly(e.target.checked)}
          />
          <Label htmlFor={usedId}>{t("usedOnly")}</Label>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-lg border p-6 text-center text-muted-foreground text-sm">{t("noResults")}</p>
      ) : (
        <>
          <div className="hidden @3xl/main:block">
            <Table aria-label={t("tableLabel")}>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">{t("columns.number")}</TableHead>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead>{t("columns.type")}</TableHead>
                  <TableHead className="text-right">{t("columns.debit")}</TableHead>
                  <TableHead className="text-right">{t("columns.credit")}</TableHead>
                  <TableHead className="text-right">{t("columns.balance")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((a) => (
                  <TableRow key={a.number}>
                    <TableCell className="font-mono">{a.number}</TableCell>
                    <TableCell className="whitespace-normal">
                      <AccountName account={a} />
                    </TableCell>
                    <TableCell>{t(`types.${a.type}`)}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.used ? euro(a.debitCents) : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.used ? euro(a.creditCents) : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.used ? euro(a.balanceCents) : ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col divide-y rounded-lg border @3xl/main:hidden">
            {shown.map((a) => (
              <li key={a.number} className="flex items-start justify-between gap-3 p-3 text-sm">
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="font-mono">{a.number}</span>
                  <AccountName account={a} />
                </span>
                {a.used && (
                  <span className="shrink-0 text-right tabular-nums">
                    <span className="sr-only">{t("columns.balance")} </span>
                    {euro(a.balanceCents)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function AccountName({ account: a }: { account: Account }) {
  const t = useTranslations("accounting.konten");
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {a.name}
      {a.automaticVatAccount && <Badge variant="outline">{t("automaticVat")}</Badge>}
      {!a.verified && (
        <Badge variant="outline" title={t("unverifiedHint")}>
          {t("unverified")}
          <span className="sr-only">: {t("unverifiedHint")}</span>
        </Badge>
      )}
    </span>
  );
}

function RolesPanel({ roles, accounts, isOwner }: { roles: Role[]; accounts: Account[]; isOwner: boolean }) {
  const t = useTranslations("accounting.konten");
  const [editing, setEditing] = useState<Role | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">{t("rolesIntro")}</p>
      <ul aria-label={t("rolesTableLabel")} className="flex flex-col divide-y rounded-lg border">
        {roles.map((r) => (
          <li key={r.role} className="flex flex-col gap-2 p-3 text-sm @2xl/main:flex-row @2xl/main:items-center">
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-1.5 font-medium">
                {r.label}
                {r.unmapped && <Badge variant="destructive">{t("unmapped")}</Badge>}
                {r.uncertain && !r.unmapped && <Badge variant="outline">{t("uncertain")}</Badge>}
                {r.source === "override" && <Badge variant="secondary">{t("override")}</Badge>}
              </span>
              <span className="font-mono text-muted-foreground text-xs">{r.role}</span>
              {r.unmapped && <span className="text-destructive text-xs">{t("unmappedHint")}</span>}
              {r.uncertain && !r.unmapped && (
                <span className="text-muted-foreground text-xs">{t("uncertainHint")}</span>
              )}
              {r.sourceText && <span className="text-muted-foreground text-xs">„{r.sourceText}“</span>}
            </span>
            <span className="flex items-center gap-3 @2xl/main:justify-end">
              {r.account && (
                <span>
                  <span className="font-mono">{r.account}</span> {r.accountName}
                </span>
              )}
              {isOwner && (
                <Button variant="outline" size="sm" className="h-11 md:h-8" onClick={() => setEditing(r)}>
                  {t("assign")}
                  <span className="sr-only"> ({r.label})</span>
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {editing && <AssignDialog role={editing} accounts={accounts} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AssignDialog({ role, accounts, onClose }: { role: Role; accounts: Account[]; onClose: () => void }) {
  const t = useTranslations("accounting.konten");
  const tCommon = useTranslations("common");
  const save = useMutation(api.accounting.setRoleMapping);
  const showError = useAdapterErrorToast();
  const ids = { account: useId(), validFrom: useId(), sourceText: useId(), hint: useId() };
  const [account, setAccount] = useState(role.account ?? "");
  const [validFrom, setValidFrom] = useState<string>(berlinCalendarDate(Date.now()));
  const [sourceText, setSourceText] = useState("");
  const [busy, setBusy] = useState(false);
  const selectable = accounts.filter((a) => a.type !== "bank");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await save({ role: role.role, account, validFrom, sourceText });
      toast.success(t("saved"));
      onClose();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle", { role: role.label })}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>
        <form id={`${ids.account}-form`} onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.account}>{t("accountLabel")}</Label>
            <select
              id={ids.account}
              className={SELECT}
              required
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">{t("accountPlaceholder")}</option>
              {selectable.map((a) => (
                <option key={a.number} value={a.number}>
                  {a.number} – {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.validFrom}>{t("validFrom")}</Label>
            <Input
              id={ids.validFrom}
              type="date"
              required
              className="h-11 md:h-9"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.sourceText}>{t("sourceText")}</Label>
            <Input
              id={ids.sourceText}
              required
              minLength={5}
              maxLength={200}
              aria-describedby={ids.hint}
              className="h-11 md:h-9"
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
            />
            <p id={ids.hint} className="text-muted-foreground text-xs">
              {t("sourceTextHint")}
            </p>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" form={`${ids.account}-form`} className="h-11 md:h-9" disabled={busy}>
            {tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
