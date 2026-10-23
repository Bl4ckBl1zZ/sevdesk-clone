"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { formatDate } from "@/components/catalog/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DOC_TYPE_LABEL_DE, documentPath } from "@/domain/documents/doc-types";
import { formatEuro } from "@/domain/money";
import { formatMilli } from "@/domain/money/format";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/** F03 PRD-074 „Verwendung“: documents with the product, units sold and revenue this/last year. */
export function UsageTab({ productId }: { productId: Id<"products"> }) {
  const t = useTranslations("products.detail.usage");
  const u = useAuthedQuery(api.products.usage, { id: productId });
  if (u === undefined) return <div className="h-48" aria-busy="true" />;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <section className="grid gap-3 rounded-xl border p-4 @lg/detail:grid-cols-2" data-testid="product-usage-sums">
        {(["thisYear", "lastYear"] as const).map((k) => (
          <dl key={k} className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="col-span-2 font-semibold">{t(k)}</dt>
            <dt className="text-muted-foreground">{t("units")}</dt>
            <dd className="text-right tabular-nums">{formatMilli(u[k].unitsMilli)}</dd>
            <dt className="text-muted-foreground">{t("revenue")}</dt>
            <dd className="text-right tabular-nums">{formatEuro(u[k].revenueCents)}</dd>
          </dl>
        ))}
        <p className="text-muted-foreground @lg/detail:col-span-2">{t("soldHint")}</p>
      </section>
      <section className="rounded-xl border p-4">
        <h2 className="mb-2 font-semibold text-base">{t("documents")}</h2>
        {u.documents.length === 0 ? (
          <p className="text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("document")}</TableHead>
                  <TableHead>{t("date")}</TableHead>
                  <TableHead>{t("contact")}</TableHead>
                  <TableHead className="text-right">{t("units")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {u.documents.map((d) => {
                  const type = d.type as keyof typeof DOC_TYPE_LABEL_DE;
                  return (
                    <TableRow key={d.documentId}>
                      <TableCell>
                        <Link href={documentPath(type, d.documentId) as Route} className="font-medium hover:underline">
                          {DOC_TYPE_LABEL_DE[type] ?? d.type} {d.number ?? `(${t("draft")})`}
                        </Link>
                      </TableCell>
                      <TableCell>{d.documentDate ? formatDate(d.documentDate) : "—"}</TableCell>
                      <TableCell>{d.contactName ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMilli(d.quantityMilli)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
