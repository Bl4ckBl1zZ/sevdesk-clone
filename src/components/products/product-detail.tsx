"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { PlusIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useId, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  ConfirmDialog,
  FormDialog,
  formatDate,
  formatPercentBp,
  formatPrice,
  useCan,
  useRun,
} from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { SelectField, TextField } from "@/components/forms/fields";
import { PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PRODUCT_TYPE_LABELS } from "@/domain/products/product";
import { VAT_RATE_KEY_LABELS } from "@/domain/rules/vat-rates";
import {
  type CustomerPriceFormValues,
  customerPriceSchema,
  type ScheduledPriceFormValues,
  scheduledPriceSchema,
} from "@/domain/schemas/products";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { ProductForm } from "./product-form";
import { StockTab } from "./stock-tab";

type Bundle = NonNullable<FunctionReturnType<typeof api.products.get>>;

/** Product detail (F03 §6.3): facts, Stammdaten (editor) and Preise (customer prices, scheduled price change). */
export function ProductDetail({ id }: { id: string }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <ProductDetailInner id={id as Id<"products">} />
    </ConvexGuard>
  );
}

function ProductDetailInner({ id }: { id: Id<"products"> }) {
  const t = useTranslations("products.detail");
  const tNav = useTranslations("nav");
  const data = useAuthedQuery(api.products.get, { id });
  const canWrite = useCan("products.write");
  const [tab, setTab] = useState("master");
  if (data === undefined) return <div className="h-96" aria-busy="true" />;
  if (data === null) {
    return (
      <>
        <PageHeader title={t("notFound")} breadcrumbs={[{ label: tNav("items.produkte"), href: "/produkte" }]} />
        <PageBody>
          <p role="alert">{t("notFound")}</p>
        </PageBody>
      </>
    );
  }
  const p = data.product;
  return (
    <>
      <PageHeader
        title={p.name}
        description={`${p.number} · ${PRODUCT_TYPE_LABELS[p.type]}${p.active ? "" : ` · ${t("inactive")}`}`}
        breadcrumbs={[{ label: tNav("items.produkte"), href: "/produkte" }, { label: p.name }]}
        actions={canWrite ? <HeaderActions data={data} /> : undefined}
      />
      <PageBody className="@container/detail">
        <div className="grid gap-4 @4xl/detail:grid-cols-[minmax(0,1fr)_20rem]">
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="min-w-0">
            <TabsList className="h-auto w-full justify-start overflow-x-auto">
              {(p.type === "good" ? (["master", "prices", "stock"] as const) : (["master", "prices"] as const)).map(
                (k) => (
                  <TabsTrigger key={k} value={k} className="h-11 flex-none px-3 md:h-9">
                    {t(`tabs.${k}`)}
                  </TabsTrigger>
                ),
              )}
            </TabsList>
            <TabsContent value="master" className="pt-4">
              {canWrite ? <ProductForm key={p.version} product={p} /> : <ReadOnly data={data} />}
            </TabsContent>
            <TabsContent value="prices" className="flex flex-col gap-4 pt-4">
              <ScheduledPrice data={data} canWrite={canWrite} />
              <CustomerPrices data={data} canWrite={canWrite} />
            </TabsContent>
            {p.type === "good" && (
              <TabsContent value="stock" className="pt-4">
                <StockTab productId={p._id} canWrite={canWrite} />
              </TabsContent>
            )}
          </Tabs>
          <Facts data={data} />
        </div>
      </PageBody>
    </>
  );
}

function HeaderActions({ data }: { data: Bundle }) {
  const t = useTranslations("products.detail");
  const router = useRouter();
  const run = useRun();
  const archive = useMutation(api.products.archive);
  const unarchive = useMutation(api.products.unarchive);
  const remove = useMutation(api.products.remove);
  const [confirm, setConfirm] = useState(false);
  const p = data.product;
  return (
    <>
      {p.active ? (
        <Button
          variant="outline"
          className="h-11 md:h-9"
          onClick={() => void run(() => archive({ id: p._id }), t("archived"))}
        >
          {t("archive")}
        </Button>
      ) : (
        <Button
          variant="outline"
          className="h-11 md:h-9"
          onClick={() => void run(() => unarchive({ id: p._id }), t("unarchived"))}
        >
          {t("unarchive")}
        </Button>
      )}
      <Button variant="outline" className="h-11 text-danger md:h-9" onClick={() => setConfirm(true)}>
        {t("delete")}
      </Button>
      {confirm && (
        <ConfirmDialog
          title={t("deleteTitle")}
          description={t("deleteDescription")}
          confirmLabel={t("delete")}
          destructive
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            const r = await run(() => remove({ id: p._id }), t("deleted"));
            if (r.ok) router.push("/produkte");
          }}
        />
      )}
    </>
  );
}

