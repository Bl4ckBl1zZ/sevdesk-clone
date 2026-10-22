"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { formatDate, todayBerlin, useRun } from "@/components/catalog/shared";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agreementIssues, agreementValidOn, type SelfBillingAgreement } from "@/domain/documents/self-billing";
import type { ContactBundle } from "./contact-detail";

/**
 * „Gutschriftsvereinbarung“ on a supplier contact (F04 §4.9 step 1, INV-16, UST-33): agreed on, scope, valid
 * from/to, the supplier's KU status and payout IBAN. A valid agreement unlocks „Gutschrift erstellen“.
 */
export function SelfBillingAgreementCard({ data, canWrite }: { data: ContactBundle; canWrite: boolean }) {
  const t = useTranslations("selfBilling");
  const save = useMutation(api.contacts.setSelfBillingAgreement);
  const run = useRun();
  const c = data.contact;
  if (!c.roles.includes("supplier")) return null;
  return (
    <SelfBillingAgreementForm
      contactId={c._id}
      agreement={c.selfBillingAgreement ?? null}
      canWrite={canWrite && c.status !== "archived"}
      today={todayBerlin()}
      onSave={async (agreement) => {
        // The uploaded agreement document stays attached when the terms are edited.
        const file = c.selfBillingAgreement?.file;
        const value = agreement && file ? { ...agreement, file } : agreement;
        return (await run(() => save({ id: c._id, agreement: value }), t("agreementSaved"))).ok;
      }}
    />
  );
}

type Stored = SelfBillingAgreement & { iban?: string };

export function SelfBillingAgreementForm({
  contactId,
  agreement,
  canWrite,
  today,
  onSave,
}: {
  contactId: string;
  agreement: Stored | null;
  canWrite: boolean;
  today: string;
  onSave: (agreement: Stored | null) => Promise<boolean>;
}) {
  const t = useTranslations("selfBilling");
  const headingId = useId();
  const ids = { agreedOn: useId(), scope: useId(), from: useId(), to: useId(), ku: useId(), iban: useId() };
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState({
    agreedOn: agreement?.agreedOn ?? today,
    scope: agreement?.scope ?? "",
    validFrom: agreement?.validFrom ?? today,
    validTo: agreement?.validTo ?? "",
    supplierKleinunternehmer: agreement?.supplierKleinunternehmer === true,
    iban: agreement?.iban ?? "",
  });
  const value: Stored = {
    agreedOn: v.agreedOn,
    scope: v.scope,
    validFrom: v.validFrom,
    ...(v.validTo ? { validTo: v.validTo } : {}),
    ...(v.supplierKleinunternehmer ? { supplierKleinunternehmer: true } : {}),
    ...(v.iban.trim() ? { iban: v.iban.trim() } : {}),
  };
  const issues = agreementIssues(value);
  const valid = agreementValidOn(agreement, today);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="font-semibold text-base">
          {t("agreementTitle")}
        </h2>
        {valid && canWrite && (
          <Link
            href={`/rechnungen/neu?typ=gutschrift&kontakt=${contactId}` as Route}
            className={buttonVariants({ className: "h-11 md:h-9" })}
          >
            {t("create")}
          </Link>
        )}
      </div>
      <p className="text-muted-foreground">{t("agreementHint")}</p>
      {agreement && !editing && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">{t("agreedOn")}</dt>
          <dd>{formatDate(agreement.agreedOn)}</dd>
          <dt className="text-muted-foreground">{t("scope")}</dt>
          <dd>{agreement.scope}</dd>
          <dt className="text-muted-foreground">{t("validity")}</dt>
          <dd>
            {formatDate(agreement.validFrom)} – {agreement.validTo ? formatDate(agreement.validTo) : t("openEnded")}
          </dd>
          {agreement.supplierKleinunternehmer && (
            <>
              <dt className="text-muted-foreground">{t("supplierKu")}</dt>
              <dd>{t("yes")}</dd>
            </>
          )}
          {agreement.iban && (
            <>
              <dt className="text-muted-foreground">{t("iban")}</dt>
              <dd>{agreement.iban}</dd>
            </>
          )}
        </dl>
      )}
      {agreement && !valid && !editing && (
        <p role="status" className="text-warning">
          {t("notValidToday")}
        </p>
      )}
      {!agreement && !editing && <p>{t("none")}</p>}
      {canWrite && !editing && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="h-11 md:h-9" onClick={() => setEditing(true)}>
            {agreement ? t("edit") : t("add")}
          </Button>
          {agreement && (
            <Button variant="outline" className="h-11 text-danger md:h-9" onClick={() => void onSave(null)}>
              {t("remove")}
            </Button>
          )}
        </div>
      )}
      {editing && (
        <form
          className="@container/form flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (issues.length > 0) return;
            if (await onSave(value)) setEditing(false);
          }}
        >
          <div className="grid gap-3 @md/form:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.agreedOn} className="font-medium">
                {t("agreedOn")}
              </label>
              <Input
                id={ids.agreedOn}
                type="date"
                value={v.agreedOn}
                onChange={(e) => setV({ ...v, agreedOn: e.target.value })}
                className="h-11 md:h-9"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.from} className="font-medium">
                {t("validFrom")}
              </label>
              <Input
                id={ids.from}
                type="date"
                value={v.validFrom}
                onChange={(e) => setV({ ...v, validFrom: e.target.value })}
                className="h-11 md:h-9"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.to} className="font-medium">
                {t("validTo")}
              </label>
              <Input
                id={ids.to}
                type="date"
                value={v.validTo}
                onChange={(e) => setV({ ...v, validTo: e.target.value })}
                className="h-11 md:h-9"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.scope} className="font-medium">
              {t("scope")}
            </label>
            <Textarea
              id={ids.scope}
              value={v.scope}
              placeholder={t("scopePlaceholder")}
              onChange={(e) => setV({ ...v, scope: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.iban} className="font-medium">
              {t("iban")}
            </label>
            <Input
              id={ids.iban}
              value={v.iban}
              autoComplete="off"
              onChange={(e) => setV({ ...v, iban: e.target.value })}
              className="h-11 md:h-9"
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={ids.ku}
              checked={v.supplierKleinunternehmer}
              onCheckedChange={(checked) => setV({ ...v, supplierKleinunternehmer: checked === true })}
            />
            <label htmlFor={ids.ku}>{t("supplierKuLabel")}</label>
          </div>
          {issues.length > 0 && (
            <ul role="alert" className="list-disc pl-5 text-danger">
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="h-11 md:h-9" disabled={issues.length > 0}>
              {t("save")}
            </Button>
            <Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => setEditing(false)}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
