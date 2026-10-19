"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { ChevronDownIcon, DownloadIcon } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CsvVariant } from "@/domain/csv/export";

export function downloadText(name: string, content: string, mime = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type ServerList = "documents" | "open_items" | "payments" | "bank_transactions" | "journal";

/**
 * F09 EXP-021 „Export ▾": „CSV (Excel)" and „CSV (technisch)" of the list's current filter. Server lists go through
 * `exports.csv` (audited; > 5,000 rows become a job, EXP-026); `local` formats rows the page already has.
 */
export function ExportMenu(
  props:
    | { list: ServerList; params?: { type?: string; accountId?: string; dateFrom?: string; dateTo?: string } }
    | { local: (variant: CsvVariant) => Promise<void> | void },
) {
  const t = useTranslations("exports");
  const csv = useMutation(api.exports.csv);
  const run = useRun();
  const router = useRouter();
  const go = async (variant: CsvVariant) => {
    if ("local" in props) {
      await props.local(variant);
      return;
    }
    const r = await run(() => csv({ list: props.list, variant, ...(props.params ?? {}) }));
    if (!r.ok) return;
    if (r.value.kind === "file") {
      downloadText(r.value.name, r.value.content);
      toast.success(t("downloaded", { rows: r.value.rows }));
    } else {
      toast.info(t("jobStarted", { rows: r.value.rows }), {
        action: { label: t("toJobs"), onClick: () => router.push("/export" as Route) },
      });
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className="h-11 md:h-9" aria-label={t("menuLabel")} />}>
        <DownloadIcon aria-hidden="true" />
        {t("menu")}
        <ChevronDownIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={() => void go("excel")}>{t("excel")}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void go("technical")}>{t("technical")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
