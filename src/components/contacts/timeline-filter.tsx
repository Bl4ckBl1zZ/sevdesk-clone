"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import type { TimelineFilter, TimelineKind } from "@/domain/contacts/timeline";
import { ACTIVITY_KIND_LABELS, ACTIVITY_KINDS } from "@/domain/schemas/contacts";

const FIELD = "h-11 rounded-md border border-input bg-background px-2.5 text-base md:h-9 md:text-sm dark:bg-input/30";

/** F02 CON-124: kind, period and full-text filter above the Verlauf. */
export function TimelineFilterBar({
  value,
  onChange,
}: {
  value: TimelineFilter;
  onChange: (next: TimelineFilter) => void;
}) {
  const t = useTranslations("contacts.timeline");
  const id = useId();
  const set = (patch: Partial<TimelineFilter>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="@container/filter grid gap-3 @lg/filter:grid-cols-4">
      <legend className="sr-only">{t("filterLabel")}</legend>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-kind`} className="font-medium text-sm">
          {t("kind")}
        </label>
        <select
          id={`${id}-kind`}
          className={FIELD}
          value={value.kind ?? "all"}
          onChange={(e) => set({ kind: e.target.value as TimelineKind | "all" })}
        >
          <option value="all">{t("kindAll")}</option>
          {ACTIVITY_KINDS.map((k) => (
            <option key={k} value={k}>
              {ACTIVITY_KIND_LABELS[k]}
            </option>
          ))}
          <option value="derived">{t("kindDerived")}</option>
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-from`} className="font-medium text-sm">
          {t("from")}
        </label>
        <input
          id={`${id}-from`}
          type="date"
          className={FIELD}
          value={value.from ?? ""}
          onChange={(e) => set({ from: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-to`} className="font-medium text-sm">
          {t("to")}
        </label>
        <input
          id={`${id}-to`}
          type="date"
          className={FIELD}
          value={value.to ?? ""}
          onChange={(e) => set({ to: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-q`} className="font-medium text-sm">
          {t("search")}
        </label>
        <Input
          id={`${id}-q`}
          type="search"
          className="h-11 md:h-9"
          value={value.query ?? ""}
          onChange={(e) => set({ query: e.target.value })}
        />
      </div>
    </fieldset>
  );
}
