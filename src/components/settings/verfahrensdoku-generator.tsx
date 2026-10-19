"use client";

import { api } from "@convex/_generated/api";
import { useAction, useConvex, useMutation } from "convex/react";
import { DownloadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ChapterStatus } from "@/domain/docs/verfahrensdoku";
import { useAuthedQuery } from "@/hooks/use-authed-query";

const dateTimeDe = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

const STATUS_CLASS: Record<ChapterStatus, string> = {
  automatisch: "",
  vollständig: "border-success/60 text-success",
  "Angaben fehlen": "border-warning/60 text-warning",
};

/**
 * F12 AUD-024/025 `/einstellungen/verfahrensdokumentation`: chapters (§4.6) with status, live auto-filled text and
 * the owner's structured inputs; „Freigeben“ (owner) stores an immutable version (Markdown + SHA-256 in P1);
 * a changed watch item marks the current version „Aktualisierung erforderlich“ with the diff (E-AUD-41).
 */
export function VerfahrensdokuGenerator({ publicEdge }: { publicEdge: boolean }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <Generator publicEdge={publicEdge} />
    </ConvexGuard>
  );
}

function Generator({ publicEdge }: { publicEdge: boolean }) {
  const t = useTranslations("verfahrensdoku");
  const data = useAuthedQuery(api.verfahrensdoku.view, { publicEdge });
  const save = useMutation(api.verfahrensdoku.saveInputs);
  const release = useAction(api.verfahrensdoku.release);
  const convex = useConvex();
  const isOwner = useCan("settings.ownerOnly");
  const run = useRun();
  const formId = useId();
  const [values, setValues] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (data && values === null) {
      setValues(
        Object.fromEntries(data.doc.chapters.flatMap((c) => c.fields.map((f) => [f.key, f.value || f.template || ""]))),
      );
    }
  }, [data, values]);
  if (!data || !values) return <div className="h-96" aria-busy="true" />;
  const download = async (version: number) => {
    const r = await run(() => convex.query(api.verfahrensdoku.versionUrl, { version }));
    if (r.ok && r.value.url) window.open(r.value.url, "_blank", "noopener");
  };

  return (
    <div className="flex flex-col gap-6">
      {data.outdated && (
        <div role="alert" className="rounded-lg border border-warning/60 bg-warning/10 p-3 text-sm">
          <p className="font-medium">{data.outdated.message}</p>
          <ul className="mt-1 list-disc pl-5">
            {data.outdated.diff.map((d) => (
              <li key={d.key}>{t("diffLine", { label: d.label, before: d.before || "—", after: d.after || "—" })}</li>
            ))}
          </ul>
        </div>
      )}
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => save({ values }), t("saved"));
        }}
      >
        {data.doc.chapters.map((c) => (
          <section
            key={String(c.n)}
            className="flex flex-col gap-2 rounded-lg border p-4"
            aria-labelledby={`vd-${c.n}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id={`vd-${c.n}`} className="font-semibold">
                {c.n === "Anhang" ? c.title : `${c.n}. ${c.title}`}
              </h2>
              <Badge variant="outline" className={STATUS_CLASS[c.status]}>
                {c.status}
              </Badge>
            </div>
            {c.auto.map((p) => (
              <p key={p} className="text-muted-foreground text-sm">
                {p}
              </p>
            ))}
            {c.fields.map((f) => (
              <div key={f.key} className="flex flex-col gap-1.5">
                <label htmlFor={`${formId}-${f.key}`} className="font-medium text-sm">
                  {f.label}
                  {f.required ? " *" : ` (${t("optional")})`}
                </label>
                <Textarea
                  id={`${formId}-${f.key}`}
                  rows={3}
                  value={values[f.key] ?? ""}
                  readOnly={!isOwner}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              </div>
            ))}
          </section>
        ))}
      </form>
      {isOwner && (
        <div className="flex flex-col gap-2">
          {data.releaseIssue && (
            <p role="status" className="text-sm text-warning">
              {data.releaseIssue}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" form={formId} variant="outline" className="h-11 md:h-9">
              {t("save")}
            </Button>
            <Button
              className="h-11 md:h-9"
              disabled={data.releaseIssue !== null}
              onClick={() =>
                void run(
                  () => release({ publicEdge }),
                  t("released", { version: (data.versions[0]?.version ?? 0) + 1 }),
                )
              }
            >
              {t("release")}
            </Button>
          </div>
        </div>
      )}
      <section aria-labelledby="vd-versions" className="flex flex-col gap-2">
        <h2 id="vd-versions" className="font-semibold">
          {t("versions")}
        </h2>
        {data.versions.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noVersions")}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {data.versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <span className="flex-1">
                  {t("versionLine", {
                    version: v.version,
                    validFrom: v.validFrom.split("-").reverse().join("."),
                    at: dateTimeDe.format(v.releasedAt),
                  })}
                  <span className="block font-mono text-muted-foreground text-xs">
                    SHA-256 {v.sha256.slice(0, 16)}…
                  </span>
                </span>
                {v.supersededAt !== null ? (
                  <Badge variant="outline">{t("superseded")}</Badge>
                ) : (
                  <Badge variant="outline" className={data.outdated ? STATUS_CLASS["Angaben fehlen"] : ""}>
                    {data.outdated ? t("needsUpdate") : t("current")}
                  </Badge>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 md:min-h-8"
                  onClick={() => void download(v.version)}
                >
                  <DownloadIcon aria-hidden="true" />
                  {t("download", { version: v.version })}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
