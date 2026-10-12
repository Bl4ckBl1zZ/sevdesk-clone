"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { type UseFormReturn, useFieldArray, useWatch } from "react-hook-form";
import { CheckboxField, FormErrorSummary, SelectField, TextField } from "@/components/forms/fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fieldsFor, footerDelta, LEGAL_FORMS } from "@/domain/company/legal-forms";
import { type CompanyValues, companySchema } from "@/domain/schemas/settings";
import { countryOptions } from "../countries";
import { useZodForm } from "../use-zod-form";

type CompanyForm = UseFormReturn<CompanyValues, unknown, CompanyValues>;

import type { COMPANY_SECTIONS } from "../sections";

/**
 * Company profile form (F01 SET-011, SET-015, SET-016; §6.2 step 6, §6.3). The legal form comes first; the
 * register/representative fields appear with it and the live footer preview lists missing mandatory items.
 */
export function CompanyForm({
  id,
  defaultValues,
  onValid,
  withSectionIds = false,
}: {
  id: string;
  defaultValues: CompanyValues;
  onValid: (values: CompanyValues) => Promise<void> | void;
  /** Settings page: sections get ids for the in-page tab navigation. */
  withSectionIds?: boolean;
}) {
  const t = useTranslations("setup.company");
  const tTabs = useTranslations("settings.tabs");
  const form = useZodForm(companySchema, defaultValues) as CompanyForm;
  const legalForm = useWatch({ control: form.control, name: "legalForm" });
  const f = fieldsFor(legalForm);
  const sectionId = (s: (typeof COMPANY_SECTIONS)[number]) => (withSectionIds ? `abschnitt-${s}` : undefined);

  return (
    <form id={id} noValidate onSubmit={form.handleSubmit(onValid)} className="@container/form flex flex-col gap-8">
      <FormErrorSummary form={form} />
      <section aria-labelledby="company-general" id={sectionId("allgemein")} className="flex flex-col gap-4">
        <h2 id="company-general" className="font-semibold text-base">
          {tTabs("allgemein")}
        </h2>
        <SelectField
          form={form}
          name="legalForm"
          label={t("legalForm")}
          required
          options={LEGAL_FORMS.map((lf) => ({ value: lf, label: t(`legalForms.${lf}`) }))}
          description={t(`legalFormHints.${legalForm}`)}
        />
        <LegalFormDelta legalForm={legalForm} />
        <div className="grid gap-4 @lg/form:grid-cols-2">
          <TextField form={form} name="name" label={t("name")} required autoComplete="organization" />
          <TextField form={form} name="tradeName" label={t("tradeName")} />
          <TextField form={form} name="street" label={t("street")} autoComplete="street-address" />
          <TextField form={form} name="poBox" label={t("poBox")} />
          <TextField
            form={form}
            name="postalCode"
            label={t("postalCode")}
            required
            autoComplete="postal-code"
            inputMode="numeric"
          />
          <TextField form={form} name="city" label={t("city")} required autoComplete="address-level2" />
          <SelectField form={form} name="countryCode" label={t("country")} required options={countryOptions()} />
          {f.seat && <TextField form={form} name="seat" label={t("seat")} required placeholder={t("city")} />}
        </div>
      </section>

      {(f.register || f.representatives || f.supervisoryBoard || f.generalPartner) && (
        <section aria-labelledby="company-legal" id={sectionId("rechtliches")} className="flex flex-col gap-4">
          <h2 id="company-legal" className="font-semibold text-base">
            {tTabs("rechtliches")}
          </h2>
          {f.register && (
            <div className="grid gap-4 @lg/form:grid-cols-2">
              <TextField form={form} name="registerCourt" label={t("registerCourt")} required />
              <TextField form={form} name="registerNumber" label={`${t("registerNumber")} (${f.register})`} required />
            </div>
          )}
          {f.representatives && (
            <Representatives form={form} label={t(f.representatives.label)} required={f.representatives.required} />
          )}
          {f.supervisoryBoard && (
            <>
              <CheckboxField form={form} name="hasSupervisoryBoard" label={t("hasSupervisoryBoard")} />
              <SupervisoryChair form={form} alwaysRequired={legalForm === "ag"} />
            </>
          )}
          {f.generalPartner && (
            <Card size="sm">
              <CardHeader>
                <CardTitle>{t("generalPartner")}</CardTitle>
              </CardHeader>
              <CardContent>
                <TextField form={form} name="generalPartnerName" label={t("generalPartnerName")} required />
              </CardContent>
            </Card>
          )}
        </section>
      )}

      <section aria-labelledby="company-contact" id={sectionId("kontakt")} className="flex flex-col gap-4">
        <h2 id="company-contact" className="font-semibold text-base">
          {tTabs("kontakt")}
        </h2>
        <div className="grid gap-4 @lg/form:grid-cols-2">
          <TextField form={form} name="contactName" label={t("contactName")} required autoComplete="name" />
          <TextField form={form} name="phone" label={t("phone")} required type="tel" autoComplete="tel" />
          <TextField form={form} name="email" label={t("email")} required type="email" autoComplete="email" />
          <TextField form={form} name="website" label={t("website")} type="url" placeholder="https://" />
        </div>
      </section>

      <FooterPreview form={form} />
    </form>
  );
}

