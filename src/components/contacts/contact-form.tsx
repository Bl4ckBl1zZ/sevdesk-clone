"use client";

import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useId, useState } from "react";
import { Controller, type UseFormReturn, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { COUNTRY_OPTIONS } from "@/components/catalog/countries";
import { CustomFieldsEditor, TagPicker } from "@/components/catalog/custom-fields";
import { FormSection, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { CheckboxField, FormErrorSummary, SelectField, TextField } from "@/components/forms/fields";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CONTACT_ROLES, ROLE_LABELS, SALUTATION_LABELS, SALUTATIONS } from "@/domain/contacts/core";
import { DUPLICATE_REASON_LABELS } from "@/domain/contacts/duplicates";
import { EINVOICE_FORMAT_LABELS, EINVOICE_FORMATS, ELECTRONIC_ADDRESS_SCHEMES } from "@/domain/contacts/tax";
import { CURRENCY_CODES } from "@/domain/money/currencies";
import {
  type ContactCreateFormValues,
  type ContactFormValues,
  contactCreateSchema,
  contactFormFromRecord,
  emptyAddress,
  emptyContactForm,
} from "@/domain/schemas/contacts";
import { SELECTABLE_TAX_CASES, TAX_CASE_LABELS } from "@/domain/tax/tax-case";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * Contact form (F02 §6.4): create (with billing address and channels) and the Stammdaten tab (core, tax, e-invoice,
 * payment, accounting). Validation is the shared `contactCreateSchema`; the server re-validates with context.
 */
type Form = UseFormReturn<ContactCreateFormValues>;

const SCHEME_LABELS: Record<string, string> = {
  EM: "E-Mail (EM)",
  "0204": "Leitweg-ID (0204)",
  "9930": "USt-IdNr (9930)",
};

/** Form values of an existing contact (the Stammdaten tab edits these; shared with REST/MCP). */
export const formFromContact = (c: Doc<"contacts">): ContactFormValues => contactFormFromRecord(c);

export function ContactForm(props: { contact?: Doc<"contacts">; defaultParentId?: string }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <ContactFormInner {...props} />
    </ConvexGuard>
  );
}

