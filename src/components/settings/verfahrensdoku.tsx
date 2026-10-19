"use client";

import { api } from "@convex/_generated/api";
import { DownloadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { bankdaten } from "@/domain/docs/bankdaten";
import { ersetzendesScannen } from "@/domain/docs/ersetzendes-scannen";
import { type DocChapter, zugriffskonzept, zugriffskonzeptMarkdown } from "@/domain/docs/zugriffskonzept";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/** Verfahrensdokumentation, chapter „Zugriffskonzept“ (F01 SET-047), generated from the recorded settings. */
export function ZugriffskonzeptChapter() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <Chapter />
    </ConvexGuard>
  );
}

function Chapter() {
  const data = useAuthedQuery(api.system.zugriffskonzeptData, {});
  if (data === undefined) return <div className="h-96" aria-busy="true" />;
  return <DocChapterCard doc={zugriffskonzept(data)} fileName={`zugriffskonzept-${data.today}.md`} idPrefix="zk" />;
}

/** VOU-125 / GOBD-08: chapter „Ersetzendes Scannen und Belegerfassung“, generated from the voucher settings. */
export function ScanningChapter() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <ScanningInner />
    </ConvexGuard>
  );
}

function ScanningInner() {
  const data = useAuthedQuery(api.vouchers.scanningProcedure, {});
  if (data === undefined) return <div className="h-96" aria-busy="true" />;
  return (
    <DocChapterCard doc={ersetzendesScannen(data)} fileName={`ersetzendes-scannen-${data.today}.md`} idPrefix="es" />
  );
}

/** BNK-116: chapter „Bankdaten“ (provider record, consent periods, written confirmation of Enable Banking). */
export function BankdatenChapter() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <BankdatenInner />
    </ConvexGuard>
  );
}

function BankdatenInner() {
  const data = useAuthedQuery(api.bankFeed.verfahrensdoku, {});
  if (data === undefined) return <div className="h-96" aria-busy="true" />;
  return <DocChapterCard doc={bankdaten(data)} fileName={`bankdaten-${data.today}.md`} idPrefix="bd" />;
}

/** One generated chapter with its sections and a Markdown download. */
export function DocChapterCard({ doc, fileName, idPrefix }: { doc: DocChapter; fileName: string; idPrefix: string }) {
  const t = useTranslations("settings.verfahrensdoku");
  const download = () => {
    const blob = new Blob([zugriffskonzeptMarkdown(doc)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle>
            <h2>{doc.title}</h2>
          </CardTitle>
          <CardDescription>{t("stand", { date: doc.stand })}</CardDescription>
        </div>
        <Button variant="outline" className="h-11 md:h-9" onClick={download}>
          <DownloadIcon aria-hidden="true" />
          {t("download")}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 text-sm">
        {doc.sections.map((s) => (
          <section key={s.heading} aria-labelledby={`${idPrefix}-${s.heading}`} className="flex flex-col gap-2">
            <h3 id={`${idPrefix}-${s.heading}`} className="font-semibold">
              {s.heading}
            </h3>
            {s.paragraphs.map((p) => (
              <p key={p}>{p}</p>
            ))}
            {s.table && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      {s.table.head.map((h) => (
                        <th key={h} scope="col" className="border-b py-1.5 pr-3 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {s.table.rows.map((r) => (
                      <tr key={r.join("|")}>
                        {r.map((c, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: positional cells
                          <td key={i} className="border-b py-1.5 pr-3">
                            {c}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
