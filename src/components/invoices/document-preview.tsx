"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";

/** Response of `GET /dokumente/{id}/ansicht` (src/server/documents/view-pages.ts). */
type Pages =
  | { state: "pages"; pageCount: number; pages: string[] }
  | { state: "unavailable"; reason: "pending" | "blocked" | "missing" | "invalid" | "none"; errors?: string[] };

type Load = { status: "loading" } | { status: "failed" } | { status: "done"; value: Pages };

/** Page images are rendered at 2 × A4 (595 × 842 pt); the attributes reserve the space before they load. */
const PAGE_WIDTH = 1190;
const PAGE_HEIGHT = 1684;

/**
 * „Vorschau“ on the Beleg page (F04 §6.4, DOC-62), shown above „Verlauf“: the pages of the archived original, or the
 * „ENTWURF“ render of the stored draft. `refreshKey` changes when the draft is saved (version) or the files become
 * ready; the previous pages stay visible while the new ones load.
 */
export function DocumentPreview({ id, refreshKey, draft }: { id: string; refreshKey: string; draft: boolean }) {
  const t = useTranslations("invoices.preview");
  const headingId = useId();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [shown, setShown] = useState<Pages | null>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and attempt are the re-fetch triggers.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoad({ status: "loading" });
    fetch(`/dokumente/${id}/ansicht`, { cache: "no-store", signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const value = (await res.json()) as Pages;
        setLoad({ status: "done", value });
        setShown(value);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setLoad({ status: "failed" });
      });
    return () => ctrl.abort();
  }, [id, refreshKey, attempt]);

  const refreshing = load.status === "loading" && shown !== null;
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border p-4"
      aria-labelledby={headingId}
      aria-busy={load.status === "loading"}
      data-testid="document-preview"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="font-semibold text-base">
          {t("title")}
        </h2>
        <p className="text-muted-foreground text-xs">
          {refreshing ? <span role="status">{t("refreshing")}</span> : draft ? t("draft") : t("original")}
        </p>
      </div>
      {load.status === "failed" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
          <span>{t("failed")}</span>
          <Button variant="outline" className="h-11 md:h-9" onClick={() => setAttempt((n) => n + 1)}>
            {t("retry")}
          </Button>
        </div>
      ) : shown === null ? (
        <div className="mx-auto flex aspect-[210/297] w-full max-w-3xl items-center justify-center rounded-md border bg-muted/40 text-muted-foreground text-sm">
          {t("loading")}
        </div>
      ) : shown.state === "unavailable" ? (
        <Unavailable value={shown} />
      ) : (
        <div className={refreshing ? "opacity-70 transition-opacity" : "transition-opacity"}>
          <ol className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            {shown.pages.map((src, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: pages have no identity besides their position.
              <li key={i}>
                {/* biome-ignore lint/performance/noImgElement: data URLs rendered on the server, next/image adds nothing. */}
                <img
                  src={src}
                  alt={t("page", { page: i + 1, count: shown.pageCount })}
                  width={PAGE_WIDTH}
                  height={PAGE_HEIGHT}
                  className="h-auto w-full rounded-md border bg-white shadow-sm"
                />
              </li>
            ))}
          </ol>
          {shown.pageCount > shown.pages.length && (
            <p className="mt-2 text-center text-muted-foreground text-xs">
              {t("more", { shown: shown.pages.length, count: shown.pageCount })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Unavailable({ value }: { value: Extract<Pages, { state: "unavailable" }> }) {
  const t = useTranslations("invoices.preview");
  return (
    <div role="status" className="rounded-lg border border-info/30 bg-info/5 p-3 text-sm">
      <p>{t(value.reason)}</p>
      {value.reason === "invalid" && (value.errors?.length ?? 0) > 0 && (
        <ul className="mt-2 list-disc pl-5">
          {value.errors?.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