function Facts({ data }: { data: Bundle }) {
  const t = useTranslations("products.detail");
  const tl = useTranslations("products.list.columns");
  const p = data.product;
  return (
    <aside aria-label={t("facts")} className="rounded-xl border p-4 text-sm">
      <h2 className="mb-3 font-semibold text-base">{t("facts")}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
        <dt className="text-muted-foreground">{tl("number")}</dt>
        <dd className="tabular-nums">{p.number}</dd>
        <dt className="text-muted-foreground">{tl("unit")}</dt>
        <dd>{p.unitCode}</dd>
        <dt className="text-muted-foreground">{tl("net")}</dt>
        <dd className="tabular-nums">{formatPrice(data.netMicros)}</dd>
        <dt className="text-muted-foreground">{tl("gross")}</dt>
        <dd className="tabular-nums">{formatPrice(data.grossMicros)}</dd>
        <dt className="text-muted-foreground">{t("rate")}</dt>
        <dd>
          {VAT_RATE_KEY_LABELS[p.vatRateKey as keyof typeof VAT_RATE_KEY_LABELS] ?? p.vatRateKey} (
          {formatPercentBp(data.rateBp)})
        </dd>
        {data.margin && (
          <>
            <dt className="text-muted-foreground">{tl("margin")}</dt>
            <dd>
              {formatPercentBp(data.margin.marginBp)}
              {data.margin.costLabel && (
                <span className="block text-muted-foreground text-xs">{data.margin.costLabel}</span>
              )}
            </dd>
          </>
        )}
        {data.category && (
          <>
            <dt className="text-muted-foreground">{tl("category")}</dt>
            <dd>{data.category}</dd>
          </>
        )}
      </dl>
      {data.tags.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1" aria-label="Tags">
          {data.tags.map((tag) => (
            <li key={tag._id}>
              <Badge variant="outline">{tag.name}</Badge>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function ReadOnly({ data }: { data: Bundle }) {
  const tf = useTranslations("products.form");
  const p = data.product;
  const rows: [string, string | undefined][] = [
    [tf("name"), p.name],
    [tf("description"), p.description],
    [tf("gtin"), p.gtin],
    [tf("unit"), p.unitCode],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl border p-4 text-sm">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="whitespace-pre-wrap">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

// ── PRD-031 scheduled price ────────────────────────────────────────────────────────────────────────────
function ScheduledPrice({ data, canWrite }: { data: Bundle; canWrite: boolean }) {
  const t = useTranslations("products.prices");
  const run = useRun();
  const setScheduled = useMutation(api.products.setScheduledPrice);
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const s = data.product.scheduledPrice;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="font-semibold text-base">
          {t("scheduled")}
        </h2>
        {canWrite && (
          <div className="flex gap-2">
            {s && (
              <Button
                variant="outline"
                className="h-11 md:h-9"
                onClick={() =>
                  void run(() => setScheduled({ id: data.product._id, values: null }), t("scheduleCancelled"))
                }
              >
                {t("cancelSchedule")}
              </Button>
            )}
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setOpen(true)}>
              {t("schedule")}
            </Button>
          </div>
        )}
      </div>
      <p className={s ? "" : "text-muted-foreground"}>
        {s
          ? t("scheduledInfo", {
              date: formatDate(s.validFrom),
              price: formatPrice(s.unitPriceMicros),
              mode: t(`modes.${s.priceMode}`),
            })
          : t("scheduledNone")}
      </p>
      {open && <ScheduleDialog data={data} onClose={() => setOpen(false)} />}
    </section>
  );
}

function ScheduleDialog({ data, onClose }: { data: Bundle; onClose: () => void }) {
  const t = useTranslations("products.prices");
  const run = useRun();
  const setScheduled = useMutation(api.products.setScheduledPrice);
  const formId = useId();
  const form = useZodForm(scheduledPriceSchema, {
    validFrom: "",
    priceMode: data.product.priceMode,
    price: "",
  }) as unknown as UseFormReturn<ScheduledPriceFormValues>;
  const submit = form.handleSubmit(async () => {
    const r = await run(() => setScheduled({ id: data.product._id, values: form.getValues() }), t("scheduleSaved"));
    if (r.ok) onClose();
  });
  return (
    <FormDialog
      title={t("scheduleTitle")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
    >
      <TextField form={form} name="validFrom" label={t("validFrom")} type="date" required />
      <SelectField
        form={form}
        name="priceMode"
        label={t("mode")}
        options={(["net", "gross"] as const).map((m) => ({ value: m, label: t(`modes.${m}`) }))}
      />
      <TextField form={form} name="price" label={t("price")} inputMode="decimal" required />
    </FormDialog>
  );
}

// ── PRD-030 customer prices ────────────────────────────────────────────────────────────────────────────
function CustomerPrices({ data, canWrite }: { data: Bundle; canWrite: boolean }) {
  const t = useTranslations("products.prices");
  const run = useRun();
  const remove = useMutation(api.products.removeCustomerPrice);
  const [open, setOpen] = useState(false);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="font-semibold text-base">
          {t("customer")}
        </h2>
        {canWrite && (
          <Button variant="outline" className="h-11 md:h-9" onClick={() => setOpen(true)}>
            <PlusIcon aria-hidden="true" />
            {t("add")}
          </Button>
        )}
      </div>
      {data.customerPrices.length === 0 ? (
        <p className="text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("contact")}</TableHead>
                <TableHead className="text-right">{t("price")}</TableHead>
                <TableHead>{t("mode")}</TableHead>
                <TableHead>{t("validFrom")}</TableHead>
                {canWrite && <TableHead className="sr-only">{t("remove")}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.customerPrices.map((cp) => (
                <TableRow key={cp._id}>
                  <TableCell>
                    <Link href={`/kontakte/${cp.contact._id}` as Route} className="hover:underline">
                      {cp.contact.displayName} ({cp.contact.number})
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatPrice(cp.unitPriceMicros)}</TableCell>
                  <TableCell>{t(`modes.${cp.priceMode}`)}</TableCell>
                  <TableCell>{cp.validFrom ? formatDate(cp.validFrom) : t("always")}</TableCell>
                  {canWrite && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        className="h-11 text-danger md:h-8"
                        onClick={() => void run(() => remove({ priceId: cp._id }), t("removed"))}
                      >
                        {t("remove")}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {open && <CustomerPriceDialog data={data} onClose={() => setOpen(false)} />}
    </section>
  );
}

function CustomerPriceDialog({ data, onClose }: { data: Bundle; onClose: () => void }) {
  const t = useTranslations("products.prices");
  const run = useRun();
  const save = useMutation(api.products.saveCustomerPrice);
  const formId = useId();
  const searchId = useId();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);
  const contacts = useAuthedQuery(api.contacts.options, query ? { q: query } : {}) ?? [];
  const form = useZodForm(customerPriceSchema, {
    contactId: "",
    priceMode: data.product.priceMode,
    price: "",
    validFrom: "",
  }) as unknown as UseFormReturn<CustomerPriceFormValues>;
  const submit = form.handleSubmit(async () => {
    const r = await run(() => save({ productId: data.product._id, values: form.getValues() }), t("saved"));
    if (r.ok) onClose();
  });
  return (
    <FormDialog
      title={t("addTitle")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={searchId} className="font-medium text-sm">
          {t("contactSearch")}
        </label>
        <Input id={searchId} type="search" className="h-11 md:h-9" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <SelectField
        form={form}
        name="contactId"
        label={t("contact")}
        required
        placeholder="—"
        options={contacts.map((c) => ({ value: c._id, label: `${c.displayName} (${c.number})` }))}
      />
      <SelectField
        form={form}
        name="priceMode"
        label={t("mode")}
        options={(["net", "gross"] as const).map((m) => ({ value: m, label: t(`modes.${m}`) }))}
      />
      <TextField form={form} name="price" label={t("price")} inputMode="decimal" required />
      <TextField form={form} name="validFrom" label={t("validFrom")} description={t("validFromHint")} type="date" />
    </FormDialog>
  );
}
