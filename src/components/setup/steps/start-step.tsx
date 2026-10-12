"use client";

import { ArrowRightIcon, FileInputIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useWizard } from "../wizard-context";

/** Step 5 "Start" (F01 SET-002): "Neu einrichten" or "Aus sevdesk importieren" (import, then return). */
export function StartStep() {
  const t = useTranslations("setup.start");
  const { formId, next } = useWizard();
  return (
    <form
      id={formId}
      noValidate
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        next();
      }}
    >
      <button
        type="submit"
        className="flex flex-col items-start gap-2 rounded-xl border p-4 text-left hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <SparklesIcon className="size-6" aria-hidden="true" />
        <span className="font-medium">{t("fresh")}</span>
        <span className="text-muted-foreground text-sm">{t("freshDescription")}</span>
      </button>
      <Link
        href="/einstellungen/import"
        className="flex flex-col items-start gap-2 rounded-xl border p-4 hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <FileInputIcon className="size-6" aria-hidden="true" />
        <span className="flex items-center gap-1 font-medium">
          {t("import")} <ArrowRightIcon className="size-4" aria-hidden="true" />
        </span>
        <span className="text-muted-foreground text-sm">{t("importDescription")}</span>
      </Link>
    </form>
  );
}
