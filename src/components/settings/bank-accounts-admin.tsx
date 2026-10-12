"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { FormErrorSummary, TextField } from "@/components/forms/fields";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type BankAccountFormValues, bankAccountSchema } from "@/domain/schemas/settings";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type Account = FunctionReturnType<typeof api.settings.listInvoiceAccounts>[number];
type AddForm = UseFormReturn<BankAccountFormValues, unknown, BankAccountFormValues>;

/**
 * Rechnungskonten (F01 SET-050…054): every manual invoice account with „Als Standard“ (SET-051) and „Archivieren“
 * (SET-054: never the only invoice account, never the default). Bank connections follow in P2.
 */
export function BankAccountsAdmin() {
  return (
    <ConvexGuard fallback={null}>
      <BankAccountsAdminInner />
    </ConvexGuard>
  );
}

function BankAccountsAdminInner() {
  const t = useTranslations("settings.bankAccounts");
  const accounts = useAuthedQuery(api.settings.listInvoiceAccounts, {});
  const [adding, setAdding] = useState(false);
  if (accounts === undefined) return <div className="h-40" aria-busy="true" />;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle>
            <h2>{t("title")}</h2>
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </div>
        <Button variant="outline" className="h-11 md:h-9" onClick={() => setAdding(true)}>
          <PlusIcon aria-hidden="true" />
          {t("add")}
        </Button>
      </CardHeader>
      <CardContent>
        {accounts.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {accounts.map((a) => (
              <AccountRow key={a.bankAccountId} account={a} />
            ))}
          </ul>
        )}
      </CardContent>
      <AddAccountDialog open={adding} onOpenChange={setAdding} />
    </Card>
  );
}

function AccountRow({ account }: { account: Account }) {
  const t = useTranslations("settings.bankAccounts");
  const setDefault = useMutation(api.settings.setDefaultBankAccount);
  const archive = useMutation(api.settings.archiveBankAccount);
  const showError = useAdapterErrorToast();
  const [busy, setBusy] = useState(false);
  const id = account.bankAccountId as Id<"bankAccounts">;
  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  const archived = account.archivedAt !== null;
  return (
    <li className="flex flex-col gap-2 p-3 text-sm @2xl/main:flex-row @2xl/main:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {account.name}
          {account.isDefaultForInvoices && <Badge variant="secondary">{t("default")}</Badge>}
          {archived && <Badge variant="outline">{t("archived")}</Badge>}
        </span>
        <span className="break-all font-mono text-muted-foreground">
          {account.iban}
          {account.bic ? ` · ${account.bic}` : ""}
        </span>
        <span className="text-muted-foreground">{account.accountHolder}</span>
      </div>
      {!archived && (
        <div className="flex gap-2">
          {!account.isDefaultForInvoices && (
            <Button
              variant="outline"
              size="sm"
              className="h-11 md:h-8"
              disabled={busy}
              onClick={() => void run(() => setDefault({ bankAccountId: id }), t("defaultSet"))}
            >
              {t("makeDefault")}
              <span className="sr-only"> ({account.name})</span>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-11 md:h-8"
            disabled={busy}
            onClick={() => void run(() => archive({ bankAccountId: id }), t("archivedDone"))}
          >
            {t("archive")}
            <span className="sr-only"> ({account.name})</span>
          </Button>
        </div>
      )}
    </li>
  );
}

const addDefaults: BankAccountFormValues = { name: "", iban: "", bic: "", accountHolder: "", currency: "EUR" };

function AddAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("settings.bankAccounts");
  const tBank = useTranslations("setup.bank");
  const tCommon = useTranslations("common");
  const formId = useId();
  const add = useMutation(api.settings.addBankAccount);
  const showError = useAdapterErrorToast();
  const form = useZodForm(bankAccountSchema, addDefaults) as unknown as AddForm;
  const submit = form.handleSubmit(async (values) => {
    try {
      await add({ values });
      toast.success(t("added"));
      form.reset(addDefaults);
      onOpenChange(false);
    } catch (e) {
      showError(e);
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("addTitle")}</DialogTitle>
          <DialogDescription>{t("addDescription")}</DialogDescription>
        </DialogHeader>
        <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
          <FormErrorSummary form={form} />
          <TextField form={form} name="name" label={t("name")} required maxLength={60} />
          <TextField
            form={form}
            name="iban"
            label={tBank("iban")}
            required
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
          <TextField form={form} name="bic" label={tBank("bic")} autoCapitalize="characters" spellCheck={false} />
          <TextField form={form} name="accountHolder" label={tBank("accountHolder")} required maxLength={70} />
        </form>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" form={formId} className="h-11 md:h-9" disabled={form.formState.isSubmitting}>
            {t("add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
