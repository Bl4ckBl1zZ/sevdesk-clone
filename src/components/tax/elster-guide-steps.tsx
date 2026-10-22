"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { euro } from "@/components/accounting/format";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { parseCents } from "@/domain/money/parse";
import type { ElsterGuide } from "@/domain/tax/elster-guide";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";

/**
 * Mein ELSTER step page (F08 §4.7a, TAX-020): prerequisites, navigation path with the Formularjahr in large type,
 * fields in ELSTER order with „Kopieren“ and „eingetragen“ ticks, the final checklist. Rendered from the pure guide
 * (src/domain/tax/elster-guide.ts) so the copied strings are exactly what ELSTER expects.
 */
/** The guide shape the step page renders: UStVA/ZM/USt 1 H guides and the Anlage EÜR guide (fields with Zeile). */
export type GuideLike = Omit<ElsterGuide, "steps" | "id" | "correction"> & {
  steps: {
    title: string;
    instruction?: string;
    fields: { kz: string; zeile?: number; label: string; copy: string | null }[];
    rows?: ElsterGuide["steps"][number]["rows"];
  }[];
};

export function ElsterGuideSteps({ guide }: { guide: GuideLike }) {
  const t = useTranslations("tax.guide");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const tick = (key: string) =>
    setTicked((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  return (
    <ol className="flex flex-col gap-4">
      {guide.formYearWarning && (
        <li className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
          <p role="alert">{guide.formYearWarning}</p>
        </li>
      )}
      <Step n={2} title={t("setup")}>
        <ul className="list-disc pl-5 text-sm">
          {guide.prerequisites.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </Step>
      <Step n={3} title={t("open")}>
        <p className="text-sm">{guide.navigation.join(" › ")}</p>
        <p className="font-semibold text-2xl">
          {guide.formName.includes(String(guide.formYear)) ? guide.formName : `${guide.formName} ${guide.formYear}`}
        </p>
        <p className="text-muted-foreground text-xs">{t("sideBySide")}</p>
      </Step>
      <Step n={4} title={t("enter")}>
        <div className="flex flex-col gap-4">
          {guide.steps.map((s) => (
            <section key={s.title} className="flex flex-col gap-2">
              <h4 className="font-medium text-sm">{s.title}</h4>
              {s.instruction && <p className="rounded-md bg-muted p-2 text-sm">{s.instruction}</p>}
              {s.fields.length > 0 && (
                <ul className="flex flex-col divide-y rounded-md border">
                  {s.fields.map((f) => (
                    <li key={f.kz} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                      {f.zeile !== undefined && <span className="w-16 font-mono">{t("line", { zeile: f.zeile })}</span>}
                      <span className="w-14 font-mono">Kz {f.kz}</span>
                      <span className="min-w-40 flex-1">{f.label}</span>
                      {f.copy === null ? (
                        <span className="text-muted-foreground text-xs">{t("leaveEmpty")}</span>
                      ) : (
                        <>
                          <span className="font-mono tabular-nums">{f.copy}</span>
                          <CopyButton value={f.copy} label={t("copyField", { kz: f.kz })} />
                          <TickBox
                            checked={ticked.has(`${s.title}-${f.kz}`)}
                            onChange={() => tick(`${s.title}-${f.kz}`)}
                            label={t("entered")}
                            id={`kz-${s.title.replace(/\W+/g, "")}-${f.kz}`}
                          />
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {s.rows && s.rows.length > 0 && (
                <ul className="flex flex-col divide-y rounded-md border">
                  {s.rows.map((r) => {
                    const key = `${r.countryCode}${r.vatNumber}${r.type}`;
                    return (
                      <li key={key} className="flex flex-wrap items-center gap-2 p-2 text-sm">
                        <span className="w-10 font-mono">{r.countryCode}</span>
                        <span className="font-mono">{r.copy.vatNumber}</span>
                        <CopyButton value={r.copy.vatNumber} label={t("copyVatId", { id: r.vatNumber })} />
                        <span className="w-6">{r.type}</span>
                        <span className="font-mono tabular-nums">{r.copy.amount}</span>
                        <CopyButton value={r.copy.amount} label={t("copyAmount", { id: r.vatNumber })} />
                        <TickBox
                          checked={ticked.has(key)}
                          onChange={() => tick(key)}
                          label={t("entered")}
                          id={`zm-${key}`}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
        </div>
      </Step>
      <Step n={5} title={t("check")}>
        <ul className="list-disc pl-5 text-sm">
          {guide.checklist.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Step>
    </ol>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-4">
      <h3 className="font-medium">
        <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">
          {n}
        </span>
        {title}
      </h3>
      {children}
    </li>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations("tax.guide");
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-11 md:h-8"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast.success(t("copied", { value }));
        } catch {
          toast.error(t("copyFailed"));
        }
      }}
    >
      <CopyIcon aria-hidden="true" />
      {t("copy")}
    </Button>
  );
}

function TickBox({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="font-normal text-xs">
        {checked && <CheckIcon className="size-3" aria-hidden="true" />}
        {label}
      </Label>
    </span>
  );
}

/**
 * TAX-021 „Übermittlung erfassen“: Übermittelt am, Transferticket (Pflicht), Protokoll-PDF, cross-check value
 * („Kz 83 laut ELSTER“ / Σ ZM / Kz 38) and „abweichend übermittelt“ with reason; explains the irreversible lock.
 */
export function SubmissionDialog({
  form,
  period,
  sheetHash,
  crossCheckLabel,
  expectedCents,
  locks,
  reconciliation = [],
  onClose,
}: {
  form: "ustva" | "zm" | "sondervorauszahlung" | "euer";
  period: string;
  sheetHash: string;
  crossCheckLabel: string;
  expectedCents: number;
  locks: boolean;
  /** ZM (TAX-010, E-UVA-13): differences to the UStVA Kz 41/21 — recording needs a reason. */
  reconciliation?: readonly string[];
  onClose: () => void;
}) {
  const t = useTranslations("tax.submission");
  const record = useMutation(api.taxes.recordFilingSubmission);
  const uploadUrl = useMutation(api.taxes.protocolUploadUrl);
  const showError = useAdapterErrorToast();
  const base = useId();
  const [date, setDate] = useState(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }));
  const [ticket, setTicket] = useState("");
  const [cross, setCross] = useState((expectedCents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2 }));
  const [reason, setReason] = useState("");
  const [reconReason, setReconReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = parseCents(cross.replace(/^−/, "-"));
  const differs = parsed.ok && Number(parsed.value) !== expectedCents;
  const submit = async () => {
    if (!parsed.ok) {
      toast.error(t("invalidAmount"));
      return;
    }
    setBusy(true);
    try {
      let protocolStorageId: Id<"_storage"> | undefined;
      if (file) {
        const url = await uploadUrl({});
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": file.type }, body: file });
        if (!res.ok) throw new Error(t("uploadFailed"));
        protocolStorageId = ((await res.json()) as { storageId: Id<"_storage"> }).storageId;
      }
      await record({
        form,
        period,
        submittedOn: date,
        transferTicket: ticket.trim(),
        crossCheckCents: Number(parsed.value),
        sheetHash,
        ...(protocolStorageId ? { protocolStorageId } : {}),
        ...(differs && reason.trim() ? { valuesDifferReason: reason.trim() } : {}),
        ...(reconciliation.length > 0 && reconReason.trim()
          ? { reconciliationOverrideReason: reconReason.trim() }
          : {}),
      });
      toast.success(t("done"));
      onClose();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{locks ? t("locks") : t("noLock")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-date`}>{t("date")}</Label>
            <Input id={`${base}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-ticket`}>{t("ticket")}</Label>
            <Input
              id={`${base}-ticket`}
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-file`}>{t("protocol")}</Label>
            <Input
              id={`${base}-file`}
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${base}-cross`}>{crossCheckLabel}</Label>
            <Input id={`${base}-cross`} inputMode="decimal" value={cross} onChange={(e) => setCross(e.target.value)} />
            <p className="text-muted-foreground text-xs">{t("expected", { amount: euro(expectedCents) })}</p>
          </div>
          {differs && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${base}-reason`}>{t("differs")}</Label>
              <Textarea id={`${base}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
          {reconciliation.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <ul className="list-disc pl-5 text-sm" role="alert">
                {reconciliation.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <Label htmlFor={`${base}-recon`}>{t("reconciliationReason")}</Label>
              <Textarea id={`${base}-recon`} value={reconReason} onChange={(e) => setReconReason(e.target.value)} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button className="h-11 md:h-9" disabled={busy || !ticket.trim()} onClick={submit}>
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
