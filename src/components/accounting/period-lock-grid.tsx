"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { LockIcon, LockOpenIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { periodDe } from "./format";

const SELECT =
  "h-11 w-32 rounded-md border border-input bg-background px-2.5 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm dark:bg-input/30";

/**
 * Festschreibung (F08 §6 /buchhaltung/festschreibung; ACC-015…ACC-017): month grid per fiscal year (open / locked 🔒
 * with reason, date, actor); choosing a month opens the dialog with the months covered „lückenlos“, the pre-lock
 * checklist (blockers stop, warnings inform) and the irreversible confirmation.
 */
export function PeriodLockGrid({ canLock }: { canLock: boolean }) {
  return (
    <ConvexGuard fallback={null}>
      <Inner canLock={canLock} />
    </ConvexGuard>
  );
}

function Inner({ canLock }: { canLock: boolean }) {
  const t = useTranslations("periodLock");
  const format = useFormatter();
  const yearId = useId();
  const [year, setYear] = useState<number | undefined>(undefined);
  const data = useAuthedQuery(api.periods.overview, year ? { fiscalYear: year } : {});
  const [target, setTarget] = useState<string | null>(null);
  if (data === undefined) return <div className="h-60" aria-busy="true" />;
  const fy = data.fiscalYear;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">{t("intro")}</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={yearId}>{t("year")}</Label>
        <select id={yearId} className={SELECT} value={fy} onChange={(e) => setYear(Number(e.target.value))}>
          {[fy + 1, fy, fy - 1, fy - 2].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      <ul className="grid grid-cols-1 gap-2 @md/main:grid-cols-2 @3xl/main:grid-cols-3 @5xl/main:grid-cols-4">
        {data.months.map((m) => {
          const locked = m.status === "locked";
          const future = m.period > data.currentPeriod;
          return (
            <li key={m.period} className="flex min-h-24 flex-col gap-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium tabular-nums">{periodDe(m.period)}</span>
                {locked ? (
                  <Badge variant="secondary">
                    <LockIcon aria-hidden="true" />
                    {t("locked")}
                  </Badge>
                ) : m.status === "locking" ? (
                  <Badge variant="outline">{t("locking")}</Badge>
                ) : (
                  <Badge variant="outline">
                    <LockOpenIcon aria-hidden="true" />
                    {t("open")}
                  </Badge>
                )}
              </div>
              {locked && (
                <p className="text-muted-foreground text-xs">
                  {t(`reasons.${m.reason ?? "manual"}`)}
                  {m.lockedAt !== undefined &&
                    ` · ${format.dateTime(new Date(m.lockedAt), { dateStyle: "medium", timeStyle: "short" })}`}
                  {m.lockedBy && ` · ${m.lockedBy}`}
                </p>
              )}
              {canLock && !locked && m.status === "open" && !future && (
                <Button variant="outline" className="h-11 self-start md:h-9" onClick={() => setTarget(m.period)}>
                  {t("lockThrough", { period: periodDe(m.period) })}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {target && <LockDialog period={target} onClose={() => setTarget(null)} />}
    </div>
  );
}

function LockDialog({ period, onClose }: { period: string; onClose: () => void }) {
  const t = useTranslations("periodLock");
  const preview = useAuthedQuery(api.periods.lockPreview, { period });
  const lock = useMutation(api.periods.lock);
  const showError = useAdapterErrorToast();
  const confirmId = useId();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const blocked = (preview?.checklist.blockers.length ?? 0) > 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle", { period: periodDe(period) })}</DialogTitle>
          <DialogDescription>{t("irreversible")}</DialogDescription>
        </DialogHeader>
        {preview === undefined ? (
          <div className="h-32" aria-busy="true" />
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <p>{t("months", { list: preview.months.map(periodDe).join(", ") })}</p>
            {preview.gapNotice && <p className="rounded-md border p-3">{preview.gapNotice}</p>}
            {preview.checklist.blockers.length > 0 && (
              <section aria-labelledby="lock-blockers" className="flex flex-col gap-1">
                <h3 id="lock-blockers" className="font-medium text-destructive">
                  {t("blockers")}
                </h3>
                <ul className="list-disc pl-5">
                  {preview.checklist.blockers.map((b) => (
                    <li key={b.code}>{b.message}</li>
                  ))}
                </ul>
              </section>
            )}
            {preview.checklist.warnings.length > 0 && (
              <section aria-labelledby="lock-warnings" className="flex flex-col gap-1">
                <h3 id="lock-warnings" className="font-medium">
                  {t("warnings")}
                </h3>
                <ul className="list-disc pl-5">
                  {preview.checklist.warnings.map((w) => (
                    <li key={w.code}>{w.message}</li>
                  ))}
                </ul>
              </section>
            )}
            {preview.checklist.ok && preview.checklist.warnings.length === 0 && <p>{t("allClear")}</p>}
            {!blocked && (
              <div className="flex items-start gap-2">
                <Checkbox id={confirmId} checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} />
                <Label htmlFor={confirmId} className="font-normal leading-snug">
                  {t("confirm")}
                </Label>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            className="h-11 md:h-9"
            disabled={busy || blocked || !confirmed || preview === undefined}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await lock({ period });
                toast.success(t("done", { count: r.months.length }));
                onClose();
              } catch (e) {
                showError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            <LockIcon aria-hidden="true" />
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
