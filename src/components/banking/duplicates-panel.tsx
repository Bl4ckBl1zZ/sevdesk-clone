"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { formatDate, useCan, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { Amount, SOURCE_LABEL } from "./shared";

/**
 * „Mögliche Dubletten“ (F07 BNK-034/110, RI-29): rows a file delivered that look like an existing booking but cannot
 * be proven to be the same. Never inserted silently: „Gleicher Umsatz“ records the delivery, „Eigener Umsatz“ books it.
 */
export function DuplicatesPanel({ accountId }: { accountId?: string }) {
  const t = useTranslations("banking.duplicates");
  const run = useRun();
  const canWrite = useCan("banking.write");
  const rows = useAuthedQuery(api.banking.possibleDuplicates, accountId ? { accountId: accountId as never } : {}) ?? [];
  const resolve = useMutation(api.banking.resolveDuplicate);
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="bank-duplicates" className="flex flex-col gap-2">
      <h2 id="bank-duplicates" className="font-semibold text-base">
        {t("title", { count: rows.length })}
      </h2>
      <p className="text-muted-foreground text-sm">{t("hint")}</p>
      <ul className="flex flex-col gap-2">
        {rows.map((d) => (
          <li key={d.id} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-medium">{formatDate(d.candidate.bookingDate)}</span>{" "}
                {d.candidate.counterpartyName ?? d.candidate.purpose}
              </span>
              <Amount cents={d.candidate.amountCents} currency={d.candidate.currency} />
            </div>
            <p className="text-muted-foreground">
              {t("from", { source: SOURCE_LABEL[d.candidate.source] ?? d.candidate.source, line: d.candidate.line })}
              {" · "}
              {t("existing", { count: d.existing.length })}:{" "}
              {d.existing.map((e) => `${formatDate(e.bookingDate)} ${e.counterpartyName ?? e.purpose}`).join("; ")}
            </p>
            {canWrite && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="h-11 md:h-9"
                  onClick={() => void run(() => resolve({ id: d.id, decision: "same" }), t("resolvedSame"))}
                >
                  {t("same")}
                </Button>
                <Button
                  variant="outline"
                  className="h-11 md:h-9"
                  onClick={() => void run(() => resolve({ id: d.id, decision: "separate" }), t("resolvedSeparate"))}
                >
                  {t("separate")}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
