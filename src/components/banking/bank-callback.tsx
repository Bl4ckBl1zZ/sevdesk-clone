"use client";

import { api } from "@convex/_generated/api";
import { useAction } from "convex/react";
import { CircleAlertIcon, CircleCheckIcon, LoaderIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * `/einstellungen/bank/callback` (F07 BNK-102/103, 04 §4.13): the bank sends the owner's browser back here with
 * `code` + `state` (or `error`). The page calls `completeConsent` exactly once — state check, session, account
 * mapping and the history backfill run inside that action — and strips the code from the address bar.
 */
type Outcome =
  | { kind: "running" }
  | { kind: "done"; mapped: number; pendingAccounts: number; missing: number; inserted: number; gaps: number }
  | { kind: "error"; message: string };

export function BankCallback() {
  return (
    <ConvexGuard fallback={<div className="h-48" aria-busy="true" />}>
      <BankCallbackInner />
    </ConvexGuard>
  );
}

function BankCallbackInner() {
  const t = useTranslations("bankFeed.callback");
  const params = useSearchParams();
  const complete = useAction(api.bankFeedNode.completeConsent);
  const started = useRef(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "running" });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = params.get("code") ?? undefined;
    const state = params.get("state") ?? undefined;
    const error = params.get("error") ?? undefined;
    window.history.replaceState(null, "", window.location.pathname);
    complete({
      ...(code ? { code } : {}),
      ...(state ? { state } : {}),
      ...(error ? { error } : {}),
    })
      .then((r) => setOutcome({ kind: "done", ...r }))
      .catch((e: unknown) =>
        setOutcome({
          kind: "error",
          message: (e as { data?: { message?: string } }).data?.message ?? t("failed"),
        }),
      );
  }, [complete, params, t]);

  return (
    <Card size="sm" className="max-w-2xl">
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm" aria-live="polite">
        {outcome.kind === "running" && (
          <p className="inline-flex items-center gap-2" role="status">
            <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
            {t("running")}
          </p>
        )}
        {outcome.kind === "done" && (
          <>
            <p className="inline-flex items-center gap-2 text-success" role="status">
              <CircleCheckIcon className="size-4" aria-hidden="true" />
              {t("done", { mapped: outcome.mapped, inserted: outcome.inserted })}
            </p>
            {outcome.pendingAccounts > 0 && <p>{t("pendingAccounts", { count: outcome.pendingAccounts })}</p>}
            {outcome.missing > 0 && <p>{t("missing", { count: outcome.missing })}</p>}
            {outcome.gaps > 0 && <p>{t("gaps", { count: outcome.gaps })}</p>}
            <Link href="/einstellungen/bank/verbindung" className={cn(buttonVariants(), "h-11 self-start md:h-9")}>
              {t("back")}
            </Link>
          </>
        )}
        {outcome.kind === "error" && (
          <>
            <p className="inline-flex items-center gap-2 text-danger" role="alert">
              <CircleAlertIcon className="size-4" aria-hidden="true" />
              {outcome.message}
            </p>
            <Link href="/einstellungen/bank/verbindung" className={cn(buttonVariants(), "h-11 self-start md:h-9")}>
              {t("retry")}
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}