function ContactFormInner({ contact, defaultParentId }: { contact?: Doc<"contacts">; defaultParentId?: string }) {
  const t = useTranslations("contacts.form");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const run = useRun();
  const create = useMutation(api.contacts.create);
  const update = useMutation(api.contacts.update);
  const formId = useId();
  const editing = contact !== undefined;
  const base = contact
    ? formFromContact(contact)
    : { ...emptyContactForm(), ...(defaultParentId ? { kind: "person" as const, parentId: defaultParentId } : {}) };
  const form = useZodForm(contactCreateSchema, {
    contact: base,
    billingAddress: emptyAddress(),
    channels: [
      { type: "email", value: "", label: "", isPrimary: true, isInvoiceEmail: true },
      { type: "phone", value: "", label: "", isPrimary: true, isInvoiceEmail: false },
      { type: "mobile", value: "", label: "", isPrimary: true, isInvoiceEmail: false },
      { type: "web", value: "", label: "", isPrimary: true, isInvoiceEmail: false },
    ],
  }) as unknown as Form;
  const [warnings, setWarnings] = useState<string[]>([]);

  const submit = form.handleSubmit(async () => {
    const raw = form.getValues();
    if (editing && contact) {
      const r = await run(() => update({ id: contact._id, version: contact.version, values: raw.contact }), t("saved"));
      if (r.ok) setWarnings(r.value.warnings);
      return;
    }
    const r = await run(() => create({ values: raw }));
    if (r.ok) {
      toast.success(t("created", { number: r.value.number }));
      if (r.value.warnings.length) toast.warning(r.value.warnings.join(" "));
      router.push(`/kontakte/${r.value.id}` as Route);
    }
  });

  const kind = useWatch({ control: form.control, name: "contact.kind" });

  return (
    <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4 pb-24 md:pb-0">
      <FormErrorSummary form={form} />
      <FormSection title={t("sections.type")}>
        <fieldset className="flex flex-col gap-2 @lg/form:col-span-2">
          <legend className="mb-1 font-medium text-sm">{t("kind")}</legend>
          <div className="flex flex-wrap gap-2">
            {(["organization", "person"] as const).map((k) => (
              <label
                key={k}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 has-checked:border-primary has-checked:bg-primary/5 md:min-h-9"
              >
                <input
                  type="radio"
                  value={k}
                  className="size-5 accent-primary md:size-4"
                  {...form.register("contact.kind")}
                />
                {t(`kinds.${k}`)}
              </label>
            ))}
          </div>
        </fieldset>
        {kind === "person" && <ParentSelect form={form} self={contact?._id} />}
      </FormSection>

      <FormSection title={t("sections.name")}>
        {kind === "organization" ? (
          <>
            <TextField
              form={form}
              name="contact.organizationName"
              label={t("organizationName")}
              required
              autoComplete="organization"
            />
            <TextField form={form} name="contact.organizationName2" label={t("organizationName2")} />
          </>
        ) : (
          <>
            <SelectField
              form={form}
              name="contact.salutation"
              label={t("salutation")}
              placeholder={t("salutationNone")}
              options={SALUTATIONS.filter((s) => s !== "none").map((s) => ({ value: s, label: SALUTATION_LABELS[s] }))}
            />
            <TextField form={form} name="contact.academicTitle" label={t("academicTitle")} />
            <TextField form={form} name="contact.firstName" label={t("firstName")} autoComplete="given-name" />
            <TextField form={form} name="contact.lastName" label={t("lastName")} required autoComplete="family-name" />
            <TextField form={form} name="contact.position" label={t("position")} />
            <TextField form={form} name="contact.birthday" label={t("birthday")} type="date" />
          </>
        )}
        <DuplicateHints form={form} self={contact?._id} />
      </FormSection>

      <FormSection title={t("sections.roles")}>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium text-sm">
            {t("roles")}
            <span aria-hidden="true" className="text-danger">
              {" "}
              *
            </span>
          </legend>
          <div className="flex flex-wrap gap-3">
            {CONTACT_ROLES.map((r) => (
              <label key={r} className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
                <input
                  type="checkbox"
                  value={r}
                  className="size-5 accent-primary md:size-4"
                  {...form.register("contact.roles")}
                />
                {ROLE_LABELS[r]}
              </label>
            ))}
          </div>
          {form.formState.errors.contact?.roles?.message && (
            <p className="text-danger text-sm">{form.formState.errors.contact.roles.message}</p>
          )}
        </fieldset>
        <SelectField
          form={form}
          name="contact.status"
          label={t("status")}
          options={(["lead", "active"] as const).map((s) => ({ value: s, label: t(`statuses.${s}`) }))}
        />
        <NumberField form={form} editing={editing} />
      </FormSection>

      <FormSection title={t("sections.customerType")}>
        <CustomerType form={form} />
      </FormSection>

      {!editing && (
        <>
          <FormSection title={t("sections.address")}>
            <TextField
              form={form}
              name="billingAddress.name"
              label={t("addressName")}
              description={t("addressNameHint")}
            />
            <TextField form={form} name="billingAddress.department" label={t("department")} />
            <TextField form={form} name="billingAddress.street" label={t("street")} autoComplete="address-line1" />
            <TextField form={form} name="billingAddress.street2" label={t("street2")} autoComplete="address-line2" />
            <TextField
              form={form}
              name="billingAddress.postalCode"
              label={t("postalCode")}
              autoComplete="postal-code"
              inputMode="numeric"
            />
            <TextField form={form} name="billingAddress.city" label={t("city")} autoComplete="address-level2" />
            <SelectField form={form} name="billingAddress.countryCode" label={t("country")} options={COUNTRY_OPTIONS} />
            <TextField form={form} name="billingAddress.poBox" label={t("poBox")} />
          </FormSection>
          <FormSection title={t("sections.communication")}>
            <TextField form={form} name="channels.0.value" label={t("email")} type="email" autoComplete="email" />
            <CheckboxField
              form={form}
              name="channels.0.isInvoiceEmail"
              label={t("invoiceEmail")}
              className="self-end"
            />
            <TextField form={form} name="channels.1.value" label={t("phone")} type="tel" autoComplete="tel" />
            <TextField form={form} name="channels.2.value" label={t("mobile")} type="tel" />
            <TextField form={form} name="channels.3.value" label={t("web")} type="url" />
          </FormSection>
        </>
      )}

      <FormSection title={t("sections.tax")}>
        <TextField
          form={form}
          name="contact.vatId"
          label={t("vatId")}
          description={t("vatIdHint")}
          autoCapitalize="characters"
          spellCheck={false}
        />
        <TextField form={form} name="contact.taxNumber" label={t("taxNumber")} description={t("taxNumberHint")} />
        <SelectField
          form={form}
          name="contact.defaultTaxCase"
          label={t("defaultTaxCase")}
          description={t("defaultTaxCaseHint")}
          placeholder={t("defaultTaxCaseNone")}
          options={SELECTABLE_TAX_CASES.filter((c) => c !== "kleinunternehmer").map((c) => ({
            value: c,
            label: TAX_CASE_LABELS[c],
          }))}
        />
      </FormSection>

      <FormSection title={t("sections.einvoice")}>
        <SelectField
          form={form}
          name="contact.preferredFormat"
          label={t("preferredFormat")}
          options={EINVOICE_FORMATS.map((f) => ({ value: f, label: EINVOICE_FORMAT_LABELS[f] }))}
        />
        <TextField
          form={form}
          name="contact.buyerReference"
          label={t("buyerReference")}
          description={t("buyerReferenceHint")}
          spellCheck={false}
        />
        <SelectField
          form={form}
          name="contact.electronicAddressScheme"
          label={t("electronicAddressScheme")}
          placeholder={t("electronicAddressSchemeNone")}
          options={ELECTRONIC_ADDRESS_SCHEMES.map((s) => ({ value: s, label: SCHEME_LABELS[s] ?? s }))}
        />
        <TextField
          form={form}
          name="contact.electronicAddressValue"
          label={t("electronicAddressValue")}
          spellCheck={false}
        />
      </FormSection>

      <FormSection title={t("sections.payment")}>
        <TextField
          form={form}
          name="contact.dueDays"
          label={t("dueDays")}
          description={t("dueDaysHint")}
          inputMode="numeric"
        />
        <TextField form={form} name="contact.skontoPercent" label={t("skontoPercent")} inputMode="decimal" />
        <TextField form={form} name="contact.skontoDays" label={t("skontoDays")} inputMode="numeric" />
        <TextField form={form} name="contact.defaultDiscount" label={t("defaultDiscount")} inputMode="decimal" />
        <TextField
          form={form}
          name="contact.paymentTermsText"
          label={t("paymentTermsText")}
          className="@lg/form:col-span-2"
        />
        <PaymentMethodSelect form={form} />
        <SelectField
          form={form}
          name="contact.currency"
          label={t("currency")}
          options={CURRENCY_CODES.map((c) => ({ value: c, label: c }))}
        />
        <SelectField
          form={form}
          name="contact.language"
          label={t("language")}
          options={(["de", "en"] as const).map((l) => ({ value: l, label: t(`languages.${l}`) }))}
        />
        <TextField form={form} name="contact.iban" label={t("iban")} autoCapitalize="characters" spellCheck={false} />
        <TextField form={form} name="contact.bic" label={t("bic")} autoCapitalize="characters" spellCheck={false} />
      </FormSection>

      <FormSection title={t("sections.accounting")}>
        <TextField
          form={form}
          name="contact.debtorAccount"
          label={t("debtorAccount")}
          description={t("accountHint")}
          inputMode="numeric"
        />
        <TextField
          form={form}
          name="contact.creditorAccount"
          label={t("creditorAccount")}
          description={t("accountHint")}
          inputMode="numeric"
        />
        <CheckboxField form={form} name="contact.useCollectiveDebtor" label={t("useCollectiveDebtor")} />
      </FormSection>

      <FormSection title={t("sections.more")}>
        <Controller
          control={form.control}
          name="contact.tags"
          render={({ field }) => <TagPicker legend={t("tags")} value={field.value} onChange={field.onChange} />}
        />
        <Controller
          control={form.control}
          name="contact.customFields"
          render={({ field }) => <CustomFieldsEditor entity="contact" value={field.value} onChange={field.onChange} />}
        />
        <NotesField form={form} />
      </FormSection>

      {warnings.length > 0 && (
        <section aria-label={t("warnings")} className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <ul className="list-disc pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex gap-2 border-t bg-background p-3 *:flex-1 md:static md:z-auto md:justify-end md:border-0 md:bg-transparent md:p-0 md:*:flex-none">
        <Button type="submit" className="h-11 md:h-9" disabled={form.formState.isSubmitting}>
          {editing ? tCommon("save") : t("create")}
        </Button>
      </div>
    </form>
  );
}

function NotesField({ form }: { form: Form }) {
  const t = useTranslations("contacts.form");
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5 @lg/form:col-span-2">
      <label htmlFor={id} className="font-medium text-sm">
        {t("notes")}
      </label>
      <Textarea id={id} rows={4} aria-describedby={`${id}-hint`} {...form.register("contact.notes")} />
      <p id={`${id}-hint`} className="text-muted-foreground text-sm">
        {t("notesHint")}
      </p>
    </div>
  );
}

function NumberField({ form, editing }: { form: Form; editing: boolean }) {
  const t = useTranslations("contacts.form");
  const preview = useAuthedQuery(api.contacts.nextNumber, {}, !editing);
  const description = editing
    ? undefined
    : preview
      ? t("numberAuto", { preview })
      : preview === null
        ? t("numberAutoNoRange")
        : undefined;
  return (
    <TextField form={form} name="contact.number" label={t("number")} description={description} spellCheck={false} />
  );
}

function CustomerType({ form }: { form: Form }) {
  const t = useTranslations("contacts.form");
  const isConsumer = useWatch({ control: form.control, name: "contact.isConsumer" });
  const isAuthority = useWatch({ control: form.control, name: "contact.isPublicAuthority" });
  const current = isConsumer ? "b2c" : isAuthority ? "b2g" : "b2b";
  const name = useId();
  const set = (v: "b2b" | "b2c" | "b2g") => {
    form.setValue("contact.isConsumer", v === "b2c", { shouldDirty: true });
    form.setValue("contact.isPublicAuthority", v === "b2g", { shouldDirty: true });
    if (v === "b2g" && form.getValues("contact.preferredFormat") === "pdf")
      form.setValue("contact.preferredFormat", "auto");
  };
  return (
    <fieldset className="flex flex-col gap-2 @lg/form:col-span-2">
      <legend className="mb-1 font-medium text-sm">{t("customerType")}</legend>
      <div className="grid gap-2 @lg/form:grid-cols-3">
        {(["b2b", "b2c", "b2g"] as const).map((v) => (
          <label
            key={v}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
          >
            <input
              type="radio"
              name={name}
              value={v}
              checked={current === v}
              onChange={() => set(v)}
              className="mt-0.5 size-5 shrink-0 accent-primary md:size-4"
              aria-describedby={`${name}-${v}-hint`}
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm">{t(`customerTypes.${v}`)}</span>
              <span id={`${name}-${v}-hint`} className="text-muted-foreground text-xs">
                {t(`customerTypeHints.${v}`)}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ParentSelect({ form, self }: { form: Form; self?: Id<"contacts"> }) {
  const t = useTranslations("contacts.form");
  const current = useWatch({ control: form.control, name: "contact.parentId" });
  const options = useAuthedQuery(api.contacts.options, { kind: "organization" }) ?? [];
  const currentOption = useAuthedQuery(
    api.contacts.get,
    { id: current as Id<"contacts"> },
    Boolean(current) && !options.some((o) => o._id === current),
  );
  const list = [...options];
  if (currentOption && !list.some((o) => o._id === currentOption.contact._id)) {
    list.push({
      _id: currentOption.contact._id,
      number: currentOption.contact.number,
      displayName: currentOption.contact.displayName,
      kind: "organization",
    });
  }
  return (
    <SelectField
      form={form}
      name="contact.parentId"
      label={t("parent")}
      placeholder={t("parentNone")}
      options={list
        .filter((o) => o._id !== self)
        .map((o) => ({ value: o._id, label: `${o.displayName} (${o.number})` }))}
    />
  );
}

function PaymentMethodSelect({ form }: { form: Form }) {
  const t = useTranslations("contacts.form");
  const methods = useAuthedQuery(api.lookups.listPaymentMethods, {}) ?? [];
  return (
    <SelectField
      form={form}
      name="contact.paymentMethodId"
      label={t("paymentMethod")}
      placeholder={t("paymentMethodNone")}
      options={methods.filter((m) => m.active).map((m) => ({ value: m.paymentMethodId, label: m.name }))}
    />
  );
}

/** CON-130: non-blocking hints while typing (same VAT ID / invoice e-mail / IBAN / similar name + postcode). */
function DuplicateHints({ form, self }: { form: Form; self?: Id<"contacts"> }) {
  const t = useTranslations("contacts.form");
  const v = useWatch({ control: form.control });
  const c = v.contact ?? {};
  const displayName =
    c.kind === "organization" ? (c.organizationName ?? "") : [c.firstName, c.lastName].filter(Boolean).join(" ");
  const args = useDeferredValue({
    ...(self ? { id: self } : {}),
    displayName,
    ...(c.vatId ? { vatId: c.vatId } : {}),
    ...(v.channels?.[0]?.value ? { email: v.channels[0].value } : {}),
    ...(c.iban ? { iban: c.iban } : {}),
    ...(v.billingAddress?.postalCode ? { postalCode: v.billingAddress.postalCode } : {}),
  });
  const enabled = displayName.length > 2 || Boolean(c.vatId) || Boolean(c.iban);
  const hints = useAuthedQuery(api.contacts.duplicateHints, args, enabled) ?? [];
  if (!enabled || hints.length === 0) return null;
  return (
    <div role="status" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm @lg/form:col-span-2">
      <p className="font-medium">{t("duplicateHint")}</p>
      <ul className="mt-1 flex flex-col gap-1">
        {hints.map((h) => (
          <li key={h.id}>
            {h.displayName} ({h.number}) —{" "}
            {h.reasons.map((r) => DUPLICATE_REASON_LABELS[r as keyof typeof DUPLICATE_REASON_LABELS]).join(", ")} —{" "}
            <Link href={`/kontakte/${h.id}` as Route} className="underline">
              {t("open")}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
