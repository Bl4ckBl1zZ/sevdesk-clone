"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { IMPORT_ROW_STATUS_LABELS, type ImportRowStatus } from "@/domain/contacts/csv-io";
import { readCsv } from "@/domain/csv/csv";

export type ImportMode = "create_only" | "create_and_update";
export interface ImportRow {
  rowNumber: number;
  cells: string[];
}
export interface PreviewResult {
  rowNumber: number;
  status: ImportRowStatus;
  message: string | null;
}
export interface CommitResult {
  rowNumber: number;
  status: "created" | "updated" | "skipped" | "error";
  message?: string;
}

const BATCH = 100;

/**
 * CSV import wizard (CON-140…142, PRD-080): file → column mapping (auto-detected) → dry-run preview → commit in
 * batches of 100 rows. Parsing and mapping rules live in src/domain; the server validates every row again.
 */
export function ImportWizard<F extends string>({
  namespace,
  fields,
  fieldLabels,
  autoMap,
  checkMapping,
  preview,
  commit,
}: {
  namespace: "contacts.import" | "products.import";
  fields: readonly F[];
  fieldLabels: Readonly<Record<F, string>>;
  autoMap: (headers: readonly string[]) => (F | null)[];
  checkMapping?: (mapping: readonly (F | null)[]) => string | null;
  preview: (rows: ImportRow[], mapping: (F | null)[], mode: ImportMode) => Promise<PreviewResult[]>;
  commit: (rows: ImportRow[], mapping: (F | null)[], mode: ImportMode) => Promise<CommitResult[]>;
}) {
  const t = useTranslations(namespace);
  const run = useRun();
  const fileId = useId();
  const [step, setStep] = useState<"file" | "mapping" | "preview" | "result">("file");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [mapping, setMapping] = useState<(F | null)[]>([]);
  const [mode, setMode] = useState<ImportMode>("create_only");
  const [fileError, setFileError] = useState<string | null>(null);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [previewRows, setPreviewRows] = useState<PreviewResult[]>([]);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [results, setResults] = useState<CommitResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  const onFile = async (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    const table = readCsv(new Uint8Array(await file.arrayBuffer()));
    if (!table.ok) {
      setFileError(table.error.message);
      return;
    }
    setHeaders(table.value.headers);
    setRows(
      table.value.rows
        .map((cells, i) => ({ rowNumber: i + 2, cells }))
        .filter((r) => r.cells.some((c) => c.trim() !== "")),
    );
    setMapping(autoMap(table.value.headers));
    setStep("mapping");
  };

  const runPreview = async () => {
    const problem = checkMapping?.(mapping) ?? null;
    setMappingError(problem);
    if (problem) return;
    setBusy(true);
    const r = await run(async () => {
      const out: PreviewResult[] = [];
      for (let i = 0; i < rows.length; i += BATCH)
        out.push(...(await preview(rows.slice(i, i + BATCH), mapping, mode)));
      return out;
    });
    setBusy(false);
    if (r.ok) {
      setPreviewRows(r.value);
      setStep("preview");
    }
  };

  const runCommit = async () => {
    setBusy(true);
    setProgress(0);
    const out: CommitResult[] = [];
    const r = await run(async () => {
      for (let i = 0; i < rows.length; i += BATCH) {
        out.push(...(await commit(rows.slice(i, i + BATCH), mapping, mode)));
        setProgress(Math.min(rows.length, i + BATCH));
      }
      return out;
    });
    setBusy(false);
    setResults(out);
    if (r.ok || out.length > 0) setStep("result");
  };

  const reset = () => {
    setStep("file");
    setHeaders([]);
    setRows([]);
    setPreviewRows([]);
    setResults([]);
  };

  const count = (s: CommitResult["status"]) => results.filter((x) => x.status === s).length;
  const steps = ["file", "mapping", "preview", "result"] as const;

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-wrap gap-2 text-sm" aria-label={t("steps.file")}>
        {steps.map((s, i) => (
          <li
            key={s}
            aria-current={s === step ? "step" : undefined}
            className={
              s === step
                ? "rounded-full bg-primary px-3 py-1 text-primary-foreground"
                : "rounded-full border px-3 py-1 text-muted-foreground"
            }
          >
            {i + 1}. {t(`steps.${s}`)}
          </li>
        ))}
      </ol>

      {step === "file" && (
        <div className="flex max-w-xl flex-col gap-1.5">
          <label htmlFor={fileId} className="font-medium text-sm">
            {t("file")}
          </label>
          <Input
            id={fileId}
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-describedby={`${fileId}-hint${fileError ? ` ${fileId}-e` : ""}`}
            aria-invalid={fileError ? true : undefined}
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <p id={`${fileId}-hint`} className="text-muted-foreground text-sm">
            {t("fileHint")}
          </p>
          {fileError && (
            <p id={`${fileId}-e`} role="alert" className="text-danger text-sm">
              {fileError}
            </p>
          )}
        </div>
      )}

      {step === "mapping" && (
        <section aria-labelledby={`${fileId}-map`} className="flex flex-col gap-3">
          <h2 id={`${fileId}-map`} className="font-semibold text-base">
            {t("mapping")}
          </h2>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("column")}</TableHead>
                  <TableHead>{t("sample")}</TableHead>
                  <TableHead>{t("field")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {headers.map((h, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: CSV columns are positional; the index is their identity.
                  <TableRow key={i}>
                    <TableCell className="font-medium">{h || `#${i + 1}`}</TableCell>
                    <TableCell className="max-w-48 truncate text-muted-foreground">{rows[0]?.cells[i] ?? ""}</TableCell>
                    <TableCell>
                      <select
                        aria-label={`${t("field")}: ${h || `#${i + 1}`}`}
                        className="h-11 w-full min-w-40 rounded-md border border-input bg-background px-2 text-base md:h-9 md:text-sm dark:bg-input/30"
                        value={mapping[i] ?? ""}
                        onChange={(e) => {
                          const next = [...mapping];
                          next[i] = (e.target.value || null) as F | null;
                          setMapping(next);
                        }}
                      >
                        <option value="">{t("ignore")}</option>
                        {fields.map((f) => (
                          <option key={f} value={f}>
                            {fieldLabels[f]}
                          </option>
                        ))}
                      </select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-medium text-sm">{t("mode")}</legend>
            {(["create_only", "create_and_update"] as const).map((m) => (
              <label key={m} className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
                <input
                  type="radio"
                  name={`${fileId}-mode`}
                  className="size-5 accent-primary md:size-4"
                  checked={mode === m}
                  onChange={() => setMode(m)}
                />
                {t(`modes.${m}`)}
              </label>
            ))}
          </fieldset>
          {mappingError && (
            <p role="alert" className="text-danger text-sm">
              {mappingError}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="outline" className="h-11 md:h-9" onClick={reset}>
              {t("again")}
            </Button>
            <Button className="h-11 md:h-9" disabled={busy} onClick={() => void runPreview()}>
              {t("preview")}
            </Button>
          </div>
        </section>
      )}

      {step === "preview" && (
        <section aria-label={t("steps.preview")} className="flex flex-col gap-3">
          <p className="text-sm">
            {(["new", "update", "conflict", "error"] as const)
              .map((s) => `${IMPORT_ROW_STATUS_LABELS[s]}: ${previewRows.filter((r) => r.status === s).length}`)
              .join(" · ")}
          </p>
          <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
            <input
              type="checkbox"
              className="size-5 accent-primary md:size-4"
              checked={onlyErrors}
              onChange={(e) => setOnlyErrors(e.target.checked)}
            />
            {t("onlyErrors")}
          </label>
          <ResultTable
            t={t}
            rows={previewRows
              .filter((r) => !onlyErrors || r.status === "error" || r.status === "conflict")
              .map((r) => ({
                rowNumber: r.rowNumber,
                status: IMPORT_ROW_STATUS_LABELS[r.status],
                message: r.message ?? "",
              }))}
          />
          <div className="flex gap-2">
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setStep("mapping")}>
              {t("mapping")}
            </Button>
            <Button
              className="h-11 md:h-9"
              disabled={busy || previewRows.every((r) => r.status === "error")}
              onClick={() => void runCommit()}
            >
              {busy ? `${t("running")} ${progress}/${rows.length}` : t("run")}
            </Button>
          </div>
        </section>
      )}

      {step === "result" && (
        <section aria-label={t("steps.result")} className="flex flex-col gap-3">
          <p role="status" className="font-medium text-sm">
            {t("done", {
              created: count("created"),
              updated: count("updated"),
              skipped: count("skipped"),
              errors: count("error"),
            })}
          </p>
          <ResultTable
            t={t}
            rows={results
              .filter((r) => r.status === "error" || r.status === "skipped")
              .map((r) => ({
                rowNumber: r.rowNumber,
                status: t(`resultStatus.${r.status}`),
                message: r.message ?? "",
              }))}
          />
          <div>
            <Button variant="outline" className="h-11 md:h-9" onClick={reset}>
              {t("again")}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

function ResultTable({
  t,
  rows,
}: {
  t: (key: "row" | "status" | "message") => string;
  rows: { rowNumber: number; status: string; message: string }[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="max-h-[50dvh] overflow-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("row")}</TableHead>
            <TableHead>{t("status")}</TableHead>
            <TableHead>{t("message")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.rowNumber}>
              <TableCell className="tabular-nums">{r.rowNumber}</TableCell>
              <TableCell>{r.status}</TableCell>
              <TableCell className="whitespace-normal">{r.message}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
