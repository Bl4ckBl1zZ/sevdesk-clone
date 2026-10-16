"use client";

import { api } from "@convex/_generated/api";
import { PlusIcon, PrinterIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Component, type ReactNode, useId, useState } from "react";
import { todayBerlin } from "@/components/catalog/shared";
import { money } from "@/components/invoices/invoice-shared";
import { adapterErrorMessage } from "@/components/setup/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { parseBasisPoints, parseCents } from "@/domain/money/parse";
import { interestQuerySchema } from "@/domain/schemas/dunning";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { InterestSegments } from "./dunning-shared";

type MarginMode = "b2b" | "b2c" | "custom";

interface PaymentRow {
  key: number;
  date: string;
  amount: string;
}

/** Builds the `api.dunning.interest` input from the form texts; null while incomplete or invalid. */
export function interestInput(form: {
  amount: string;
  from: string;
  to: string;
  margin: MarginMode;
  customPoints: string;
  payments: readonly { date: string; amount: string }[];
}) {
  const amount = parseCents(form.amount);
  if (!amount.ok) return null;
  let margin: "b2b" | "b2c" | number = form.margin === "custom" ? 0 : form.margin;
  if (form.margin === "custom") {
    const bp = parseBasisPoints(form.customPoints);
    if (!bp.ok) return null;
    margin = bp.value;
  }
  const payments = [];
  for (const p of form.payments) {
    if (!p.date && !p.amount) continue;
    const c = parseCents(p.amount);
    if (!c.ok) return null;
    payments.push({ date: p.date, amountCents: c.value });
  }
  const parsed = interestQuerySchema.safeParse({
    amountCents: amount.value,
    from: form.from,
    to: form.to,
    margin,
    ...(payments.length ? { payments } : {}),
  });
  if (!parsed.success || parsed.data.to < parsed.data.from) return null;
  return parsed.data;
}

/** DUN-022 Verzugszinsrechner as a side sheet: amount, period, B2C/B2B/custom margin, partial payments, segments. */
export function InterestCalculatorSheet({ onClose }: { onClose: () => void }) {
  const t = useTranslations("dunning.calculator");
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(todayBerlin());
  const [margin, setMargin] = useState<MarginMode>("b2b");
  const [customPoints, setCustomPoints] = useState("");
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const ids = { amount: useId(), from: useId(), to: useId(), custom: useId(), margin: useId() };
  const input = interestInput({ amount, from, to, margin, customPoints, payments });
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto data-[side=right]:sm:max-w-xl print:static">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4" data-testid="interest-calculator">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.amount} className="font-medium text-sm">
              {t("amount")}
            </label>
            <Input
              id={ids.amount}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-11 md:h-9"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.from} className="font-medium text-sm">
                {t("from")}
              </label>
              <Input
                id={ids.from}
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-11 md:h-9"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.to} className="font-medium text-sm">
                {t("to")}
              </label>
              <Input
                id={ids.to}
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-11 md:h-9"
              />
            </div>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 font-medium text-sm">{t("margin")}</legend>
            {(["b2b", "b2c", "custom"] as const).map((m) => (
              <label key={m} className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
                <input
                  type="radio"
                  name={ids.margin}
                  className="size-5 accent-primary md:size-4"
                  checked={margin === m}
                  onChange={() => setMargin(m)}
                />
                {t(`margins.${m}`)}
              </label>
            ))}
            {margin === "custom" && (
              <div className="flex flex-col gap-1.5 pl-7">
                <label htmlFor={ids.custom} className="font-medium text-sm">
                  {t("customPoints")}
                </label>
                <Input
                  id={ids.custom}
                  inputMode="decimal"
                  value={customPoints}
                  onChange={(e) => setCustomPoints(e.target.value)}
                  className="h-11 md:h-9"
                />
              </div>
            )}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-medium text-sm">{t("payments")}</legend>
            {payments.map((p, i) => (
              <div key={p.key} className="flex flex-wrap items-end gap-2">
                <Input
                  type="date"
                  aria-label={t("paymentDate", { n: i + 1 })}
                  value={p.date}
                  onChange={(e) =>
                    setPayments((ps) => ps.map((x) => (x.key === p.key ? { ...x, date: e.target.value } : x)))
                  }
                  className="h-11 w-auto md:h-9"
                />
                <Input
                  inputMode="decimal"
                  aria-label={t("paymentAmount", { n: i + 1 })}
                  value={p.amount}
                  onChange={(e) =>
                    setPayments((ps) => ps.map((x) => (x.key === p.key ? { ...x, amount: e.target.value } : x)))
                  }
                  className="h-11 w-32 md:h-9"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 md:size-9"
                  aria-label={t("removePayment", { n: i + 1 })}
                  onClick={() => setPayments((ps) => ps.filter((x) => x.key !== p.key))}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              className="h-11 self-start md:h-9"
              onClick={() => setPayments((ps) => [...ps, { key: Date.now(), date: "", amount: "" }])}
            >
              <PlusIcon aria-hidden="true" />
              {t("addPayment")}
            </Button>
          </fieldset>
          <section aria-live="polite" className="flex flex-col gap-2">
            {input === null ? (
              <p className="text-muted-foreground text-sm">{t("incomplete")}</p>
            ) : (
              <QueryErrorBoundary key={JSON.stringify(input)} fallback={t("failed")}>
                <InterestResult input={input} />
              </QueryErrorBoundary>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function InterestResult({ input }: { input: NonNullable<ReturnType<typeof interestInput>> }) {
  const t = useTranslations("dunning.calculator");
  const result = useAuthedQuery(api.dunning.interest, { values: input });
  if (result === undefined) return <div className="h-16" aria-busy="true" />;
  return (
    <>
      <p className="font-semibold text-base" data-testid="interest-total">
        {t("result", { total: money(result.totalCents) })}
      </p>
      <InterestSegments segments={result.segments} totalCents={result.totalCents} />
      <p className="text-muted-foreground text-xs">{t("method")}</p>
      <Button variant="outline" className="h-11 self-start md:h-9 print:hidden" onClick={() => window.print()}>
        <PrinterIcon aria-hidden="true" />
        {t("print")}
      </Button>
    </>
  );
}

/** The interest query rejects inputs the domain cannot compute (e.g. EC-DUN-10 missing Basiszinssatz): show its text. */
class QueryErrorBoundary extends Component<{ children: ReactNode; fallback: string }, { message: string | null }> {
  override state = { message: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { message: adapterErrorMessage(error) ?? "" };
  }
  override render() {
    if (this.state.message !== null) {
      return (
        <p role="alert" className="text-danger text-sm">
          {this.state.message || this.props.fallback}
        </p>
      );
    }
    return this.props.children;
  }
}
