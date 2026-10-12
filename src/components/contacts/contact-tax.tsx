"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type * as React from "react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { FormDialog, formatDate, formatDateTime, todayBerlin, useRun } from "@/components/catalog/shared";
import { SelectField, TextField } from "@/components/forms/fields";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CERTIFICATE_MAX_BYTES,
  CERTIFICATE_MIME,
  CONSENT_SOURCE_LABELS,
  CONSENT_SOURCES,
} from "@/domain/contacts/consent";
import { pdfConsentSchema } from "@/domain/schemas/contacts";
import type { ContactBundle } from "./contact-detail";
import { VatBadge } from "./contacts-list";

const PROVIDER_LABELS: Record<string, string> = { bzst_evatr: "BZSt eVatR", eu_vies: "EU VIES" };

/** CON-050…061: check button, badge and the append-only check history with the evidence link. */
export function VatCheckCard({ data, canWrite }: { data: ContactBundle; canWrite: boolean }) {
  const t = useTranslations("contacts.vat");
  const check = useAction(api.vatIdChecks.check);
  const [busy, setBusy] = useState(false);
  const run = useRun();
  const headingId = useId();
  const c = data.contact;
  const doCheck = async (force: boolean) => {
    setBusy(true);
    const r = await run(() => check({ contactId: c._id, force }));
    setBusy(false);
    if (!r.ok) return;
    if (r.value.reused) toast.info(t("reused"));
    else toast.success(t("checked", { message: r.value.message }));
    if (r.value.warning) toast.warning(r.value.warning);
  };
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="font-semibold text-base">
          {t("title")}
        </h2>
        {canWrite && c.vatId && (
          <div className="flex gap-2">
            <Button className="h-11 md:h-9" disabled={busy} onClick={() => void doCheck(false)}>
              {busy ? t("checking") : t("check")}
            </Button>
            {data.checks.length > 0 && (
              <Button variant="outline" className="h-11 md:h-9" disabled={busy} onClick={() => void doCheck(true)}>
                {t("recheck")}
              </Button>
            )}
          </div>
        )}
      </div>
      {c.vatId ? (
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{c.vatId}</span>
          <VatBadge kind={data.vatBadge.kind} text={data.vatBadge.text} />
        </p>
      ) : (
        <p className="text-muted-foreground">{t("noVatId")}</p>
      )}
      <h3 className="font-medium">{t("history")}</h3>
      {data.checks.length === 0 ? (
        <p className="text-muted-foreground">{t("historyEmpty")}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {data.checks.map((x) => (
              <li key={x._id} className="flex flex-col gap-1 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <time>{formatDateTime(x.checkedAt)}</time>
                    <Badge variant="outline">{PROVIDER_LABELS[x.provider] ?? x.provider}</Badge>
                    <span className="font-mono">{x.vatId}</span>
                  </span>
                  <Link href={`/kontakte/${c._id}/nachweis/${x._id}` as Route} className="underline">
                    {t("evidenceLink")}
                  </Link>
                </div>
                <p>{x.message ?? x.status}</p>
                {x.qualified && (
                  <p className="text-muted-foreground">
                    {t("codes")}: {x.qualified.name} / {x.qualified.street} / {x.qualified.postalCode} /{" "}
                    {x.qualified.city}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">{t("legend")}</p>
        </>
      )}
    </section>
  );
}

/** CON-065/066: consent to PDF invoices (append-only; revocation recorded as a date). */
export function ConsentCard({ data, canWrite }: { data: ContactBundle; canWrite: boolean }) {
  const t = useTranslations("contacts.consent");
  const run = useRun();
  const revoke = useMutation(api.contacts.revokePdfConsent);
  const [open, setOpen] = useState<"add" | "revoke" | null>(null);
  const [revokedAt, setRevokedAt] = useState(todayBerlin());
  const headingId = useId();
  const dateId = useId();
  const consents = data.contact.einvoice.pdfConsents;
  const active = consents.find((x) => !x.revokedAt);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="font-semibold text-base">
          {t("title")}
        </h2>
        {canWrite && (
          <div className="flex gap-2">
            {active && (
              <Button variant="outline" className="h-11 md:h-9" onClick={() => setOpen("revoke")}>
                {t("revoke")}
              </Button>
            )}
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setOpen("add")}>
              {t("add")}
            </Button>
          </div>
        )}
      </div>
      {consents.length === 0 ? (
        <p className="text-muted-foreground">{t("none")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {consents.map((x) => (
            <li key={x.recordedAt} className="flex flex-wrap gap-2">
              <span>{CONSENT_SOURCE_LABELS[x.source]}</span>
              <span>
                {x.revokedAt
                  ? t("revokedOn", { date: formatDate(x.revokedAt) })
                  : t("active", { date: formatDate(x.givenAt) })}
              </span>
              {x.note && <span className="text-muted-foreground">— {x.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {open === "add" && <ConsentDialog contactId={data.contact._id} onClose={() => setOpen(null)} />}
      {open === "revoke" && (
        <FormDialog
          title={t("revoke")}
          formId={`${dateId}-form`}
          onClose={() => setOpen(null)}
          submitting={false}
          onSubmit={async (e) => {
            e?.preventDefault();
            const r = await run(() => revoke({ contactId: data.contact._id, revokedAt }), t("revoked"));
            if (r.ok) setOpen(null);
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor={dateId} className="font-medium text-sm">
              {t("revokedAt")}
            </label>
            <Input
              id={dateId}
              type="date"
              className="h-11 md:h-9"
              value={revokedAt}
              onChange={(e) => setRevokedAt(e.target.value)}
            />
          </div>
        </FormDialog>
      )}
    </section>
  );
}

function ConsentDialog({ contactId, onClose }: { contactId: Id<"contacts">; onClose: () => void }) {
  const t = useTranslations("contacts.consent");
  const run = useRun();
  const add = useMutation(api.contacts.addPdfConsent);
  const formId = useId();
  const form = useZodForm(pdfConsentSchema, { givenAt: todayBerlin(), source: "email", note: "" });
  const submit = form.handleSubmit(async () => {
    const r = await run(() => add({ contactId, values: form.getValues() }), t("saved"));
    if (r.ok) onClose();
  });
  return (
    <FormDialog
      title={t("add")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
    >
      <TextField form={form} name="givenAt" label={t("givenAt")} type="date" required />
      <SelectField
        form={form}
        name="source"
        label={t("source")}
        options={CONSENT_SOURCES.map((s) => ({ value: s, label: CONSENT_SOURCE_LABELS[s] }))}
      />
      <TextField form={form} name="note" label={t("note")} description={t("noteHint")} />
    </FormDialog>
  );
}

/** CON-070/071: § 13b certificate USt 1 TG with validity; the history stays (replaced entries are marked). */
export function CertificateCard({ data, canWrite }: { data: ContactBundle; canWrite: boolean }) {
  const t = useTranslations("contacts.certificate");
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const current = data.certificate;
  const history = data.contact.reverseCharge13bCertificates.filter((x) => x.replacedAt !== undefined);
  const expired = current ? current.validUntil < data.today : false;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="font-semibold text-base">
          {t("title")}
        </h2>
        {canWrite && (
          <Button variant="outline" className="h-11 md:h-9" onClick={() => setOpen(true)}>
            {t("add")}
          </Button>
        )}
      </div>
      {current ? (
        <p className="flex flex-wrap items-center gap-2">
          {t("current", { date: formatDate(current.validUntil) })}
          {expired && <Badge variant="destructive">{t("expired")}</Badge>}
          {current.file && <span className="text-muted-foreground">({current.file.name})</span>}
        </p>
      ) : (
        <p className="text-muted-foreground">{t("none")}</p>
      )}
      {history.length > 0 && (
        <>
          <h3 className="font-medium">{t("history")}</h3>
          <ul className="flex flex-col gap-1 text-muted-foreground">
            {history.map((x) => (
              <li key={x.addedAt}>
                {formatDate(x.validUntil)} · {t("replaced")}
              </li>
            ))}
          </ul>
        </>
      )}
      {open && <CertificateDialog contactId={data.contact._id} onClose={() => setOpen(false)} />}
    </section>
  );
}

function CertificateDialog({ contactId, onClose }: { contactId: Id<"contacts">; onClose: () => void }) {
  const t = useTranslations("contacts.certificate");
  const run = useRun();
  const uploadUrl = useMutation(api.contacts.generateUploadUrl);
  const add = useMutation(api.contacts.addCertificate);
  const formId = useId();
  const dateId = useId();
  const fileId = useId();
  const [validUntil, setValidUntil] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e?: React.BaseSyntheticEvent) => {
    e?.preventDefault();
    if (
      file &&
      (!CERTIFICATE_MIME.includes(file.type as (typeof CERTIFICATE_MIME)[number]) || file.size > CERTIFICATE_MAX_BYTES)
    ) {
      setError(t("file"));
      return;
    }
    setBusy(true);
    const r = await run(async () => {
      let storageId: Id<"_storage"> | undefined;
      if (file) {
        const url = await uploadUrl({});
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": file.type }, body: file });
        storageId = ((await res.json()) as { storageId: Id<"_storage"> }).storageId;
      }
      return add({ contactId, validUntil, ...(storageId ? { storageId, fileName: file?.name } : {}) });
    }, t("saved"));
    setBusy(false);
    if (r.ok) {
      for (const w of r.value.warnings) toast.warning(w);
      onClose();
    }
  };
  return (
    <FormDialog title={t("add")} formId={formId} onClose={onClose} onSubmit={submit} submitting={busy}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={dateId} className="font-medium text-sm">
          {t("validUntil")}
        </label>
        <Input
          id={dateId}
          type="date"
          required
          className="h-11 md:h-9"
          value={validUntil}
          onChange={(e) => setValidUntil(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fileId} className="font-medium text-sm">
          {t("file")}
        </label>
        <Input
          id={fileId}
          type="file"
          accept={CERTIFICATE_MIME.join(",")}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fileId}-e` : undefined}
          onChange={(e) => {
            setError(null);
            setFile(e.target.files?.[0] ?? null);
          }}
        />
        {error && (
          <p id={`${fileId}-e`} className="text-danger text-sm">
            {error}
          </p>
        )}
      </div>
    </FormDialog>
  );
}
