"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import { ReceiptTextIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import {
  ConfirmDialog,
  formatDate,
  formatDateTime,
  selectClass,
  useAuthedPaginatedQuery,
  useCan,
  useRun,
  useUrlState,
} from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EmptyState } from "@/components/layout/empty-state";
import { PageBody, StatusFilter } from "@/components/layout/list-layout";
import { ListSearch } from "@/components/layout/list-search";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { TRANSACTION_STATUS_FILTERS, TRANSACTION_STATUS_LABEL_DE } from "@/domain/schemas/banking";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { DuplicatesPanel } from "./duplicates-panel";
import { Amount, money, ReconciledBadge, SOURCE_LABEL, StatusBadge, uploadFile } from "./shared";
import { TransactionSheet } from "./transaction-sheet";

/**
 * One bank account (F07 §6, 04 §4.6): Umsätze (filters in the URL, table on desktop / cards on phones, detail sheet
 * with marking), Kontoauszüge (archive with reconciliation, files, PDF attach) and Importe (rollback, BNK-036).
 */
export function BankAccountView({ id }: { id: string }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <AccountViewInner id={id as Id<"bankAccounts">} />
    </ConvexGuard>
  );
}

function AccountViewInner({ id }: { id: Id<"bankAccounts"> }) {
  const t = useTranslations("banking.accountView");
  const tNav = useTranslations("nav");
  const account = useAuthedQuery(api.banking.account, { id });
  const url = useUrlState();
  const tab = ["statements", "imports"].includes(url.get("tab")) ? url.get("tab") : "transactions";
  if (account === undefined) return <div className="h-96" aria-busy="true" />;
  if (account === null) {
    return (
      <>
        <PageHeader title={t("notFound")} breadcrumbs={[{ label: tNav("items.bank"), href: "/bank" }]} />
        <PageBody>
          <p role="alert">{t("notFound")}</p>
        </PageBody>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={account.name}
        description={[account.currency, account.iban].filter(Boolean).join(" · ")}
        breadcrumbs={[{ label: tNav("items.bank"), href: "/bank" }, { label: account.name }]}
      />
      <PageBody className="@container/acc">
        <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "transactions" ? "" : String(v) })}>
          <TabsList className="h-auto w-full justify-start overflow-x-auto">
            {(["transactions", "statements", "imports"] as const).map((k) => (
              <TabsTrigger key={k} value={k} className="h-11 flex-none px-3 md:h-9">
                {t(`tabs.${k}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="transactions" className="flex flex-col gap-4 pt-4">
            <DuplicatesPanel accountId={id} />
            <Transactions accountId={id} currency={account.currency} />
          </TabsContent>
          <TabsContent value="statements" className="flex flex-col gap-4 pt-4">
            <Statements accountId={id} currency={account.currency} />
          </TabsContent>
          <TabsContent value="imports" className="flex flex-col gap-4 pt-4">
            <Imports accountId={id} />
          </TabsContent>
        </Tabs>
      </PageBody>
    </>
  );
}

function Transactions({ accountId, currency }: { accountId: Id<"bankAccounts">; currency: string }) {
  const t = useTranslations("banking.transactions");
  const url = useUrlState();
  const status = (TRANSACTION_STATUS_FILTERS as readonly string[]).includes(url.get("status"))
    ? url.get("status")
    : "all";
  const direction = ["in", "out"].includes(url.get("dir")) ? (url.get("dir") as "in" | "out") : undefined;
  const from = url.get("from");
  const to = url.get("to");
  const q = url.get("q");
  const dirId = useId();
  const fromId = useId();
  const toId = useId();
  const args = useMemo(
    () => ({
      accountId,
      status,
      ...(direction ? { direction } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(q ? { q } : {}),
    }),
    [accountId, status, direction, from, to, q],
  );
  const { results, status: loadStatus, loadMore } = useAuthedPaginatedQuery(api.banking.transactions, args, 50);
  const [selected, setSelected] = useState<Id<"bankTransactions"> | null>(null);

  return (
    <>
      <StatusFilter
        label={t("statusLabel")}
        current={status}
        options={TRANSACTION_STATUS_FILTERS.map((s) => ({
          value: s,
          label: TRANSACTION_STATUS_LABEL_DE[s] ?? s,
          href: url.hrefWith({ status: s === "all" ? "" : s }),
        }))}
      />
      <div className="flex flex-wrap items-end gap-2">
        <ListSearch
          label={t("search")}
          placeholder={t("searchPlaceholder")}
          defaultValue={q}
          onSearch={(v) => url.set({ q: v })}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor={dirId} className="text-muted-foreground text-xs">
            {t("direction")}
          </label>
          <select
            id={dirId}
            className={selectClass}
            value={direction ?? ""}
            onChange={(e) => url.set({ dir: e.target.value })}
          >
            <option value="">{t("directionAll")}</option>
            <option value="in">{t("directionIn")}</option>
            <option value="out">{t("directionOut")}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={fromId} className="text-muted-foreground text-xs">
            {t("from")}
          </label>
          <Input
            id={fromId}
            type="date"
            className="h-11 w-40 md:h-9"
            value={from}
            onChange={(e) => url.set({ from: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={toId} className="text-muted-foreground text-xs">
            {t("to")}
          </label>
          <Input
            id={toId}
            type="date"
            className="h-11 w-40 md:h-9"
            value={to}
            onChange={(e) => url.set({ to: e.target.value })}
          />
        </div>
      </div>
      {loadStatus === "LoadingFirstPage" ? (
        <div className="h-64" aria-busy="true" />
      ) : results.length === 0 ? (
        <EmptyState icon={ReceiptTextIcon} title={t("empty")} />
      ) : (
        <>
          <div className="hidden @3xl/acc:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.date")}</TableHead>
                  <TableHead>{t("columns.counterparty")}</TableHead>
                  <TableHead>{t("columns.purpose")}</TableHead>
                  <TableHead className="text-right">{t("columns.amount")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r) => (
                  <TableRow key={r._id}>
                    <TableCell className="whitespace-nowrap tabular-nums">{formatDate(r.bookingDate)}</TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left font-medium hover:underline focus-visible:underline"
                        onClick={() => setSelected(r._id)}
                      >
                        {r.counterpartyName ?? t("noCounterparty")}
                      </button>
                    </TableCell>
                    <TableCell className="max-w-80 truncate text-muted-foreground">{r.purpose}</TableCell>
                    <TableCell className="text-right">
                      <Amount cents={r.amountCents} currency={r.currency} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col gap-2 @3xl/acc:hidden">
            {results.map((r) => (
              <li key={r._id}>
                <button
                  type="button"
                  onClick={() => setSelected(r._id)}
                  className="flex w-full items-start justify-between gap-3 rounded-lg border p-3 text-left"
                >
                  <span className="flex min-w-0 flex-col items-start gap-1">
                    <span className="font-medium">{r.counterpartyName ?? t("noCounterparty")}</span>
                    <span className="truncate text-muted-foreground text-sm">
                      {formatDate(r.bookingDate)} · {r.purpose}
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <Amount cents={r.amountCents} currency={r.currency} className="font-medium" />
                    <StatusBadge status={r.status} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {loadStatus === "CanLoadMore" && (
            <Button variant="outline" className="h-11 self-center md:h-9" onClick={() => loadMore(50)}>
              {t("more")}
            </Button>
          )}
        </>
      )}
      <TransactionSheet id={selected} currency={currency} onClose={() => setSelected(null)} />
    </>
  );
}

function Statements({ accountId, currency }: { accountId: Id<"bankAccounts">; currency: string }) {
  const t = useTranslations("banking.statements");
  const rows = useAuthedQuery(api.banking.statements, { accountId });
  const canWrite = useCan("banking.write");
  const [attachTo, setAttachTo] = useState<Id<"bankStatements"> | null>(null);
  if (rows === undefined) return <div className="h-64" aria-busy="true" />;
  if (rows.length === 0) return <EmptyState icon={ReceiptTextIcon} title={t("empty")} />;
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((s) => (
        <li key={s.id} className="flex flex-col gap-2 rounded-xl border p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold">
              {formatDate(s.periodFrom)} – {formatDate(s.periodTo)}
            </span>
            <ReconciledBadge reconciled={s.reconciled} rolledBack={s.rolledBack} />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 @2xl/acc:grid-cols-4">
            <dt className="text-muted-foreground">{t("opening")}</dt>
            <dd className="tabular-nums">{money(s.openingBalanceCents, currency)}</dd>
            <dt className="text-muted-foreground">{t("closing")}</dt>
            <dd className="tabular-nums">{money(s.closingBalanceCents, currency)}</dd>
            <dt className="text-muted-foreground">{t("expected")}</dt>
            <dd className="tabular-nums">{money(s.expectedClosingCents, currency)}</dd>
            <dt className="text-muted-foreground">{t("difference")}</dt>
            <dd className="tabular-nums">{money(s.diffCents, currency)}</dd>
          </dl>
          {s.message && <p className="text-warning">{s.message}</p>}
          {s.continuity?.message && <p className="text-warning">{s.continuity.message}</p>}
          {s.differences.length > 0 && (
            <ul className="list-disc pl-5">
              {s.differences.map((d) => (
                <li key={`${d.kind}-${d.detail}`}>
                  {d.detail}
                  {d.amountCents !== undefined && ` (${money(d.amountCents, currency)})`}
                </li>
              ))}
            </ul>
          )}
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {s.files.map((f) =>
              f.url ? (
                <li key={f.sha256}>
                  <a href={f.url} className="underline" target="_blank" rel="noreferrer">
                    {f.kind === "pdf" ? t("pdfFile") : t("dataFile")}: {f.name}
                  </a>
                </li>
              ) : null,
            )}
          </ul>
          <p className="text-muted-foreground text-xs">
            {t("archived", { date: formatDateTime(s.uploadedAt), until: formatDate(s.retentionUntil) })}
          </p>
          {!s.hasPdf && !s.rolledBack && canWrite && (
            <Button variant="outline" className="h-11 self-start md:h-9" onClick={() => setAttachTo(s.id)}>
              {t("attachPdf")}
            </Button>
          )}
        </li>
      ))}
      {attachTo && <AttachPdfDialog statementId={attachTo} onClose={() => setAttachTo(null)} />}
    </ul>
  );
}

function AttachPdfDialog({ statementId, onClose }: { statementId: Id<"bankStatements">; onClose: () => void }) {
  const t = useTranslations("banking.statements");
  const run = useRun();
  const uploadUrl = useMutation(api.banking.generateUploadUrl);
  const attach = useAction(api.banking.attachStatementPdf);
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  return (
    <ConfirmDialog
      title={t("attachTitle")}
      description={t("attachHint")}
      confirmLabel={t("attach")}
      confirmDisabled={!file}
      onClose={onClose}
      onConfirm={async () => {
        if (!file) return;
        const r = await run(async () => {
          const storageId = await uploadFile(await uploadUrl({}), file);
          return attach({ statementId, storageId, name: file.name });
        }, t("attached"));
        if (r.ok) onClose();
      }}
    >
      <label htmlFor={fileId} className="font-medium text-sm">
        {t("pdfFile")}
      </label>
      <input
        id={fileId}
        type="file"
        accept="application/pdf,.pdf"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
    </ConfirmDialog>
  );
}

function Imports({ accountId }: { accountId: Id<"bankAccounts"> }) {
  const t = useTranslations("banking.imports");
  const rows = useAuthedQuery(api.banking.imports, { accountId });
  const canWrite = useCan("banking.write");
  const [rollback, setRollback] = useState<Id<"bankImports"> | null>(null);
  if (rows === undefined) return <div className="h-64" aria-busy="true" />;
  if (rows.length === 0) return <EmptyState icon={ReceiptTextIcon} title={t("empty")} />;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((i) => (
        <li key={i.id} className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{i.fileName ?? SOURCE_LABEL[i.source]}</span>
            <span className="text-muted-foreground">{formatDateTime(i.at)}</span>
          </div>
          <span>
            {SOURCE_LABEL[i.source]} · {formatDate(i.periodFrom)} – {formatDate(i.periodTo)} ·{" "}
            {t("counts", {
              inserted: i.counts.inserted,
              duplicates: i.counts.duplicates + i.counts.mergedCrossSource,
              possible: i.counts.possibleDuplicates,
            })}
          </span>
          {i.rolledBackAt !== null ? (
            <span className="text-muted-foreground">{t("rolledBackAt", { date: formatDateTime(i.rolledBackAt) })}</span>
          ) : (
            canWrite && (
              <Button variant="outline" className="h-11 self-start md:h-9" onClick={() => setRollback(i.id)}>
                {t("rollback")}
              </Button>
            )
          )}
        </li>
      ))}
      {rollback && <RollbackDialog importId={rollback} onClose={() => setRollback(null)} />}
    </ul>
  );
}

function RollbackDialog({ importId, onClose }: { importId: Id<"bankImports">; onClose: () => void }) {
  const t = useTranslations("banking.imports");
  const run = useRun();
  const rollback = useMutation(api.banking.rollback);
  const reasonId = useId();
  const [reason, setReason] = useState("");
  return (
    <ConfirmDialog
      title={t("rollbackTitle")}
      description={t("rollbackHint")}
      confirmLabel={t("rollback")}
      destructive
      confirmDisabled={reason.trim().length < 5}
      onClose={onClose}
      onConfirm={async () => {
        const r = await run(() => rollback({ importId, reason }), t("rolledBack"));
        if (r.ok) onClose();
      }}
    >
      <label htmlFor={reasonId} className="font-medium text-sm">
        {t("reason")}
      </label>
      <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} />
    </ConfirmDialog>
  );
}
