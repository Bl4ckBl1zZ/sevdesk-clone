"use client";

import type { Id } from "@convex/_generated/dataModel";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { formatMoneyDe } from "@/domain/banking/amount";
import { TRANSACTION_STATUS_LABEL_DE } from "@/domain/schemas/banking";
import { cn } from "@/lib/utils";

/** Shared pieces of the Bank and Kasse screens (F07 §6, 04 §4.6/§4.12). */

export const money = (cents: number | null | undefined, currency = "EUR") =>
  cents === null || cents === undefined ? "—" : formatMoneyDe(cents, currency);

/** Signed amount, green for credits (text colours meet WCAG AA in both themes). */
export function Amount({ cents, currency, className }: { cents: number; currency: string; className?: string }) {
  return (
    <span className={cn("whitespace-nowrap tabular-nums", cents > 0 && "text-success", className)}>
      {money(cents, currency)}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const variant = status === "open" ? "outline" : status === "ignored" ? "secondary" : "default";
  return <Badge variant={variant}>{TRANSACTION_STATUS_LABEL_DE[status] ?? status}</Badge>;
}

export function ReconciledBadge({ reconciled, rolledBack }: { reconciled: boolean; rolledBack?: boolean }) {
  const t = useTranslations("banking.statements");
  if (rolledBack) return <Badge variant="secondary">{t("rolledBack")}</Badge>;
  return reconciled ? <Badge>{t("reconciled")}</Badge> : <Badge variant="destructive">{t("notReconciled")}</Badge>;
}

/** Uploads a file to Convex storage (generateUploadUrl → POST) and returns its id. */
export async function uploadFile(uploadUrl: string, file: File): Promise<Id<"_storage">> {
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload fehlgeschlagen (${res.status}).`);
  return ((await res.json()) as { storageId: Id<"_storage"> }).storageId;
}

export const SOURCE_LABEL: Readonly<Record<string, string>> = {
  camt053: "CAMT.053",
  mt940: "MT940",
  revolut_csv: "Revolut-CSV",
  csv: "CSV",
  enable_banking: "Bank-Feed",
};
