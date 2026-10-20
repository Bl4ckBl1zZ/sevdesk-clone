"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { formatDate } from "@/components/catalog/shared";
import { ContactDunningCard } from "@/components/dunning/contact-dunning-card";
import { money } from "@/components/invoices/invoice-shared";
import { FactList } from "@/components/layout/list-layout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PAYMENT_SOURCE_LABEL_DE } from "@/domain/payments/customer";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/** F05 PAY-004 Kontakt › „Offene Posten": open items, payment history, credit, dunning cases, average days to pay. */
export function ContactReceivables({ contactId }: { contactId: string }) {
  const t = useTranslations("payments.contactReceivables");
  const data = useAuthedQuery(api.payments.contactReceivables, { contactId: contactId as Id<"contacts"> });
  if (data === undefined) return <div className="h-40" aria-busy="true" />;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("summary")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FactList
            items={[
              { label: t("open"), value: money(data.totals.openCents, "EUR"), numeric: true },
              { label: t("overdue"), value: money(data.totals.overdueCents, "EUR"), numeric: true },
              { label: t("credit"), value: money(data.creditCents, "EUR"), numeric: true },
              {
                label: t("averageDaysToPay"),
                value:
                  data.averageDaysToPay === null
                    ? t("noPaidInvoices")
                    : t("days", { days: data.averageDaysToPay, count: data.paidInvoices }),
              },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("items")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.items.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("noItems")}</p>
          ) : (
            <Table scrollLabel={t("items")} data-testid="contact-open-items">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("number")}</TableHead>
                  <TableHead>{t("date")}</TableHead>
                  <TableHead>{t("due")}</TableHead>
                  <TableHead className="text-right">{t("openAmount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      {i.kind === "salesDocument" ? (
                        <Link href={`/rechnungen/${i.id}` as Route} className="font-medium underline">
                          {i.number}
                        </Link>
                      ) : (
                        i.number
                      )}
                    </TableCell>
                    <TableCell>{formatDate(i.documentDate)}</TableCell>
                    <TableCell>
                      {formatDate(i.dueDate)}
                      {i.overdue && (
                        <Badge variant="outline" className="ml-2 border-danger/60 text-danger">
                          {t("overdueDays", { days: i.daysOverdue })}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(i.openCents, i.currency)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("history")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.payments.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("noPayments")}</p>
          ) : (
            <Table scrollLabel={t("history")} data-testid="contact-payment-history">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("date")}</TableHead>
                  <TableHead>{t("number")}</TableHead>
                  <TableHead>{t("source")}</TableHead>
                  <TableHead className="text-right">{t("amount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.payments.map((p) => (
                  <TableRow key={p.paymentId}>
                    <TableCell>{formatDate(p.date)}</TableCell>
                    <TableCell>
                      {p.targetKind === "salesDocument" && p.number ? (
                        <Link href={`/rechnungen/${p.targetId}` as Route} className="underline">
                          {p.number}
                        </Link>
                      ) : p.targetKind === "contactCredit" ? (
                        t("creditRow")
                      ) : (
                        (p.number ?? "—")
                      )}
                      {p.reversed && <span className="ml-2 text-muted-foreground">({t("reversed")})</span>}
                      {p.reversal && <span className="ml-2 text-muted-foreground">({t("reversal")})</span>}
                    </TableCell>
                    <TableCell>{PAYMENT_SOURCE_LABEL_DE[p.source] ?? p.source}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(p.amountCents, p.currency)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {data.truncated && <p className="mt-2 text-muted-foreground text-xs">{t("truncated")}</p>}
        </CardContent>
      </Card>
      <ContactDunningCard contactId={contactId} />
    </div>
  );
}
