"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { ShieldAlertIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ConfirmDialog, formatDate, formatDateTime, useCan, useRun } from "@/components/catalog/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type PurgeClass = "books10" | "vouchers8" | "letters6" | "auditLog" | "contacts";

/**
 * F12 §6 Aufbewahrung › Löschvorschläge / Betriebsprüfung-Modus / Löschläufe (PRV-003…PRV-008, GOBD-21).
 * Nothing is ever deleted automatically: the owner selects classes and years, confirms the Ablaufhemmung checklist
 * and types the phrase; the server re-checks everything (retentionUntil, hold, checklist, phrase).
 */
export function RetentionPurge() {
  const t = useTranslations("privacy.purge");
  const data = useAuthedQuery(api.retention.worklist, {});
  const history = useAuthedQuery(api.retention.history, {});
  const isOwner = useCan("retention.purge");
  const [wizard, setWizard] = useState(false);
  const [hold, setHold] = useState<"start" | "end" | null>(null);
  if (!data) return <div className="h-40" aria-busy="true" />;
  const labelOf = (id: string) => data.classes.find((c) => c.id === id)?.label ?? id;
  return (
    <div className="@container flex flex-col gap-4">
      {data.hold && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
        >
          <ShieldAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("holdActive", {
            reason: data.hold.reason,
            years: data.hold.fiscalYears.join(", ") || "—",
            date: formatDateTime(data.hold.activeFrom),
          })}
        </p>
      )}
      <section aria-labelledby="purge-worklist" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="purge-worklist" className="font-semibold">
            {t("worklist")}
          </h2>
          {isOwner && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="min-h-11 md:min-h-9"
                onClick={() => setHold(data.hold ? "end" : "start")}
              >
                {data.hold ? t("holdEnd") : t("holdStart")}
              </Button>
              <Button
                variant="destructive"
                className="min-h-11 md:min-h-9"
                disabled={data.total === 0 || data.hold !== null}
                onClick={() => setWizard(true)}
              >
                <Trash2Icon aria-hidden="true" />
                {t("start")}
              </Button>
            </div>
          )}
        </div>
        {data.total === 0 ? (
          <p className="text-muted-foreground text-sm">{t("nothingDue")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" aria-label={t("worklist")}>
            {data.groups.map((g) => (
              <li key={`${g.retentionClass}-${g.year}`} className="flex flex-wrap justify-between gap-2 border-b py-1">
                <span>{t("groupLine", { label: labelOf(g.retentionClass), year: g.year })}</span>
                <span className="tabular-nums">{t("count", { count: g.count })}</span>
              </li>
            ))}
            {data.auditPrefix.count > 0 && (
              <li className="flex flex-wrap justify-between gap-2 border-b py-1">
                <span>{t("auditPrefix", { seq: data.auditPrefix.upToSeq })}</span>
                <span className="tabular-nums">{t("count", { count: data.auditPrefix.count })}</span>
              </li>
            )}
            {data.contacts.map((c) => (
              <li key={c.id} className="flex flex-wrap justify-between gap-2 border-b py-1">
                <span>{t("contactLine", { number: c.number, date: formatDate(c.scheduledPurgeAt) })}</span>
                <span className="text-muted-foreground">
                  {c.blockedBy > 0 ? t("blockedBy", { count: c.blockedBy }) : t("contactDue")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="purge-history" className="flex flex-col gap-2">
        <h2 id="purge-history" className="font-semibold">
          {t("history")}
        </h2>
        {!history || history.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noHistory")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" aria-label={t("history")}>
            {history.map((b) => (
              <li key={b.id} className="flex flex-col gap-1 border-b py-1 @md:flex-row @md:justify-between">
                <span>
                  {formatDateTime(b.createdAt)} · {b.classes.map(labelOf).join(", ")}
                  {b.replayOf ? ` · ${t("replay")}` : ""}
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant={b.status === "failed" ? "destructive" : "outline"}>{t(`status.${b.status}`)}</Badge>
                  <span className="tabular-nums">
                    {t("count", { count: Object.values(b.counts ?? {}).reduce((s, n) => s + Number(n), 0) })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {wizard && (
        <PurgeWizard
          classes={data.classes as { id: PurgeClass; label: string }[]}
          years={[...new Set(data.groups.map((g) => g.year))].sort()}
          checklist={data.checklist}
          phrase={data.phrase}
          onClose={() => setWizard(false)}
        />
      )}
      {hold && <HoldDialog mode={hold} onClose={() => setHold(null)} />}
    </div>
  );
}

function PurgeWizard({
  classes,
  years,
  checklist,
  phrase,
  onClose,
}: {
  classes: { id: PurgeClass; label: string }[];
  years: number[];
  checklist: readonly { id: string; label: string }[];
  phrase: string;
  onClose: () => void;
}) {
  const t = useTranslations("privacy.purge");
  const run = useRun();
  const start = useMutation(api.retention.startPurge);
  const [selected, setSelected] = useState<PurgeClass[]>([]);
  const [yearSel, setYearSel] = useState<number[]>([]);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [typed, setTyped] = useState("");
  const phraseId = useId();
  const preview = useAuthedQuery(api.retention.preview, { classes: selected, years: yearSel }, selected.length > 0);
  const allChecked = checklist.every((c) => checks[c.id]);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <ConfirmDialog
      title={t("wizardTitle")}
      description={t("wizardDescription")}
      confirmLabel={t("confirm")}
      destructive
      confirmDisabled={
        selected.length === 0 || !allChecked || typed.trim() !== phrase || !preview || preview.total === 0
      }
      onClose={onClose}
      onConfirm={async () => {
        const r = await run(
          () => start({ classes: selected, years: yearSel, checklist: checks, phrase: typed }),
          t("started"),
        );
        if (r.ok) onClose();
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium text-sm">{t("classes")}</legend>
        {classes.map((c) => (
          <div key={c.id} className="flex min-h-11 items-center gap-2 md:min-h-8">
            <Checkbox
              id={`${phraseId}-c-${c.id}`}
              checked={selected.includes(c.id)}
              onCheckedChange={() => setSelected(toggle(selected, c.id))}
            />
            <Label htmlFor={`${phraseId}-c-${c.id}`} className="font-normal">
              {c.label}
            </Label>
          </div>
        ))}
      </fieldset>
      {years.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium text-sm">{t("yearsLegend")}</legend>
          <div className="flex flex-wrap gap-3">
            {years.map((y) => (
              <div key={y} className="flex min-h-11 items-center gap-2 md:min-h-8">
                <Checkbox
                  id={`${phraseId}-y-${y}`}
                  checked={yearSel.includes(y)}
                  onCheckedChange={() => setYearSel(toggle(yearSel, y))}
                />
                <Label htmlFor={`${phraseId}-y-${y}`} className="font-normal">
                  {y}
                </Label>
              </div>
            ))}
          </div>
        </fieldset>
      )}
      {preview && (
        <p role="status" className="text-sm">
          {preview.total === 0 ? t("previewNone") : t("preview", { count: preview.total, files: preview.files })}
        </p>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium text-sm">{t("checklist")}</legend>
        {checklist.map((c) => (
          <div key={c.id} className="flex min-h-11 items-start gap-2 md:min-h-8">
            <Checkbox
              id={`${phraseId}-k-${c.id}`}
              className="mt-0.5"
              checked={checks[c.id] === true}
              onCheckedChange={(v) => setChecks({ ...checks, [c.id]: v === true })}
            />
            <Label htmlFor={`${phraseId}-k-${c.id}`} className="font-normal">
              {c.label}
            </Label>
          </div>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1">
        <Label htmlFor={phraseId}>{t("phrase", { phrase })}</Label>
        <Input id={phraseId} value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}

function HoldDialog({ mode, onClose }: { mode: "start" | "end"; onClose: () => void }) {
  const t = useTranslations("privacy.purge");
  const run = useRun();
  const startHold = useMutation(api.retention.startHoldMode);
  const endHold = useMutation(api.retention.endHoldMode);
  const [reason, setReason] = useState("");
  const [years, setYears] = useState("");
  const reasonId = useId();
  const yearsId = useId();
  const fiscalYears = years
    .split(/[,\s]+/)
    .map((y) => Number.parseInt(y, 10))
    .filter((y) => Number.isInteger(y) && y > 1990);
  return (
    <ConfirmDialog
      title={mode === "start" ? t("holdStart") : t("holdEnd")}
      description={mode === "start" ? t("holdStartDescription") : t("holdEndDescription")}
      confirmLabel={mode === "start" ? t("holdStart") : t("holdEnd")}
      confirmDisabled={reason.trim().length === 0}
      onClose={onClose}
      onConfirm={async () => {
        const r = await run(
          () => (mode === "start" ? startHold({ reason, fiscalYears }) : endHold({ reason })),
          mode === "start" ? t("holdStarted") : t("holdEnded"),
        );
        if (r.ok) onClose();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={reasonId}>{t("holdReason")}</Label>
        <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {mode === "start" && (
        <div className="flex flex-col gap-1">
          <Label htmlFor={yearsId}>{t("holdYears")}</Label>
          <Input id={yearsId} inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value)} />
        </div>
      )}
    </ConfirmDialog>
  );
}
