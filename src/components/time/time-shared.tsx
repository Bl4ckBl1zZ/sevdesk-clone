"use client";

import { api } from "@convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { LockIcon } from "lucide-react";
import { useDeferredValue, useId, useState } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { SelectField } from "@/components/forms/fields";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import type { BudgetStatus } from "@/domain/projects/budget";
import { TIME_ENTRY_STATUS_LABELS, type TimeEntryStatus } from "@/domain/projects/time-entries";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";

/** Shared pieces of the project and time screens (F11 §6). Business rules stay in src/domain and Convex. */

export type TimeEntryRow = FunctionReturnType<typeof api.timeEntries.list>[number];

/** „Offen / Im Entwurf / Abgerechnet 🔒“ (F11 §6 `/zeiten`). */
export function EntryStatusBadge({ status }: { status: TimeEntryStatus }) {
  return (
    <Badge variant={status === "open" ? "outline" : "secondary"} data-status={status}>
      {status === "invoiced" && <LockIcon aria-hidden="true" className="size-3" />}
      {TIME_ENTRY_STATUS_LABELS[status]}
    </Badge>
  );
}

/** PRJ-003 budget bar: green < 80 %, amber ≥ 80 %, red ≥ 100 %. */
export function BudgetBar({ budget, label }: { budget: BudgetStatus; label: string }) {
  const percent = Math.min(100, Math.floor(budget.ratioBp / 100));
  return (
    <div className="flex min-w-32 flex-col gap-1">
      <Progress
        value={percent}
        aria-label={label}
        className={cn(
          budget.level === "exceeded"
            ? "[&_[data-slot=progress-indicator]]:bg-danger"
            : budget.level === "warning"
              ? "[&_[data-slot=progress-indicator]]:bg-warning"
              : "[&_[data-slot=progress-indicator]]:bg-success",
        )}
      />
      <span className="text-muted-foreground text-xs tabular-nums" data-level={budget.level}>
        {budget.label}
      </span>
    </div>
  );
}

/** Contact search + select bound to a form field (same pattern as the customer price dialog). */
export function ContactSelectField<T extends FieldValues>({
  form,
  name,
  label,
  searchLabel,
  emptyLabel,
  initial,
}: {
  form: UseFormReturn<T>;
  name: Path<T>;
  label: string;
  searchLabel: string;
  emptyLabel: string;
  /** The current contact (shown even if the search does not find it). */
  initial?: { _id: string; displayName: string } | null;
}) {
  const searchId = useId();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);
  const contacts = useAuthedQuery(api.contacts.options, query ? { q: query } : {}) ?? [];
  const options = contacts.map((c) => ({ value: c._id as string, label: `${c.displayName} (${c.number})` }));
  if (initial && !options.some((o) => o.value === initial._id)) {
    options.unshift({ value: initial._id, label: initial.displayName });
  }
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={searchId} className="font-medium text-sm">
          {searchLabel}
        </label>
        <Input id={searchId} type="search" className="h-11 md:h-9" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <SelectField form={form} name={name} label={label} placeholder={emptyLabel} options={options} />
    </>
  );
}

/** Active projects for pickers (timer, entry form). */
export function useProjectOptions() {
  return useAuthedQuery(api.projects.options, {}) ?? [];
}
