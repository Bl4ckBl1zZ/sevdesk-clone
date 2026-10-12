"use client";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { COUNTRY_OPTIONS } from "@/components/catalog/countries";
import { FormDialog, useRun } from "@/components/catalog/shared";
import { CheckboxField, SelectField, TextField } from "@/components/forms/fields";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ADDRESS_TYPES, formatAddressLine } from "@/domain/contacts/address";
import { CHANNEL_TYPES, telHref } from "@/domain/contacts/channels";
import { addressSchema, channelSchema, emptyAddress } from "@/domain/schemas/contacts";
import type { ContactBundle } from "./contact-detail";

/** Addresses (CON-020…026) and communication channels (CON-030…033) of a contact. */
export function AddressesCard({ data, canWrite }: { data: ContactBundle; canWrite: boolean }) {
  const t = useTranslations("contacts.addresses");
  const run = useRun();
  const remove = useMutation(api.contacts.removeAddress);
  const [editing, setEditing] = useState<Doc<"contactAddresses"> | "new" | null>(null);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="font-semibold text-base">
          {t("title")}
        </h2>
        {canWrite && (
          <Button variant="outline" className="h-11 md:h-9" onClick={() => setEditing("new")}>
            <PlusIcon aria-hidden="true" />
            {t("add")}
          </Button>
        )}
      </div>
      {data.addresses.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      ) : (
        <ul className="grid gap-3 @lg/detail:grid-cols-2">
          {data.addresses.map((a) => (
            <li key={a._id} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t(`types.${a.type}`)}</span>
                {a.isDefault && <Badge variant="secondary">{t("default")}</Badge>}
              </div>
              <address className="whitespace-pre-line not-italic">
                {[a.address.name, a.address.name2, a.address.department, formatAddressLine(a.address)]
                  .filter(Boolean)
                  .join("\n")}
              </address>
              {canWrite && (
                <div className="flex gap-1">
                  <Button variant="ghost" className="h-11 md:h-8" onClick={() => setEditing(a)}>
                    {t("edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-11 text-danger md:h-8"
                    onClick={() => void run(() => remove({ addressId: a._id }), t("removed"))}
                  >
                    {t("remove")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <AddressDialog
          contactId={data.contact._id}
          address={editing === "new" ? undefined : editing}
          firstOfType={(type) => !data.addresses.some((a) => a.type === type)}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function AddressDialog({
  contactId,
  address,
  firstOfType,
  onClose,
}: {
  contactId: Doc<"contacts">["_id"];
  address?: Doc<"contactAddresses">;
  firstOfType: (type: string) => boolean;
  onClose: () => void;
}) {
  const t = useTranslations("contacts.addresses");
  const tf = useTranslations("contacts.form");
  const run = useRun();
  const save = useMutation(api.contacts.saveAddress);
  const formId = useId();
  const a = address?.address;
  const form = useZodForm(addressSchema, {
    type: address?.type ?? (firstOfType("billing") ? "billing" : "delivery"),
    isDefault: address?.isDefault ?? true,
    ...emptyAddress(),
    ...(a
      ? {
          name: a.name,
          name2: a.name2 ?? "",
          department: a.department ?? "",
          street: a.street,
          street2: a.street2 ?? "",
          postalCode: a.postalCode,
          city: a.city,
          countryCode: a.countryCode,
          poBox: a.poBox ?? "",
        }
      : {}),
  });
  const submit = form.handleSubmit(async () => {
    const r = await run(
      () => save({ contactId, ...(address ? { addressId: address._id } : {}), values: form.getValues() }),
      t("saved"),
    );
    if (r.ok) onClose();
  });
  return (
    <FormDialog
      title={address ? t("editTitle") : t("addTitle")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
      wide
    >
      <div className="grid gap-4 @lg/form:grid-cols-2">
        <SelectField
          form={form}
          name="type"
          label={t("type")}
          options={ADDRESS_TYPES.map((x) => ({ value: x, label: t(`types.${x}`) }))}
        />
        <CheckboxField form={form} name="isDefault" label={t("isDefault")} className="self-end" />
        <TextField form={form} name="name" label={tf("addressName")} description={tf("addressNameHint")} />
        <TextField form={form} name="name2" label={tf("addressName2")} />
        <TextField form={form} name="department" label={tf("department")} />
        <TextField form={form} name="street" label={tf("street")} autoComplete="address-line1" />
        <TextField form={form} name="street2" label={tf("street2")} autoComplete="address-line2" />
        <TextField form={form} name="postalCode" label={tf("postalCode")} autoComplete="postal-code" />
        <TextField form={form} name="city" label={tf("city")} autoComplete="address-level2" />
        <SelectField form={form} name="countryCode" label={tf("country")} options={COUNTRY_OPTIONS} />
        <TextField form={form} name="poBox" label={tf("poBox")} />
      </div>
    </FormDialog>
  );
}

export function ChannelsCard({ data, canWrite }: { data: ContactBundle; canWrite: boolean }) {
  const t = useTranslations("contacts.channels");
  const run = useRun();
  const remove = useMutation(api.contacts.removeChannel);
  const [editing, setEditing] = useState<Doc<"contactChannels"> | "new" | null>(null);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="font-semibold text-base">
          {t("title")}
        </h2>
        {canWrite && (
          <Button variant="outline" className="h-11 md:h-9" onClick={() => setEditing("new")}>
            <PlusIcon aria-hidden="true" />
            {t("add")}
          </Button>
        )}
      </div>
      {data.channels.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {data.channels.map((ch) => (
            <li key={ch._id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="w-20 text-muted-foreground">{t(`types.${ch.type}`)}</span>
                <ChannelValue channel={ch} />
                {ch.label && <span className="text-muted-foreground">({ch.label})</span>}
                {ch.isPrimary && <Badge variant="secondary">{t("primary")}</Badge>}
                {ch.isInvoiceEmail && <Badge variant="outline">{t("invoice")}</Badge>}
              </span>
              {canWrite && (
                <span className="flex gap-1">
                  <Button variant="ghost" className="h-11 md:h-8" onClick={() => setEditing(ch)}>
                    {t("edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-11 text-danger md:h-8"
                    onClick={() => void run(() => remove({ channelId: ch._id }), t("removed"))}
                  >
                    {t("remove")}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <ChannelDialog
          contactId={data.contact._id}
          channel={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function ChannelValue({ channel }: { channel: Doc<"contactChannels"> }) {
  if (channel.type === "email") {
    return (
      <a href={`mailto:${channel.value}`} className="break-all underline">
        {channel.value}
      </a>
    );
  }
  if (channel.type === "phone" || channel.type === "mobile") {
    return (
      <a href={telHref(channel.e164 ?? channel.value)} className="underline">
        {channel.value}
      </a>
    );
  }
  if (channel.type === "web") {
    return (
      <a href={channel.value} className="break-all underline" target="_blank" rel="noreferrer noopener">
        {channel.value}
      </a>
    );
  }
  return <span>{channel.value}</span>;
}

function ChannelDialog({
  contactId,
  channel,
  onClose,
}: {
  contactId: Doc<"contacts">["_id"];
  channel?: Doc<"contactChannels">;
  onClose: () => void;
}) {
  const t = useTranslations("contacts.channels");
  const run = useRun();
  const save = useMutation(api.contacts.saveChannel);
  const formId = useId();
  const form = useZodForm(channelSchema, {
    type: channel?.type ?? "email",
    value: channel?.value ?? "",
    label: channel?.label ?? "",
    isPrimary: channel?.isPrimary ?? true,
    isInvoiceEmail: channel?.isInvoiceEmail ?? false,
  });
  const submit = form.handleSubmit(async () => {
    const r = await run(
      () => save({ contactId, ...(channel ? { channelId: channel._id } : {}), values: form.getValues() }),
      t("saved"),
    );
    if (r.ok) onClose();
  });
  return (
    <FormDialog
      title={channel ? t("editTitle") : t("addTitle")}
      formId={formId}
      onClose={onClose}
      onSubmit={submit}
      submitting={form.formState.isSubmitting}
    >
      <SelectField
        form={form}
        name="type"
        label={t("type")}
        options={CHANNEL_TYPES.map((x) => ({ value: x, label: t(`types.${x}`) }))}
      />
      <TextField form={form} name="value" label={t("value")} required />
      <TextField form={form} name="label" label={t("label")} />
      <CheckboxField form={form} name="isPrimary" label={t("isPrimary")} />
      <CheckboxField form={form} name="isInvoiceEmail" label={t("isInvoiceEmail")} />
    </FormDialog>
  );
}
