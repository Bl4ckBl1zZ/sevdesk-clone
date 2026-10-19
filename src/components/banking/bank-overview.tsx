"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { AlertTriangleIcon, InfoIcon, LandmarkIcon, LinkIcon, PlusIcon, UploadIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { FormDialog, formatDate, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { CheckboxField, SelectField, TextField } from "@/components/forms/fields";
import { EmptyState } from "@/components/layout/empty-state";
import { PageBody } from "@/components/layout/list-layout";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { emptyStatementAccountForm, statementAccountSchema } from "@/domain/schemas/banking";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { DuplicatesPanel } from "./duplicates-panel";
import { ImportDialog } from "./import-dialog";
import { money, ReconciledBadge } from "./shared";

/**
 * Bank overview (F07 §6, 04 §4.6): monthly statement to-dos (BNK-030, EC-156/EC-BNK-52), one card per currency
 * account with the last statement and its reconciliation, „Kontoauszug importieren“, the possible-duplicates review.
 */
export function BankOverview() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <BankOverviewInner />
    </ConvexGuard>
  );
}

/** F07 §6.1 connection banner: expiring (T−14/T−3), reauth required, error, disconnected — with a link to the setup. */
function ConnectionBanner() {
  const t = useTranslations("bankFeed");
  const c = useAuthedQuery(api.bankFeed.connection, {});
  if (!c || c.status === "not_configured") return null;
  const text =
    c.status === "reauth_required" || c.status === "error" || c.status === "disconnected"
      ? (c.lastError ?? c.feedLostMessage ?? c.statusLabel)
      : c.banner?.message;
  if (!text) return null;
  return (
    <p
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
    >
      <AlertTriangleIcon className="size-4" aria-hidden="true" />
      <span className="min-w-0 flex-1">{text}</span>
      <Link className="underline underline-offset-4" href={"/einstellungen/bank/verbindung" as Route}>
        {c.status === "reauth_required" ? t("actions.reconnect") : t("status.title")}
      </Link>
    </p>
  );
}

function BankOverviewInner() {
  const t = useTranslations("banking.overview");
  const accounts = useAuthedQuery(api.banking.accounts, {});
  const todos = useAuthedQuery(api.banking.todos, {}) ?? [];
  const canImport = useCan("banking.write");
  const canCreate = useCan("settings.write");
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);

  if (accounts === undefined) return <PageBody aria-busy="true" className="h-96" />;
  return (
    <PageBody className="@container/bank">
      <ConnectionBanner />
      <div className="flex flex-wrap gap-2">
        {canImport && accounts.length > 0 && (
          <Button className="h-11 md:h-9" onClick={() => setImporting(true)}>
            <UploadIcon aria-hidden="true" />
            {t("import")}
          </Button>
        )}
        {accounts.length > 0 && (
          <Link
            href={"/bank/zuordnungen" as Route}
            className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}
          >
            <LinkIcon aria-hidden="true" />
            {t("matching")}
          </Link>
        )}
        {canCreate && (
          <Button variant="outline" className="h-11 md:h-9" onClick={() => setCreating(true)}>
            <PlusIcon aria-hidden="true" />
            {t("addAccount")}
          </Button>
        )}
      </div>

      {todos.length > 0 && (
        <section aria-labelledby="bank-todos" className="flex flex-col gap-2">
          <h2 id="bank-todos" className="font-semibold text-base">
            {t("todos")}
          </h2>
          <ul className="flex flex-col gap-2">
            {todos.map((todo) => (
              <li
                key={`${todo.accountId}-${todo.month}-${todo.kind}`}
                className={
                  todo.severity === "warning"
                    ? "flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
                    : "flex items-start gap-2 rounded-md border border-info/30 bg-info/10 p-3 text-sm"
                }
              >
                {todo.severity === "warning" ? (
                  <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                )}
                <span>
                  <span className="font-medium">{todo.accountName}:</span> {todo.title}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {accounts.length === 0 ? (
        <EmptyState icon={LandmarkIcon} title={t("empty")} />
      ) : (
        <section aria-labelledby="bank-accounts" className="flex flex-col gap-2">
          <h2 id="bank-accounts" className="font-semibold text-base">
            {t("accounts")}
          </h2>
          <ul className="grid gap-3 @2xl/bank:grid-cols-2 @5xl/bank:grid-cols-3">
            {accounts.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/bank/${a.id}` as Route}
                  className="flex h-full flex-col gap-2 rounded-xl border p-4 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{a.name}</span>
                    <Badge variant="outline">{a.currency}</Badge>
                  </span>
                  <span className="text-muted-foreground text-sm">{a.iban ?? t("noIban")}</span>
                  {a.lastStatement ? (
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      <span>
                        {t("closing", {
                          date: formatDate(a.lastStatement.periodTo),
                          amount: money(a.lastStatement.closingBalanceCents, a.currency),
                        })}
                      </span>
                      <ReconciledBadge reconciled={a.lastStatement.reconciled} />
                      {!a.lastStatement.hasPdf && <Badge variant="secondary">{t("pdfMissing")}</Badge>}
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-sm">{t("noStatement")}</span>
                  )}
                  <span className="text-sm">
                    {t("open", { count: a.openCount })}
                    {a.possibleDuplicates > 0 && ` · ${t("duplicates", { count: a.possibleDuplicates })}`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <DuplicatesPanel />

      {importing && <ImportDialog accounts={accounts} onClose={() => setImporting(false)} />}
      {creating && <AccountDialog onClose={() => setCreating(false)} />}
    </PageBody>
  );
}

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "PLN", "SEK", "DKK", "NOK", "CZK", "HUF", "JPY"];

function AccountDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("banking.account");
  const run = useRun();
  const create = useMutation(api.banking.createAccount);
  const formId = useId();
  const form = useZodForm(statementAccountSchema, emptyStatementAccountForm());
  const submit = form.handleSubmit(async () => {
    const r = await run(() => create({ values: form.getValues() }), t("saved"));
    if (r.ok) onClose();
  });
  return (
    <FormDialog
      title={t("title")}
      description={t("description")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
    >
      <TextField form={form} name="name" label={t("name")} required placeholder="Revolut EUR" />
      <SelectField
        form={form}
        name="currency"
        label={t("currency")}
        required
        options={CURRENCIES.map((c) => ({ value: c, label: c }))}
      />
      <TextField form={form} name="iban" label={t("iban")} description={t("ibanHint")} autoComplete="off" />
      <TextField form={form} name="bic" label={t("bic")} autoComplete="off" />
      <TextField form={form} name="accountHolder" label={t("holder")} required />
      <CheckboxField form={form} name="showOnInvoices" label={t("showOnInvoices")} />
    </FormDialog>
  );
}
