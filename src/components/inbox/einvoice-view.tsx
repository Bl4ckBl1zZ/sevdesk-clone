"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ReceivedAddress, ReceivedInvoice } from "@/domain/einvoice/received";

/**
 * Readable rendering of a received E-Rechnung from the parsed EN 16931 model (F06 INB-040): header, seller/buyer,
 * references (BT-10/12/13/25), lines with item data, allowances/charges, VAT breakdown, totals, payment instructions
 * incl. IBAN and parsed Skonto (BT-20), notes (BT-22). Every value from the document is supplier-provided, untrusted
 * text (INB-030) and is rendered as React text only (escaped; never as HTML). Container queries adapt the layout to
 * the viewer column.
 */

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "EUR",
  }).format(cents / 100);
const percent = (bp: number) => `${(bp / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 })} %`;
const quantity = (milli: number) => (milli / 1000).toLocaleString("de-DE", { maximumFractionDigits: 3 });
const unitPrice = (micros: number, currency: string) =>
  `${(micros / 10_000).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${currency}`;
const date = (iso: string | undefined) => (iso ? iso.split("-").reverse().join(".") : "–");

function addressLines(a: ReceivedAddress | undefined): string[] {
  if (!a) return [];
  return [a.line1, a.line2, [a.postalCode, a.city].filter(Boolean).join(" "), a.countryCode].filter(
    (l): l is string => !!l && l.trim() !== "",
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="font-semibold text-sm">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Pairs({ rows }: { rows: [string, string | undefined][] }) {
  const shown = rows.filter((r): r is [string, string] => !!r[1]);
  if (shown.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EinvoiceView({ invoice: inv }: { invoice: ReceivedInvoice }) {
  const t = useTranslations("einvoiceView");
  const cur = inv.currency;
  const credit = inv.typeCode === "381";
  return (
    <article className="@container/einvoice flex flex-col gap-5 rounded-xl border p-4" data-testid="einvoice-view">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold text-lg">
            {credit ? t("creditNote", { number: inv.number }) : t("invoice", { number: inv.number })}
          </h2>
          <Badge variant="outline">{t("profile", { profile: inv.profile, syntax: inv.syntax.toUpperCase() })}</Badge>
          {inv.notEInvoice && <Badge variant="destructive">{t("notEInvoice")}</Badge>}
        </div>
        <Pairs
          rows={[
            [t("issueDate"), date(inv.issueDate)],
            [t("dueDate"), inv.dueDate ? date(inv.dueDate) : undefined],
            [t("supplyDate"), inv.supplyDate ? date(inv.supplyDate) : undefined],
            [t("period"), inv.period ? `${date(inv.period.from)} – ${date(inv.period.to)}` : undefined],
            [t("currency"), inv.vatCurrency && inv.vatCurrency !== cur ? `${cur} (USt in ${inv.vatCurrency})` : cur],
          ]}
        />
      </header>

      <div className="grid gap-4 @lg/einvoice:grid-cols-2">
        <Section title={t("seller")}>
          <address className="text-sm not-italic">
            <span className="block font-medium">{inv.seller.name}</span>
            {inv.seller.tradeName && <span className="block">{inv.seller.tradeName}</span>}
            {addressLines(inv.seller.address).map((l) => (
              <span key={l} className="block">
                {l}
              </span>
            ))}
          </address>
          <Pairs
            rows={[
              [t("vatId"), inv.seller.vatId],
              [t("taxNumber"), inv.seller.taxNumber],
              [t("email"), inv.seller.email],
              [
                t("electronicAddress"),
                inv.seller.electronicAddress
                  ? `${inv.seller.electronicAddress.value} (${inv.seller.electronicAddress.scheme})`
                  : undefined,
              ],
            ]}
          />
        </Section>
        <Section title={t("buyer")}>
          <address className="text-sm not-italic">
            {inv.buyer.name && <span className="block font-medium">{inv.buyer.name}</span>}
            {addressLines(inv.buyer.address).map((l) => (
              <span key={l} className="block">
                {l}
              </span>
            ))}
          </address>
          <Pairs
            rows={[
              [t("vatId"), inv.buyer.vatId],
              [
                t("electronicAddress"),
                inv.buyer.electronicAddress
                  ? `${inv.buyer.electronicAddress.value} (${inv.buyer.electronicAddress.scheme})`
                  : undefined,
              ],
            ]}
          />
        </Section>
      </div>

      {(inv.buyerReference || inv.contractRef || inv.orderRef || inv.precedingInvoices.length > 0) && (
        <Section title={t("references")}>
          <Pairs
            rows={[
              [t("buyerReference"), inv.buyerReference],
              [t("contractRef"), inv.contractRef],
              [t("orderRef"), inv.orderRef],
              ...inv.precedingInvoices.map(
                (p, i) =>
                  [
                    inv.precedingInvoices.length > 1 ? `${t("precedingInvoice")} ${i + 1}` : t("precedingInvoice"),
                    p.date ? t("numberOfDate", { number: p.number, date: date(p.date) }) : p.number,
                  ] as [string, string],
              ),
            ]}
          />
        </Section>
      )}

      {inv.lines.length > 0 && (
        <Section title={t("lines")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("pos")}</TableHead>
                <TableHead scope="col">{t("item")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("quantity")}
                </TableHead>
                <TableHead scope="col" className="hidden text-right @md/einvoice:table-cell">
                  {t("unitPrice")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("vat")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("net")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inv.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.id}</TableCell>
                  <TableCell className="whitespace-normal">
                    <span className="block">{l.name}</span>
                    {l.description && <span className="block text-muted-foreground text-xs">{l.description}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {quantity(l.quantityMilli)} {l.unitCode ?? ""}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums @md/einvoice:table-cell">
                    {l.unitPriceMicros !== undefined ? unitPrice(l.unitPriceMicros, cur) : "–"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.category} {percent(l.rateBp)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.netCents, cur)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {inv.allowancesCharges.length > 0 && (
        <Section title={t("allowancesCharges")}>
          <ul className="flex flex-col gap-1 text-sm">
            {inv.allowancesCharges.map((a, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional document-level entries
              <li key={i} className="flex flex-wrap justify-between gap-2">
                <span>
                  {a.charge ? t("charge") : t("allowance")}
                  {a.reason ? `: ${a.reason}` : ""} ({a.category} {percent(a.rateBp)})
                </span>
                <span className="tabular-nums">{money(a.charge ? a.amountCents : -a.amountCents, cur)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={t("vatBreakdown")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("category")}</TableHead>
              <TableHead scope="col" className="text-right">
                {t("rate")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("taxable")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("tax")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {inv.vatBreakdown.map((v) => (
              <TableRow key={`${v.category}-${v.rateBp}`}>
                <TableCell className="whitespace-normal">
                  {v.category}
                  {v.exemptionReason && (
                    <span className="block text-muted-foreground text-xs">{v.exemptionReason}</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{percent(v.rateBp)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(v.taxableCents, cur)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(v.taxCents, cur)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title={t("totals")}>
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm tabular-nums">
          {(
            [
              [t("lineTotal"), inv.totals.lineTotalCents],
              ...(inv.totals.allowanceTotalCents !== 0 ? [[t("allowanceTotal"), -inv.totals.allowanceTotalCents]] : []),
              ...(inv.totals.chargeTotalCents !== 0 ? [[t("chargeTotal"), inv.totals.chargeTotalCents]] : []),
              [t("taxExclusive"), inv.totals.taxExclusiveCents],
              [t("taxTotal"), inv.totals.taxCents],
              [t("taxInclusive"), inv.totals.taxInclusiveCents],
              ...(inv.totals.prepaidCents !== 0 ? [[t("prepaid"), -inv.totals.prepaidCents]] : []),
              ...(inv.totals.roundingCents !== 0 ? [[t("rounding"), inv.totals.roundingCents]] : []),
            ] as [string, number][]
          ).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right">{money(v, cur)}</dd>
            </div>
          ))}
          <div className="contents font-semibold">
            <dt>{t("payable")}</dt>
            <dd className="text-right">{money(inv.totals.payableCents, cur)}</dd>
          </div>
          {inv.taxTotalVatCurrencyCents !== undefined && inv.vatCurrency && (
            <div className="contents">
              <dt className="text-muted-foreground">{t("taxInVatCurrency", { currency: inv.vatCurrency })}</dt>
              <dd className="text-right">{money(inv.taxTotalVatCurrencyCents, inv.vatCurrency)}</dd>
            </div>
          )}
        </dl>
      </Section>

      <Section title={t("payment")}>
        <Pairs
          rows={[
            [t("meansCode"), inv.payment.meansCode],
            [t("iban"), inv.payment.iban],
            [t("bic"), inv.payment.bic],
            [t("accountName"), inv.payment.accountName ?? inv.payee?.name],
          ]}
        />
        {inv.payment.skonto.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {inv.payment.skonto.map((k) => (
              <li key={`${k.days}-${k.percentBp}`}>
                {k.baseCents !== undefined
                  ? t("skontoWithBase", { percent: percent(k.percentBp), days: k.days, base: money(k.baseCents, cur) })
                  : t("skonto", { percent: percent(k.percentBp), days: k.days })}
              </li>
            ))}
          </ul>
        )}
        {inv.payment.termsText && (
          <p className="whitespace-pre-line text-muted-foreground text-sm">{inv.payment.termsText}</p>
        )}
      </Section>

      {inv.notes.length > 0 && (
        <Section title={t("notes")}>
          {inv.notes.map((n, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional notes
            <p key={i} className="whitespace-pre-line text-sm">
              {n}
            </p>
          ))}
        </Section>
      )}

      {inv.attachments.length > 0 && (
        <Section title={t("attachments")}>
          <ul className="flex flex-col gap-1 text-sm">
            {inv.attachments.map((a, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: attachment ids are optional
              <li key={i}>
                {a.filename} ({a.mime}){a.description ? ` – ${a.description}` : ""}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </article>
  );
}
