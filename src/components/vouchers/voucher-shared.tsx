"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { uploadFile } from "@/components/banking/shared";
import { formatCents } from "@/domain/money/format";
import { cn } from "@/lib/utils";

/** Shared pieces of the „Ausgaben“ screens (F06 §6): status badge, upload, check panel and journal preview. */

export const money = (cents: number | null | undefined, currency = "EUR"): string =>
  cents === null || cents === undefined ? "—" : `${formatCents(cents)} ${currency === "EUR" ? "€" : currency}`;

const TONES: Record<string, string> = {
  draft: "border-border bg-muted text-foreground",
  open: "border-info/30 bg-info/10 text-info",
  scheduled: "border-info/30 bg-transparent text-info",
  partially_paid: "border-warning bg-transparent text-warning",
  overdue: "border-danger/30 bg-danger/10 text-danger",
  paid: "border-success/30 bg-success/10 text-success",
  cancelled: "border-border bg-muted text-foreground line-through",
};

export function VoucherStatusBadge({ status, label, overdue }: { status: string; label: string; overdue?: boolean }) {
  const t = useTranslations("vouchers.list");
  return (
    <span
      data-status={overdue ? "overdue" : status}
      className={cn(
        "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full border px-2 font-medium text-xs",
        TONES[overdue ? "overdue" : status] ?? TONES.draft,
      )}
    >
      {overdue && <CircleAlertIcon className="size-3.5" aria-hidden="true" />}
      {label}
      {overdue && <span className="sr-only"> ({t("overdue")})</span>}
    </span>
  );
}

/**
 * VOU-120 upload: the file goes to Convex storage unchanged; `attachFile` sniffs the MIME type, hashes it and creates
 * a draft (or adds the file to `voucherId`, optionally replacing file `replaceIndex` with a reason, VOU-122).
 */
export function useVoucherUpload() {
  const generateUploadUrl = useMutation(api.vouchers.generateUploadUrl);
  const attach = useAction(api.vouchers.attachFile);
  const setDirection = useMutation(api.vouchers.updateDraft);
  return async (
    file: File,
    opts: { voucherId?: Id<"vouchers">; replaceIndex?: number; reason?: string; direction?: "expense" | "income" } = {},
  ) => {
    const storageId = await uploadFile(await generateUploadUrl({}), file);
    const r = await attach({
      storageId,
      name: file.name,
      clientCapturedAt: file.lastModified || Date.now(),
      ...(opts.voucherId ? { voucherId: opts.voucherId } : {}),
      ...(opts.replaceIndex !== undefined ? { replaceIndex: opts.replaceIndex } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      via: "upload",
    });
    if (!opts.voucherId && opts.direction === "income") {
      await setDirection({ id: r.voucherId, input: { direction: "income" } });
    }
    return r;
  };
}

export interface CheckView {
  errors: readonly { code: string; message: string }[];
  warnings: readonly { code: string; message: string; acknowledge?: boolean }[];
  infos: readonly { code: string; message: string }[];
  inputVatAtRisk?: readonly string[];
}

/** VOU-006/007 check panel: errors block „Buchen“, ⚑ warnings need an acknowledgement, notes inform. */
export function VoucherCheckPanel({ check }: { check: CheckView | null }) {
  const t = useTranslations("vouchers.check");
  const headingId = useId();
  if (!check) {
    return (
      <p role="status" className="rounded-xl border p-4 text-muted-foreground text-sm">
        {t("unavailable")}
      </p>
    );
  }
  const rows = [
    ...check.errors.map((f) => ({ ...f, severity: "E" as const })),
    ...check.warnings.map((f) => ({ ...f, severity: "W" as const })),
    ...check.infos.map((f) => ({ ...f, severity: "I" as const })),
  ];
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border p-4"
      data-testid="voucher-check"
    >
      <h2 id={headingId} className="font-semibold text-base">
        {t("title")}
      </h2>
      <p role="status" className={cn("text-sm", check.errors.length > 0 ? "text-danger" : "text-success")}>
        {check.errors.length > 0 ? t("errors", { count: check.errors.length }) : t("ok")}
        {check.warnings.length > 0 ? ` · ${t("warnings", { count: check.warnings.length })}` : ""}
      </p>
      {rows.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {rows.map((f) => (
            <li
              key={`${f.severity}-${f.code}-${f.message}`}
              data-code={f.code}
              className={cn(
                "flex items-start gap-2 rounded-md border p-2 text-sm",
                f.severity === "E" && "border-danger/40 bg-danger/5",
                f.severity === "W" && "border-warning/40 bg-warning/5",
              )}
            >
              {f.severity === "E" ? (
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
              ) : f.severity === "W" ? (
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              ) : (
                <InfoIcon className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1">
                <span className="sr-only">{t(`severity.${f.severity}`)}: </span>
                {f.message}
                <span className="ml-1 text-muted-foreground text-xs">({f.code})</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {check.inputVatAtRisk && check.inputVatAtRisk.length > 0 && (
        <p className="text-sm text-warning">{t("inputVatAtRisk", { fields: check.inputVatAtRisk.join(", ") })}</p>
      )}
    </section>
  );
}

export interface JournalView {
  status: string;
  text?: string;
  message?: string;
  lines?: readonly { account: string; debitCents: number; creditCents: number }[];
}

/** Buchungssätze of the dry run (F08 posting rows): Soll/Haben per account. */
export function JournalPreview({ journal }: { journal: JournalView | null | undefined }) {
  const t = useTranslations("vouchers.book");
  if (!journal) return null;
  if (journal.status !== "lines" || !journal.lines) {
    return journal.message ? <p className="text-danger text-sm">{journal.message}</p> : null;
  }
  return (
    <div className="flex flex-col gap-1" data-testid="journal-preview">
      <p className="font-medium text-sm">{t("journal")}</p>
      {journal.text && <p className="text-muted-foreground text-xs">{journal.text}</p>}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground text-xs">
            <th className="font-normal">{t("account")}</th>
            <th className="text-right font-normal">{t("debit")}</th>
            <th className="text-right font-normal">{t("credit")}</th>
          </tr>
        </thead>
        <tbody>
          {journal.lines.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: posting rows have no id and never reorder
            <tr key={i}>
              <td className="tabular-nums">{l.account}</td>
              <td className="text-right tabular-nums">{l.debitCents ? formatCents(l.debitCents) : ""}</td>
              <td className="text-right tabular-nums">{l.creditCents ? formatCents(l.creditCents) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