function SupervisoryChair({ form, alwaysRequired }: { form: CompanyForm; alwaysRequired: boolean }) {
  const t = useTranslations("setup.company");
  const has = useWatch({ control: form.control, name: "hasSupervisoryBoard" });
  if (!has && !alwaysRequired) return null;
  return <TextField form={form} name="supervisoryBoardChair" label={t("supervisoryBoardChair")} required />;
}

function Representatives({ form, label, required }: { form: CompanyForm; label: string; required: boolean }) {
  const t = useTranslations("setup.company");
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "representatives" });
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 font-medium text-sm">
        {label}
        {required && (
          <span aria-hidden="true" className="text-danger">
            {" "}
            *
          </span>
        )}
      </legend>
      {fields.map((field, i) => (
        <div key={field.id} className="flex items-end gap-2">
          <TextField
            form={form}
            name={`representatives.${i}.name`}
            label={`${t("representativeName")} (${i + 1})`}
            className="flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 md:size-9"
            aria-label={t("removeRepresentative", {
              name: form.getValues(`representatives.${i}.name`) || String(i + 1),
            })}
            onClick={() => remove(i)}
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" className="h-11 self-start md:h-9" onClick={() => append({ name: "" })}>
        <PlusIcon aria-hidden="true" />
        {t("addRepresentative")}
      </Button>
    </fieldset>
  );
}

/** Announces "Pflichtangaben im Fußtext: + …" when the legal form changes (F01 SET-013). */
function LegalFormDelta({ legalForm }: { legalForm: string }) {
  const previous = useRef(legalForm);
  const [delta, setDelta] = useState<string[]>([]);
  useEffect(() => {
    if (previous.current !== legalForm) {
      setDelta(footerDelta(previous.current, legalForm));
      previous.current = legalForm;
    }
  }, [legalForm]);
  return (
    <p
      aria-live="polite"
      className={delta.length ? "rounded-md border border-info/30 bg-info/10 p-3 text-info text-sm" : "sr-only"}
    >
      {delta.length ? `Pflichtangaben im Fußtext: ${delta.map((d) => `+ ${d}`).join(", ")}` : ""}
    </p>
  );
}

/** Live Geschäftsbrief footer preview (3 columns, SET-013); the authoritative footer is rendered by the domain. */
function FooterPreview({ form }: { form: CompanyForm }) {
  const t = useTranslations("setup.company");
  const v = useWatch({ control: form.control }) as Partial<CompanyValues>;
  const f = fieldsFor(v.legalForm);
  const missing: string[] = [];
  if (f.register && !v.registerCourt) missing.push(t("registerCourt"));
  if (f.register && !v.registerNumber) missing.push(`${f.register}-${t("registerNumber")}`);
  const reps = (v.representatives ?? []).map((r) => r?.name?.trim()).filter(Boolean) as string[];
  if (f.representatives?.required && reps.length === 0) missing.push(t(f.representatives.label));
  if (f.generalPartner && !v.generalPartnerName) missing.push(t("generalPartner"));
  if ((v.legalForm === "ag" || v.hasSupervisoryBoard) && f.supervisoryBoard && !v.supervisoryBoardChair) {
    missing.push(t("supervisoryBoardChair"));
  }
  const seat = v.seat || v.city;

  return (
    <Card size="sm" aria-labelledby="footer-preview-title">
      <CardHeader>
        <CardTitle id="footer-preview-title">{t("footerPreview")}</CardTitle>
        <CardDescription>{t("footerPreviewHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 text-xs @lg/form:grid-cols-3">
          <div>
            <p className="font-medium">{v.name || "—"}</p>
            {v.tradeName && <p>{v.tradeName}</p>}
            <p>{v.street || v.poBox}</p>
            <p>{[v.postalCode, v.city].filter(Boolean).join(" ")}</p>
            {v.phone && <p>Tel. {v.phone}</p>}
            {v.email && <p>{v.email}</p>}
            {v.website && <p>{v.website}</p>}
          </div>
          <div>
            {v.legalForm && !["einzelunternehmen", "freiberufler", "other"].includes(v.legalForm) && (
              <p>{t(`legalForms.${v.legalForm}`)}</p>
            )}
            {f.seat && seat && <p>Sitz: {seat}</p>}
            {f.register && (v.registerCourt || v.registerNumber) && (
              <p>
                {v.registerCourt} {f.register} {v.registerNumber}
              </p>
            )}
            {f.representatives && reps.length > 0 && (
              <p>
                {t(f.representatives.label)}: {reps.join(", ")}
              </p>
            )}
            {v.supervisoryBoardChair && <p>Vorsitz AR: {v.supervisoryBoardChair}</p>}
            {f.generalPartner && v.generalPartnerName && <p>Komplementärin: {v.generalPartnerName}</p>}
          </div>
          <div className="text-muted-foreground">Bankverbindung</div>
        </div>
        {missing.length > 0 && (
          <p className="text-danger text-sm">{t("footerMissing", { fields: missing.join(", ") })}</p>
        )}
      </CardContent>
    </Card>
  );
}
