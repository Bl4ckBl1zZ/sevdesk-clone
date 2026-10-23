"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { BookCheckIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, selectClass, useCan, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TAX_RULE_LABEL_DE } from "@/domain/vouchers/tax-rules";
import { EXPENSE_TAX_RULES, type ExpenseTaxRule } from "@/domain/vouchers/types";

type VId = Id<"vouchers">;
type Skipped = readonly { label: string; reason: string }[];

/**
 * Bulk actions on selected drafts (F06 VOU-101): set account / tax rule / cost centre, „Sammelbuchung“ (a background
 * job; drafts with blocking errors or ⚑ warnings are skipped and listed in Export › Aufträge) and delete drafts.
 */
export function VoucherBulkBar({ ids, onDone }: { ids: readonly string[]; onDone: () => void }) {
  const t = useTranslations("vouchers.bulk");
  const canWrite = useCan("vouchers.write");
  const canFinalize = useCan("vouchers.finalize");
  const update = useMutation(api.vouchers.bulkUpdate);
  const remove = useMutation(api.vouchers.bulkDelete);
  const finalize = useMutation(api.vouchers.startBulkFinalize);
  const run = useRun();
  const fid = useId();
  const [dialog, setDialog] = useState<"set" | "book" | "delete" | null>(null);
  const [account, setAccount] = useState("");
  const [taxRule, setTaxRule] = useState<ExpenseTaxRule | "">("");
  const [costCenter, setCostCenter] = useState("");
  const vids = ids as VId[];

  const report = (done: number, skipped: Skipped, key: "updated" | "deleted") => {
    toast.success(t(key, { count: done }));
    if (skipped.length > 0) {
      toast.warning(t("skipped", { count: skipped.length }), {
        description: skipped.map((s) => `${s.label}: ${s.reason}`).join("\n"),
      });
    }
  };

  if (!canWrite || ids.length === 0) return null;
  return (
    <fieldset
      className="flex flex-wrap items-center gap-2 border-0 p-0 m-0"
      aria-label={t("label", { count: ids.length })}
    >
      <Button variant="outline" className="h-11 md:h-9" onClick={() => setDialog("set")} data-testid="bulk-set">
        <SlidersHorizontalIcon aria-hidden="true" />
        {t("set")}
      </Button>
      {canFinalize && (
        <Button variant="outline" className="h-11 md:h-9" onClick={() => setDialog("book")} data-testid="bulk-book">
          <BookCheckIcon aria-hidden="true" />
          {t("book")}
        </Button>
      )}
      <Button variant="outline" className="h-11 md:h-9" onClick={() => setDialog("delete")} data-testid="bulk-delete">
        <Trash2Icon aria-hidden="true" />
        {t("delete")}
      </Button>

      {dialog === "set" && (
        <ConfirmDialog
          title={t("setTitle", { count: ids.length })}
          description={t("setHint")}
          confirmLabel={t("apply")}
          confirmDisabled={!account.trim() && !taxRule && !costCenter.trim()}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const r = await run(() =>
              update({
                ids: vids,
                patch: {
                  ...(account.trim() ? { account: account.trim() } : {}),
                  ...(taxRule ? { taxRule } : {}),
                  ...(costCenter.trim() ? { costCenterId: costCenter.trim() } : {}),
                },
              }),
            );
            if (r.ok) {
              report(r.value.updated.length, r.value.skipped, "updated");
              setDialog(null);
              onDone();
            }
          }}
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${fid}-account`}>{t("account")}</Label>
              <Input
                id={`${fid}-account`}
                inputMode="numeric"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="6815"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${fid}-rule`}>{t("taxRule")}</Label>
              <select
                id={`${fid}-rule`}
                className={selectClass}
                value={taxRule}
                onChange={(e) => setTaxRule(e.target.value as ExpenseTaxRule | "")}
              >
                <option value="">{t("unchanged")}</option>
                {EXPENSE_TAX_RULES.map((r) => (
                  <option key={r} value={r}>
                    {TAX_RULE_LABEL_DE[r]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${fid}-kst`}>{t("costCenter")}</Label>
              <Input id={`${fid}-kst`} value={costCenter} onChange={(e) => setCostCenter(e.target.value)} />
            </div>
          </div>
        </ConfirmDialog>
      )}
      {dialog === "book" && (
        <ConfirmDialog
          title={t("bookTitle", { count: ids.length })}
          description={t("bookHint")}
          confirmLabel={t("bookConfirm")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const r = await run(() => finalize({ ids: vids }), t("bookStarted"));
            if (r.ok) {
              setDialog(null);
              onDone();
            }
          }}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title={t("deleteTitle", { count: ids.length })}
          description={t("deleteHint")}
          confirmLabel={t("delete")}
          destructive
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const r = await run(() => remove({ ids: vids }));
            if (r.ok) {
              report(r.value.deleted.length, r.value.skipped, "deleted");
              setDialog(null);
              onDone();
            }
          }}
        />
      )}
    </fieldset>
  );
}
