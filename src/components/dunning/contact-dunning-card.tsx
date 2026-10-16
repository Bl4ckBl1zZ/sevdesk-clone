"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { selectClass, useCan, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { SectionCard } from "./dunning-shared";

/**
 * Contact „Mahnwesen“ (F05 §6.7, DUN-002, PAY-053): Mahnrichtlinie, „Nicht mahnen“ + reason, „Zahlungstermin
 * kalendermäßig vereinbart“ (default from the due date + 1, § 286 Abs. 2 Nr. 1 BGB).
 */
export function ContactDunningCard({ contactId }: { contactId: string }) {
  const data = useAuthedQuery(api.dunning.contactDunning, { contactId: contactId as Id<"contacts"> });
  if (!data) return null;
  return <ContactDunningForm key={JSON.stringify(data.dunning)} contactId={contactId} data={data} />;
}

function ContactDunningForm({
  contactId,
  data,
}: {
  contactId: string;
  data: FunctionReturnType<typeof api.dunning.contactDunning>;
}) {
  const t = useTranslations("dunning.contact");
  const run = useRun();
  const save = useMutation(api.dunning.saveContact);
  const canWrite = useCan("contacts.write");
  const [policyId, setPolicyId] = useState<string>(data.dunning?.policyId ?? "");
  const [blocked, setBlocked] = useState(data.dunning?.blocked === true);
  const [reason, setReason] = useState(data.dunning?.blockedReason ?? "");
  const [calendar, setCalendar] = useState(data.dunning?.calendarDueDateAgreed === true);
  const ids = { policy: useId(), reason: useId() };
  const stored = data.policies.filter((p) => !p.seeded);
  const invalid = blocked && reason.trim().length < 3;
  return (
    <SectionCard title={t("title")} testId="contact-dunning">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.policy} className="font-medium text-sm">
          {t("policy")}
        </label>
        <select
          id={ids.policy}
          className={selectClass}
          value={policyId}
          disabled={!canWrite}
          onChange={(e) => setPolicyId(e.target.value)}
        >
          <option value="">{t("policyDefault")}</option>
          {stored.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {stored.length === 0 && <p className="text-muted-foreground text-xs">{t("seededOnly")}</p>}
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
        <input
          type="checkbox"
          className="size-5 accent-primary md:size-4"
          checked={blocked}
          disabled={!canWrite}
          onChange={(e) => setBlocked(e.target.checked)}
        />
        {t("blocked")}
      </label>
      {blocked && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.reason} className="font-medium text-sm">
            {t("blockedReason")}
          </label>
          <Textarea id={ids.reason} value={reason} disabled={!canWrite} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      <label className="flex min-h-11 items-start gap-2 text-sm md:min-h-9">
        <input
          type="checkbox"
          className="mt-0.5 size-5 accent-primary md:size-4"
          checked={calendar}
          disabled={!canWrite}
          onChange={(e) => setCalendar(e.target.checked)}
        />
        <span className="flex flex-col">
          <span>{t("calendar")}</span>
          <span className="text-muted-foreground text-xs">{t("calendarHint")}</span>
        </span>
      </label>
      {canWrite && (
        <Button
          className="h-11 self-start md:h-9"
          disabled={invalid}
          onClick={() =>
            void run(
              () =>
                save({
                  contactId: contactId as Id<"contacts">,
                  ...(policyId ? { policyId } : {}),
                  blocked,
                  ...(blocked ? { blockedReason: reason.trim() } : {}),
                  calendarDueDateAgreed: calendar,
                }),
              t("saved"),
            )
          }
        >
          {t("save")}
        </Button>
      )}
    </SectionCard>
  );
}
