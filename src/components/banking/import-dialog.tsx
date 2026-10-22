"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { formatDate, selectClass, useRun } from "@/components/catalog/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { STATEMENT_FORMAT_LABEL } from "@/domain/banking/types";
import { Amount, money, uploadFile } from "./shared";

type Preview = FunctionReturnType<typeof api.banking.previewImport>;
type Account = { id: Id<"bankAccounts">; name: string; currency: string };

const OUTCOME_VARIANT = {
  new: "default",
  duplicate: "secondary",
  merge: "secondary",
  conflict: "destructive",
  possible_duplicate: "outline",
} as const;

/**
 * „Kontoauszug importieren“ (F07 BNK-030…035): account, statement file (CAMT.053 / MT940 / Revolut CSV) and the
 * signed PDF → preview (dry run: neu / Dublette / Konflikt / mögliche Dublette, balance checks, continuity) →
 * import. Parsing and rules run on the server; the dialog only uploads and shows the result.
 */
export function ImportDialog({ accounts, onClose }: { accounts: Account[]; onClose: () => void }) {
  const t = useTranslations("banking.import");
  const run = useRun();
  const uploadUrl = useMutation(api.banking.generateUploadUrl);
  const preview = useAction(api.banking.previewImport);
  const commit = useAction(api.banking.commitImport);
  const accountFieldId = useId();
  const fileFieldId = useId();
  const pdfFieldId = useId();
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [pdf, setPdf] = useState<File | null>(null);
  const [storageId, setStorageId] = useState<Id<"_storage"> | null>(null);
  const [result, setResult] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const account = accounts.find((a) => a.id === accountId);

  const runPreview = async () => {
    if (!file || !accountId) return;
    setBusy(true);
    const r = await run(async () => {
      const id = await uploadFile(await uploadUrl({}), file);
      setStorageId(id);
      return preview({ accountId: accountId as Id<"bankAccounts">, storageId: id, fileName: file.name });
    });
    setBusy(false);
    if (r.ok) setResult(r.value);
  };

  const runCommit = async () => {
    if (!file || !storageId || !result) return;
    setBusy(true);
    const r = await run(async () => {
      const pdfStorageId = pdf ? await uploadFile(await uploadUrl({}), pdf) : undefined;
      return commit({
        accountId: accountId as Id<"bankAccounts">,
        storageId,
        fileName: file.name,
        ...(pdfStorageId ? { pdfStorageId, pdfName: pdf?.name } : {}),
        ...(result.alreadyImported ? { force: true } : {}),
      });
    });
    setBusy(false);
    if (r.ok) {
      toast.success(t("done", { count: r.value.counts.new }));
      if (r.value.message) toast.warning(r.value.message);
      onClose();
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {!result ? (
          <div className="@container/form flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={accountFieldId} className="font-medium text-sm">
                {t("account")}
              </label>
              <select
                id={accountFieldId}
                className={selectClass}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.currency})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={fileFieldId} className="font-medium text-sm">
                {t("file")}
              </label>
              <input
                id={fileFieldId}
                type="file"
                accept=".xml,.csv,.txt,.sta,.mt940"
                className="text-sm file:mr-3 file:h-9 file:rounded-md file:border file:bg-background file:px-3"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-muted-foreground text-sm">{t("fileHint")}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={pdfFieldId} className="font-medium text-sm">
                {t("pdf")}
              </label>
              <input
                id={pdfFieldId}
                type="file"
                accept="application/pdf,.pdf"
                className="text-sm file:mr-3 file:h-9 file:rounded-md file:border file:bg-background file:px-3"
                onChange={(e) => setPdf(e.target.files?.[0] ?? null)}
              />
              <p className="text-muted-foreground text-sm">{t("pdfHint")}</p>
            </div>
          </div>
        ) : (
          <PreviewView preview={result} currency={account?.currency ?? "EUR"} />
        )}
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={result ? () => setResult(null) : onClose}>
            {result ? t("back") : t("cancel")}
          </Button>
          {!result ? (
            <Button className="h-11 md:h-9" disabled={!file || !accountId || busy} onClick={() => void runPreview()}>
              {t("preview")}
            </Button>
          ) : (
            <Button className="h-11 md:h-9" disabled={busy} onClick={() => void runCommit()}>
              {result.alreadyImported ? t("importAgain") : t("commit", { count: result.counts.new })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewView({ preview: p, currency }: { preview: Preview; currency: string }) {
  const t = useTranslations("banking.import");
  const checks: { ok: boolean; text: string }[] = [
    {
      ok: p.arithmetic.status === "ok",
      text: p.arithmetic.status === "ok" ? t("arithmeticOk") : (p.arithmetic.message ?? t("arithmeticUnverifiable")),
    },
    {
      ok: p.continuity.status === "ok" || p.continuity.status === "first",
      text:
        p.continuity.status === "ok"
          ? t("continuityOk")
          : p.continuity.status === "first"
            ? t("continuityFirst")
            : "message" in p.continuity
              ? (p.continuity.message as string)
              : t("continuityUnverifiable"),
    },
    ...p.runningBalanceBreaks.map((b) => ({ ok: false, text: b.message })),
    // EC-BNK-51: rows of a locked month are imported, their bookings go to the first open month.
    ...(p.lockedPeriods ?? []).map((n) => ({ ok: false, text: n.message })),
  ];
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm @lg/form:grid-cols-4">
        <dt className="text-muted-foreground">{t("format")}</dt>
        <dd>{STATEMENT_FORMAT_LABEL[p.format]}</dd>
        <dt className="text-muted-foreground">{t("period")}</dt>
        <dd>
          {formatDate(p.periodFrom)} – {formatDate(p.periodTo)}
        </dd>
        <dt className="text-muted-foreground">{t("opening")}</dt>
        <dd className="tabular-nums">{money(p.openingBalanceCents, currency)}</dd>
        <dt className="text-muted-foreground">{t("closing")}</dt>
        <dd className="tabular-nums">{money(p.closingBalanceCents, currency)}</dd>
      </dl>
      {p.alreadyImported && (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          {p.alreadyImported.message} {t("alreadyHint")}
        </p>
      )}
      <ul aria-label={t("counts")} className="flex flex-wrap gap-2 text-sm" data-testid="import-counts">
        <li>
          <Badge>{t("countNew", { count: p.counts.new })}</Badge>
        </li>
        <li>
          <Badge variant="secondary">{t("countDuplicates", { count: p.counts.duplicates + p.counts.merged })}</Badge>
        </li>
        {p.counts.conflicts > 0 && (
          <li>
            <Badge variant="destructive">{t("countConflicts", { count: p.counts.conflicts })}</Badge>
          </li>
        )}
        {p.counts.possibleDuplicates > 0 && (
          <li>
            <Badge variant="outline">{t("countPossible", { count: p.counts.possibleDuplicates })}</Badge>
          </li>
        )}
        {p.counts.skipped > 0 && (
          <li>
            <Badge variant="outline">{t("countSkipped", { count: p.counts.skipped })}</Badge>
          </li>
        )}
      </ul>
      <ul aria-label={t("checks")} className="flex flex-col gap-1 text-sm">
        {checks.map((c) => (
          <li key={c.text} className={c.ok ? "text-success" : "text-warning"}>
            {c.ok ? "✓ " : "⚠ "}
            {c.text}
          </li>
        ))}
      </ul>
      {p.issues.length > 0 && (
        <ul className="flex flex-col gap-1 text-danger text-sm">
          {p.issues.map((i) => (
            <li key={`${i.line}-${i.message}`}>{t("issue", { line: i.line, message: i.message })}</li>
          ))}
        </ul>
      )}
      {/* A list, not a table: no nested horizontal scroll area in the dialog on phones (axe scrollable-region-focusable). */}
      <ul aria-label={t("rows")} className="flex flex-col divide-y rounded-md border">
        {p.rows.map((r) => (
          <li key={r.line} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span className="whitespace-nowrap tabular-nums">{formatDate(r.bookingDate)}</span>
            <span className="min-w-0 flex-1 truncate">{r.counterpartyName ?? r.purpose}</span>
            <Amount cents={r.amountCents} currency={r.currency} />
            <Badge variant={OUTCOME_VARIANT[r.outcome]}>{t(`outcome.${r.outcome}`)}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
