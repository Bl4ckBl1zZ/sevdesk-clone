"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CheckIcon, MailIcon, PhoneIcon, UserPlusIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useWatch } from "react-hook-form";
import { EntityHistory } from "@/components/audit/entity-history";
import { ConfirmDialog, formatDate, formatDateTime, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { SelectField } from "@/components/forms/fields";
import { PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";
import { ContactReceivables } from "@/components/payments/contact-receivables";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { telHref } from "@/domain/contacts/channels";
import { ROLE_LABELS } from "@/domain/contacts/core";
import { DUPLICATE_REASON_LABELS } from "@/domain/contacts/duplicates";
import { filterTimeline, type TimelineFilter } from "@/domain/contacts/timeline";
import { formatEuro } from "@/domain/money";
import { ACTIVITY_KIND_LABELS, ACTIVITY_KINDS, activitySchema } from "@/domain/schemas/contacts";
import { TAX_CASE_LABELS } from "@/domain/tax/tax-case";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { AddressesCard, ChannelsCard } from "./contact-addresses";
import { ContactForm } from "./contact-form";
import { CertificateCard, ConsentCard, VatCheckCard } from "./contact-tax";
import { VatBadge } from "./contacts-list";
import { MergeDialog } from "./duplicates-panel";

import { SelfBillingAgreementCard } from "./self-billing-agreement";
import { TimelineFilterBar } from "./timeline-filter";

export type ContactBundle = NonNullable<FunctionReturnType<typeof api.contacts.get>>;

/** Contact detail (F02 §6.3): header with actions, facts, tabs Verlauf / Stammdaten / Adressen / Steuer / Personen. */
export function ContactDetail({ id }: { id: string }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <ContactDetailInner id={id as Id<"contacts">} />
    </ConvexGuard>
  );
}

function ContactDetailInner({ id }: { id: Id<"contacts"> }) {
  const t = useTranslations("contacts.detail");
  const tNav = useTranslations("nav");
  const data = useAuthedQuery(api.contacts.get, { id });
  const canWrite = useCan("contacts.write");
  const canMerge = useCan("contacts.merge");
  const canReadPayments = useCan("payments.read");
  const [tab, setTab] = useState("timeline");

  if (data === undefined) return <div className="h-96" aria-busy="true" />;
  if (data === null) {
    return (
      <>
        <PageHeader title={t("notFound")} breadcrumbs={[{ label: tNav("items.kontakte"), href: "/kontakte" }]} />
        <PageBody>
          <p role="alert">{t("notFound")}</p>
        </PageBody>
      </>
    );
  }
  const c = data.contact;
  const archived = c.status === "archived";
  // PAY-004: customers get the „Offene Posten" tab (open items, payment history, credit, dunning cases).
  const showReceivables = canReadPayments && c.roles.includes("customer");
  return (
    <>
      <PageHeader
        title={c.displayName}
        description={`${c.number} · ${c.roles.map((r) => ROLE_LABELS[r]).join(", ")}`}
        breadcrumbs={[{ label: tNav("items.kontakte"), href: "/kontakte" }, { label: c.displayName }]}
        actions={canWrite && !c.mergedIntoId ? <HeaderActions data={data} canMerge={canMerge} /> : undefined}
      />
      <PageBody className="@container/detail">
        {data.mergedInto && (
          <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            {t("mergedInto")}{" "}
            <Link href={`/kontakte/${data.mergedInto._id}` as Route} className="font-medium underline">
              {data.mergedInto.displayName} ({data.mergedInto.number})
            </Link>
          </p>
        )}
        {c.dsgvo?.restrictedAt !== undefined && (
          <p role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            {t("dsgvoRestricted", { date: formatDate(c.dsgvo.scheduledPurgeAt ?? null) })}
          </p>
        )}
        {data.merges.length > 0 && <MergeBanner merges={data.merges} canMerge={canMerge} />}
        {data.duplicateHints.length > 0 && (
          <section
            aria-label={t("duplicateHints")}
            className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
          >
            <p className="font-medium">{t("duplicateHints")}</p>
            <ul className="mt-1 flex flex-col gap-1">
              {data.duplicateHints.map((h) => (
                <li key={h.id}>
                  <Link href={`/kontakte/${h.id}` as Route} className="underline">
                    {h.displayName} ({h.number})
                  </Link>{" "}
                  —{" "}
                  {h.reasons.map((r) => DUPLICATE_REASON_LABELS[r as keyof typeof DUPLICATE_REASON_LABELS]).join(", ")}
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="grid gap-4 @4xl/detail:grid-cols-[minmax(0,1fr)_20rem]">
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="min-w-0">
            <TabsList className="h-auto w-full justify-start overflow-x-auto">
              {(
                [
                  "timeline",
                  ...(showReceivables ? ["receivables"] : []),
                  "master",
                  "addresses",
                  "tax",
                  ...(c.kind === "organization" ? ["persons"] : []),
                ] as const
              ).map((k) => (
                <TabsTrigger key={k} value={k} className="h-11 flex-none px-3 md:h-9">
                  {t(`tabs.${k as "timeline"}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="timeline" className="pt-4">
              <Timeline data={data} canWrite={canWrite && !archived} />
              <div className="mt-4">
                <EntityHistory table="contacts" id={id} />
              </div>
            </TabsContent>
            <TabsContent value="master" className="pt-4">
              {canWrite ? <ContactForm key={c.version} contact={c} /> : <ReadOnlyMaster data={data} />}
            </TabsContent>
            <TabsContent value="addresses" className="flex flex-col gap-4 pt-4">
              <AddressesCard data={data} canWrite={canWrite} />
              <ChannelsCard data={data} canWrite={canWrite} />
            </TabsContent>
            <TabsContent value="tax" className="flex flex-col gap-4 pt-4">
              <TaxProfileCard data={data} />
              <VatCheckCard data={data} canWrite={canWrite} />
              <ConsentCard data={data} canWrite={canWrite} />
              <CertificateCard data={data} canWrite={canWrite} />
              <SelfBillingAgreementCard data={data} canWrite={canWrite} />
            </TabsContent>
            {showReceivables && (
              <TabsContent value="receivables" className="pt-4">
                <ContactReceivables contactId={c._id} />
              </TabsContent>
            )}
            {c.kind === "organization" && (
              <TabsContent value="persons" className="pt-4">
                <Persons data={data} canWrite={canWrite} />
              </TabsContent>
            )}
          </Tabs>
          <Facts data={data} />
        </div>
      </PageBody>
    </>
  );
}

function HeaderActions({ data, canMerge }: { data: ContactBundle; canMerge: boolean }) {
  const t = useTranslations("contacts.detail");
  const router = useRouter();
  const run = useRun();
  const archive = useMutation(api.contacts.archive);
  const unarchive = useMutation(api.contacts.unarchive);
  const remove = useMutation(api.contacts.remove);
  const [dialog, setDialog] = useState<"delete" | "merge" | null>(null);
  const canDsgvo = useCan("dsgvo.manage");
  const c = data.contact;
  const archived = c.status === "archived";
  return (
    <>
      {archived ? (
        <Button
          variant="outline"
          className="h-11 md:h-9"
          onClick={() => void run(() => unarchive({ id: c._id }), t("unarchived"))}
        >
          {t("unarchive")}
        </Button>
      ) : (
        <Button
          variant="outline"
          className="h-11 md:h-9"
          onClick={() => void run(() => archive({ id: c._id }), t("archived"))}
        >
          {t("archive")}
        </Button>
      )}
      {canDsgvo && (
        <Link
          href={`/einstellungen/datenschutz?tab=anfragen&contact=${c._id}` as Route}
          className={buttonVariants({ variant: "outline", className: "h-11 md:h-9" })}
        >
          {t("dsgvoRequest")}
        </Link>
      )}
      {canMerge && !archived && (
        <Button variant="outline" className="h-11 md:h-9" onClick={() => setDialog("merge")}>
          {t("merge")}
        </Button>
      )}
      <Button variant="outline" className="h-11 text-danger md:h-9" onClick={() => setDialog("delete")}>
        {t("delete")}
      </Button>
      {dialog === "delete" && (
        <ConfirmDialog
          title={t("deleteTitle")}
          description={
            data.deleteBlockedBy.length > 0
              ? t("deleteBlocked", { refs: data.deleteBlockedBy.join(", ") })
              : t("deleteDescription")
          }
          confirmLabel={t("delete")}
          destructive
          confirmDisabled={data.deleteBlockedBy.length > 0}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const r = await run(() => remove({ id: c._id }), t("deleted"));
            if (r.ok) router.push("/kontakte");
          }}
        />
      )}
      {dialog === "merge" && <MergeDialog winnerId={c._id} kind={c.kind} onClose={() => setDialog(null)} />}
    </>
  );
}

function MergeBanner({ merges, canMerge }: { merges: ContactBundle["merges"]; canMerge: boolean }) {
  const t = useTranslations("contacts.detail");
  const run = useRun();
  const undo = useMutation(api.contacts.undoMerge);
  return (
    <ul className="flex flex-col gap-2">
      {merges.map((m) => (
        <li
          key={m._id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-3 text-sm"
        >
          <span>
            {t("mergedHere", { name: m.loser ? `${m.loser.displayName} (${m.loser.number})` : "—" })} ·{" "}
            {formatDateTime(m.at)}
          </span>
          {canMerge && (
            <Button
              variant="outline"
              className="h-11 md:h-8"
              onClick={() => void run(() => undo({ mergeId: m._id }), t("undone"))}
            >
              {t("undoMerge")}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Facts({ data }: { data: ContactBundle }) {
  const t = useTranslations("contacts.detail");
  const tType = useTranslations("contacts.form.customerTypes");
  const c = data.contact;
  const type = c.isConsumer ? "b2c" : c.isPublicAuthority ? "b2g" : "b2b";
  const primaryPhone = data.channels.find((ch) => (ch.type === "phone" || ch.type === "mobile") && ch.isPrimary);
  const primaryMail = data.channels.find((ch) => ch.type === "email" && ch.isPrimary);
  return (
    <aside aria-label={t("facts")} className="flex flex-col gap-4">
      <section className="rounded-xl border p-4">
        <h2 className="mb-3 font-semibold text-base">{t("facts")}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t("number")}</dt>
          <dd className="tabular-nums">{c.number}</dd>
          <dt className="text-muted-foreground">{t("status")}</dt>
          <dd>{c.status === "archived" ? <Badge variant="outline">{t("archivedBadge")}</Badge> : c.status}</dd>
          <dt className="text-muted-foreground">{t("customerType")}</dt>
          <dd>{tType(type)}</dd>
          {c.vatId && (
            <>
              <dt className="text-muted-foreground">USt-IdNr</dt>
              <dd className="flex flex-col items-start gap-1">
                <span className="font-mono">{c.vatId}</span>
                <VatBadge kind={data.vatBadge.kind} text={data.vatBadge.text} />
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">{t("electronicAddress")}</dt>
          <dd className="break-all">
            {data.electronicAddress ? (
              `${data.electronicAddress.value} (${data.electronicAddress.scheme})`
            ) : (
              <span className="text-warning">{t("electronicAddressMissing")}</span>
            )}
          </dd>
          <dt className="text-muted-foreground">{t("invoiceRecipients")}</dt>
          <dd className="break-all">
            {data.invoiceRecipients.length ? data.invoiceRecipients.join(", ") : t("noInvoiceEmail")}
          </dd>
          {c.paymentTerms && (
            <>
              <dt className="text-muted-foreground">{t("paymentTerms")}</dt>
              <dd>{t("days", { days: c.paymentTerms.dueDays })}</dd>
            </>
          )}
          {data.parent && (
            <>
              <dt className="text-muted-foreground">{t("persons")}</dt>
              <dd>
                <Link href={`/kontakte/${data.parent._id}` as Route} className="underline">
                  {data.parent.displayName}
                </Link>
              </dd>
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
        <div className="mt-3 flex flex-wrap gap-2">
          {primaryPhone && (
            <a
              href={telHref(primaryPhone.e164 ?? primaryPhone.value)}
              className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-8")}
            >
              <PhoneIcon aria-hidden="true" />
              {primaryPhone.value}
            </a>
          )}
          {primaryMail && (
            <a
              href={`mailto:${primaryMail.value}`}
              className={cn(buttonVariants({ variant: "outline" }), "h-11 max-w-full md:h-8")}
            >
              <MailIcon aria-hidden="true" />
              <span className="truncate">{primaryMail.value}</span>
            </a>
          )}
        </div>
      </section>
      <section className="rounded-xl border p-4 text-sm">
        <h2 className="mb-2 font-semibold text-base">{t("stats")}</h2>
        <p className="text-muted-foreground">{t("statsHint")}</p>
      </section>
      {data.supplierStats && (
        <section className="rounded-xl border p-4 text-sm" data-testid="supplier-stats">
          <h2 className="mb-2 font-semibold text-base">{t("supplierStats")}</h2>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">{t("spendThisYear")}</dt>
            <dd className="text-right tabular-nums">{formatEuro(data.supplierStats.spendThisYearCents)}</dd>
            <dt className="text-muted-foreground">{t("spendAllTime")}</dt>
            <dd className="text-right tabular-nums">{formatEuro(data.supplierStats.spendAllTimeCents)}</dd>
            <dt className="text-muted-foreground">{t("openPayables")}</dt>
            <dd className="text-right tabular-nums">{formatEuro(data.supplierStats.openPayablesCents)}</dd>
          </dl>
        </section>
      )}
    </aside>
  );
}

function TaxProfileCard({ data }: { data: ContactBundle }) {
  const t = useTranslations("contacts.detail");
  const p = data.taxProfile;
  return (
    <section aria-labelledby="tax-profile" className="rounded-xl border p-4 text-sm">
      <h2 id="tax-profile" className="mb-3 font-semibold text-base">
        {t("taxProfile")}
      </h2>
      <dl className="grid gap-2 @lg/detail:grid-cols-2">
        {(["service", "goods"] as const).map((k) => (
          <div key={k} className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">{t(k)}</dt>
            <dd>
              <span className="font-medium">{TAX_CASE_LABELS[p[k].taxCase]}</span>
              <span className="block text-muted-foreground">{p[k].reason}</span>
            </dd>
          </div>
        ))}
      </dl>
      {p.override && <p className="mt-2">{t("override", { taxCase: TAX_CASE_LABELS[p.override] })}</p>}
      {p.warnings.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-warning">
          {p.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReadOnlyMaster({ data }: { data: ContactBundle }) {
  const tf = useTranslations("contacts.form");
  const c = data.contact;
  const rows: [string, string | undefined][] = [
    [tf("organizationName"), c.organizationName],
    [tf("firstName"), c.firstName],
    [tf("lastName"), c.lastName],
    [tf("vatId"), c.vatId],
    [tf("taxNumber"), c.taxNumber],
    [tf("buyerReference"), c.buyerReference],
    [tf("iban"), c.iban],
    [tf("debtorAccount"), c.debtorAccount],
    [tf("creditorAccount"), c.creditorAccount],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl border p-4 text-sm">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="break-all">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function Persons({ data, canWrite }: { data: ContactBundle; canWrite: boolean }) {
  const t = useTranslations("contacts.detail");
  return (
    <section aria-labelledby="persons-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="persons-title" className="font-semibold text-base">
          {t("persons")}
        </h2>
        {canWrite && (
          <Link
            href={`/kontakte/neu?parent=${data.contact._id}` as Route}
            className={cn(buttonVariants({ variant: "outline" }), "h-11 md:h-9")}
          >
            <UserPlusIcon aria-hidden="true" />
            {t("addPerson")}
          </Link>
        )}
      </div>
      {data.persons.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("noPersons")}</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {data.persons.map((p) => (
            <li key={p._id}>
              <Link
                href={`/kontakte/${p._id}` as Route}
                className="flex min-h-11 items-center justify-between gap-2 px-4 py-2 hover:bg-muted/50"
              >
                <span>
                  {p.displayName}
                  {p.position && <span className="text-muted-foreground"> · {p.position}</span>}
                </span>
                <span className="text-muted-foreground text-sm tabular-nums">{p.number}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Verlauf (CON-120…122) ─────────────────────────────────────────────────────────────────────────────
function Timeline({ data, canWrite }: { data: ContactBundle; canWrite: boolean }) {
  const t = useTranslations("contacts.timeline");
  const run = useRun();
  const setDone = useMutation(api.contacts.setTaskDone);
  const remove = useMutation(api.contacts.removeActivity);
  type Entry =
    | { key: string; at: number; manual: (typeof data.activities)[number] }
    | { key: string; at: number; derived: (typeof data.derived)[number] };
  const [filter, setFilter] = useState<TimelineFilter>({ kind: "all" });
  const all: Entry[] = [
    ...data.activities.map((a) => ({ key: a._id as string, at: a._creationTime, manual: a })),
    ...data.derived.map((d, i) => ({ key: `d-${i}-${d.at}`, at: d.at, derived: d })),
  ].sort((a, b) => b.at - a.at);
  // CON-124: kind, period and note search
  const entries = filterTimeline(
    all.map((e) => ({
      ...e,
      kind: "manual" in e ? e.manual.kind : ("derived" as const),
      text: "manual" in e ? e.manual.text : e.derived.text,
    })),
    filter,
  );
  return (
    <div className="flex flex-col gap-4">
      {canWrite && <Composer contactId={data.contact._id} />}
      {all.length > 0 && <TimelineFilterBar value={filter} onChange={setFilter} />}
      {all.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      ) : entries.length === 0 ? (
        <p className="text-muted-foreground text-sm" role="status">
          {t("noMatch")}
        </p>
      ) : (
        <ol className="flex flex-col gap-2" aria-label={t("composer")}>
          {entries.map((e) =>
            "manual" in e ? (
              <li key={e.key} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{ACTIVITY_KIND_LABELS[e.manual.kind]}</Badge>
                    <time className="text-muted-foreground">{formatDateTime(e.at)}</time>
                    {e.manual.editedAt && <span className="text-muted-foreground">({t("edited")})</span>}
                    {e.manual.kind === "task" && e.manual.dueAt && (
                      <span className={cn(e.manual.doneAt ? "text-muted-foreground line-through" : "")}>
                        {t("due", { date: formatDateTime(e.manual.dueAt).split(",")[0] ?? "" })}
                      </span>
                    )}
                    {e.manual.doneAt && (
                      <Badge variant="outline">
                        <CheckIcon aria-hidden="true" />
                        {t("doneAt")}
                      </Badge>
                    )}
                  </span>
                  {canWrite && (
                    <span className="flex gap-1">
                      {e.manual.kind === "task" && (
                        <Button
                          variant="ghost"
                          className="h-11 md:h-8"
                          onClick={() => void run(() => setDone({ activityId: e.manual._id, done: !e.manual.doneAt }))}
                        >
                          {e.manual.doneAt ? t("reopen") : t("done")}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        className="h-11 text-danger md:h-8"
                        onClick={() => void run(() => remove({ activityId: e.manual._id }), t("removed"))}
                      >
                        {t("remove")}
                      </Button>
                    </span>
                  )}
                </div>
                {e.manual.text && <p className="mt-2 whitespace-pre-wrap">{e.manual.text}</p>}
              </li>
            ) : (
              <li key={e.key} className="rounded-lg border border-dashed p-3 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{t("derived")}</Badge>
                  <time className="text-muted-foreground">{formatDateTime(e.at)}</time>
                </span>
                <p className="mt-2">{e.derived.text}</p>
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}

function Composer({ contactId }: { contactId: Id<"contacts"> }) {
  const t = useTranslations("contacts.timeline");
  const run = useRun();
  const add = useMutation(api.contacts.addActivity);
  const form = useZodForm(activitySchema, { kind: "note", text: "", dueOn: "" });
  const kind = useWatch({ control: form.control, name: "kind" });
  const textId = useId();
  const dueId = useId();
  const submit = form.handleSubmit(async () => {
    const r = await run(() => add({ contactId, values: form.getValues() }), t("added"));
    if (r.ok) form.reset({ kind: form.getValues("kind"), text: "", dueOn: "" });
  });
  const textError = form.formState.errors.text?.message;
  const dueError = form.formState.errors.dueOn?.message;
  return (
    <form
      noValidate
      onSubmit={submit}
      aria-label={t("composer")}
      className="@container/form flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="grid gap-3 @lg/form:grid-cols-[12rem_1fr]">
        <SelectField
          form={form}
          name="kind"
          label={t("kind")}
          options={ACTIVITY_KINDS.map((k) => ({ value: k, label: ACTIVITY_KIND_LABELS[k] }))}
        />
        {kind === "task" && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={dueId} className="font-medium text-sm">
              {t("dueOn")}
            </label>
            <input
              id={dueId}
              type="date"
              aria-invalid={dueError ? true : undefined}
              aria-describedby={dueError ? `${dueId}-e` : undefined}
              className="h-11 rounded-md border border-input bg-background px-2.5 text-base md:h-9 md:text-sm dark:bg-input/30"
              {...form.register("dueOn")}
            />
            {dueError && (
              <p id={`${dueId}-e`} className="text-danger text-sm">
                {dueError}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={textId} className="font-medium text-sm">
          {t("text")}
        </label>
        <Textarea
          id={textId}
          rows={3}
          aria-invalid={textError ? true : undefined}
          aria-describedby={textError ? `${textId}-e` : undefined}
          {...form.register("text")}
        />
        {textError && (
          <p id={`${textId}-e`} className="text-danger text-sm">
            {textError}
          </p>
        )}
      </div>
      <div className="flex justify-end">
        <Button type="submit" className="h-11 md:h-9" disabled={form.formState.isSubmitting}>
          {t("add")}
        </Button>
      </div>
    </form>
  );
}
