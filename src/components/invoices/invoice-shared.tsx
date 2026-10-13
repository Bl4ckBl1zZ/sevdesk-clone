"use client";

import { CircleAlertIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import type { DisplayStatus } from "@/domain/documents/display-status";
import { formatCents } from "@/domain/money/format";
import { cn } from "@/lib/utils";
import { sha256Sums, zipStore } from "@/lib/zip";

/** Shared pieces of the invoice screens (F04 §6): status badge, compliance panel, totals and file downloads. */

export const money = (cents: number | null | undefined, currency = "EUR"): string =>
  cents === null || cents === undefined ? "—" : `${formatCents(cents)} ${currency === "EUR" ? "€" : currency}`;

export const FORMAT_LABELS: Record<string, string> = {
  zugferd_en16931: "ZUGFeRD (EN 16931)",
  zugferd_xrechnung: "ZUGFeRD (XRechnung-Profil)",
  xrechnung_cii: "XRechnung (CII)",
  xrechnung_ubl: "XRechnung (UBL)",
  none: "Nur PDF",
};

/** ER-03 decisions (F04 App. D) in plain German. */
export const DECISION_LABELS: Record<string, string> = {
  MUST_E: "E-Rechnung Pflicht",
  MAY_PAPER_OR_PDF: "Papier oder PDF zulässig",
  PDF_NEEDS_CONSENT: "PDF nur mit Zustimmung des Kunden",
  NOT_REQUIRED: "Keine E-Rechnungspflicht",
};

const TONES: Partial<Record<DisplayStatus, string>> = {
  draft: "border-border bg-muted text-foreground",
  unsent: "border-warning bg-transparent text-warning",
  open: "border-info/30 bg-info/10 text-info",
  partially_paid: "border-warning bg-transparent text-warning",
  overdue: "border-danger/30 bg-danger/10 text-danger",
  paid: "border-success/30 bg-success/10 text-success",
  blocked: "border-danger/30 bg-danger/10 text-danger",
  cancelled: "border-border bg-muted text-foreground line-through",
};

/** Display status from the domain `displayStatus()` (label included); this only renders it. */
export function InvoiceStatusBadge({ token, label }: { token: DisplayStatus; label: string }) {
  return (
    <span
      data-status={token}
      className={cn(
        "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full border px-2 font-medium text-xs",
        TONES[token] ?? "border-border bg-muted text-foreground",
      )}
    >
      {token === "overdue" && <CircleAlertIcon className="size-3.5" aria-hidden="true" />}
      {label}
    </span>
  );
}

export interface FindingView {
  code: string;
  severity: "E" | "W" | "I";
  message: string;
  rule: string;
  group: string;
  field?: string;
}

const GROUP_ORDER = ["pflichtangaben", "steuern", "e_rechnung", "hinweise"] as const;

/** Compliance panel (DOC-20, §6.4): errors block finalisation, warnings and notes inform; each shows its rule ID. */
export function CompliancePanel({ findings }: { findings: readonly FindingView[] }) {
  const t = useTranslations("invoices.compliance");
  const headingId = useId();
  const errors = findings.filter((f) => f.severity === "E").length;
  const warnings = findings.filter((f) => f.severity === "W").length;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border p-4" data-testid="compliance">
      <h2 id={headingId} className="font-semibold text-base">
        {t("title")}
      </h2>
      <p role="status" className={cn("text-sm", errors > 0 ? "text-danger" : "text-success")}>
        {errors > 0 ? t("errors", { count: errors }) : t("ok")}
        {warnings > 0 ? ` · ${t("warnings", { count: warnings })}` : ""}
      </p>
      {GROUP_ORDER.map((g) => {
        const items = findings.filter((f) => f.group === g);
        if (items.length === 0) return null;
        return (
          <div key={g} className="flex flex-col gap-1.5">
            <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{t(`groups.${g}`)}</h3>
            <ul className="flex flex-col gap-1.5">
              {items.map((f) => (
                <li
                  key={`${f.code}-${f.field ?? ""}-${f.message}`}
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
                    <span className="ml-1 text-muted-foreground text-xs tabular-nums">({f.rule})</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

export interface TotalsView {
  netCents: number;
  vatCents: number;
  grossCents: number;
  payableCents: number;
  groups: readonly { category: string; rateBp: number; baseCents: number; vatCents: number }[];
}

export function TotalsPanel({ totals, currency }: { totals: TotalsView | null; currency: string }) {
  const t = useTranslations("invoices.totals");
  if (!totals) return <p className="text-muted-foreground text-sm">{t("none")}</p>;
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm" data-testid="totals">
      <dt className="text-muted-foreground">{t("net")}</dt>
      <dd className="text-right tabular-nums">{money(totals.netCents, currency)}</dd>
      {totals.groups.map((g) => (
        <div key={`${g.category}-${g.rateBp}`} className="contents">
          <dt className="text-muted-foreground">
            {g.category === "S" || g.category === "Z"
              ? t("vat", { rate: (g.rateBp / 100).toLocaleString("de-DE") })
              : t(`category.${g.category as "E" | "AE" | "K" | "G" | "O" | "KU"}`)}
          </dt>
          <dd className="text-right tabular-nums">{money(g.vatCents, currency)}</dd>
        </div>
      ))}
      <dt className="font-semibold">{t("gross")}</dt>
      <dd className="text-right font-semibold tabular-nums" data-testid="gross">
        {money(totals.grossCents, currency)}
      </dd>
      {totals.payableCents !== totals.grossCents && (
        <>
          <dt className="text-muted-foreground">{t("payable")}</dt>
          <dd className="text-right tabular-nums">{money(totals.payableCents, currency)}</dd>
        </>
      )}
    </dl>
  );
}

export interface ExportedFileView {
  name: string;
  url: string;
  sha256: string;
  mime: string;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Downloads the archived files (SND-16); „Alles als ZIP“ adds SHA256SUMS.txt (§4.10.2). */
export async function downloadExport(files: readonly ExportedFileView[], zipName: string | null): Promise<void> {
  const blobs = await Promise.all(
    files.map(async (f) => {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    }),
  );
  if (zipName) {
    const entries = files.map((f, i) => ({ name: f.name, data: blobs[i] as Uint8Array }));
    entries.push({ name: "SHA256SUMS.txt", data: new TextEncoder().encode(sha256Sums(files)) });
    const zip = zipStore(entries);
    saveBlob(new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }), zipName);
    return;
  }
  files.forEach((f, i) => {
    saveBlob(new Blob([blobs[i] as Uint8Array<ArrayBuffer>], { type: f.mime }), f.name);
  });
}
