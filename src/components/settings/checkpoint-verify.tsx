"use client";

import { api } from "@convex/_generated/api";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CheckCircle2Icon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Result = FunctionReturnType<typeof api.integrity.verifyCheckpointFile>;

/**
 * F12 AUD-017 „Prüfpunkt verifizieren“ on the integrity page: the owner (or an auditor) uploads a checkpoint file
 * (`checkpoints/YYYY/MM/DD.jws` from the R2 bucket or the e-mail copy); Convex checks the signature with the
 * configured public keys and that the current audit chain contains its lastSeq/lastHash. Nothing is stored.
 */
export function CheckpointVerify() {
  const t = useTranslations("integrity.verify");
  const verify = useAction(api.integrity.verifyCheckpointFile);
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    setResult(null);
    setError(null);
    if (!file) return;
    if (file.size > 64_000) {
      setError(t("tooLarge"));
      return;
    }
    setBusy(true);
    try {
      setResult(await verify({ jws: await file.text() }));
    } catch {
      setError(t("failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 flex flex-col gap-3 border-t pt-4" aria-labelledby={`${inputId}-title`}>
      <h3 id={`${inputId}-title`} className="font-medium text-sm">
        {t("title")}
      </h3>
      <p className="text-muted-foreground text-sm">{t("description")}</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={inputId}>{t("file")}</Label>
        <Input
          id={inputId}
          type="file"
          accept=".jws,application/jose,text/plain"
          className="h-11 md:h-9"
          disabled={busy}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>
      {busy && (
        <p className="text-sm" aria-live="polite">
          {t("busy")}
        </p>
      )}
      {error && (
        <p className="text-danger text-sm" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div
          role={result.ok ? "status" : "alert"}
          className={`flex flex-col gap-2 rounded-md p-3 text-sm ${result.ok ? "bg-muted" : "bg-danger/10 text-danger"}`}
        >
          <p className="flex items-center gap-2 font-medium">
            {result.ok ? (
              <CheckCircle2Icon className="size-4" aria-hidden="true" />
            ) : (
              <TriangleAlertIcon className="size-4" aria-hidden="true" />
            )}
            {result.message}
          </p>
          {result.date && result.lastSeq !== null && (
            <p>{t("summary", { date: result.date.split("-").reverse().join("."), seq: result.lastSeq })}</p>
          )}
          <ul className="flex flex-col gap-1" aria-label={t("checks")}>
            {result.checks.map((c) => (
              <li key={c.id}>
                {c.status === "ok" ? t("ok") : t("error")}: {c.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
