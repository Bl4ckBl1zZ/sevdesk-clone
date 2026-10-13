"use client";

import { api } from "@convex/_generated/api";
import type { PaginatedQueryArgs, PaginatedQueryReference } from "convex/react";
import { useConvexAuth, usePaginatedQuery } from "convex/react";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import type * as React from "react";
import { useId } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { canDo, type Permission } from "@/domain/access/permissions";
import { writeCsv } from "@/domain/csv/csv";
import { formatMicros } from "@/domain/money/format";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * Shared pieces of the contact and product screens (F02 §6, F03 §6): permission-aware actions, the run-with-toast
 * helper, dialogs, CSV download and money formatting. Business rules stay in src/domain and Convex.
 */

/** Whether the signed-in member may perform `permission` (UI hint only; Convex enforces it). */
export function useCan(permission: Permission): boolean {
  const me = useAuthedQuery(api.members.me, {});
  return Boolean(me && canDo(me.role, permission));
}

/** Runs a backend call, shows the success toast or the German error message; returns success. */
export function useRun() {
  const showError = useAdapterErrorToast();
  return async <T,>(fn: () => Promise<T>, success?: string): Promise<{ ok: true; value: T } | { ok: false }> => {
    try {
      const value = await fn();
      if (success) toast.success(success);
      return { ok: true, value };
    } catch (e) {
      showError(e);
      return { ok: false };
    }
  };
}

/** `usePaginatedQuery` that waits for the Convex JWT (public functions reject anonymous calls). */
export function useAuthedPaginatedQuery<Q extends PaginatedQueryReference>(
  query: Q,
  args: PaginatedQueryArgs<Q>,
  initialNumItems: number,
) {
  const { isAuthenticated } = useConvexAuth();
  return usePaginatedQuery(query, isAuthenticated ? args : "skip", { initialNumItems });
}

export function FormDialog({
  title,
  description,
  formId,
  onClose,
  onSubmit,
  submitting,
  submitLabel,
  children,
  wide,
}: {
  title: string;
  description?: string;
  formId: string;
  onClose: () => void;
  onSubmit: (e?: React.BaseSyntheticEvent) => Promise<void>;
  submitting: boolean;
  submitLabel?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const tCommon = useTranslations("common");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={wide ? "max-h-[92dvh] overflow-y-auto sm:max-w-2xl" : "max-h-[92dvh] overflow-y-auto sm:max-w-lg"}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form id={formId} noValidate onSubmit={onSubmit} className="@container/form flex flex-col gap-4">
          {children}
        </form>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" form={formId} className="h-11 md:h-9" disabled={submitting}>
            {submitLabel ?? tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
  onClose,
  children,
  confirmDisabled,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  children?: React.ReactNode;
  confirmDisabled?: boolean;
}) {
  const tCommon = useTranslations("common");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            className="h-11 md:h-9"
            disabled={confirmDisabled}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** CON-143 / PRD-085: UTF-8 with BOM, `;` — downloaded in the browser. */
export function downloadCsv(rows: string[][], fileName: string): void {
  const [headers = [], ...body] = rows;
  const blob = new Blob([writeCsv(headers, body)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** 4-decimal prices shown with 2 decimals unless the extra digits are non-zero (F03 §6.2). */
export function formatPrice(micros: number): string {
  return `${formatMicros(micros)} €`;
}

export function formatPercentBp(bp: number | null | undefined): string {
  if (bp === null || bp === undefined) return "—";
  return `${(bp / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 })} %`;
}

const DATE_TIME = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

/** Timestamp (ms) in Berlin time, e.g. "13.10.2026, 14:05". */
export function formatDateTime(ms: number): string {
  return DATE_TIME.format(ms);
}

/** Calendar date "YYYY-MM-DD" → "13.10.2026". */
export function formatDate(iso: string | undefined | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return d && m && y ? `${d}.${m}.${y}` : iso;
}

/** Today's calendar date in Berlin ("YYYY-MM-DD", for date input defaults; the server decides with its own clock). */
export function todayBerlin(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());
}

/** Section card for long forms (04-ui-ux §7: grouped fields, one column on phones). */
export function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-xl border p-4">
      <h2 id={id} className="font-semibold text-base">
        {title}
      </h2>
      <div className="@container/form grid gap-4 @lg/form:grid-cols-2">{children}</div>
    </section>
  );
}

/** List filters persisted in the URL (04-ui-ux §4.1). */
export function useUrlState() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const get = (k: string) => params.get(k) ?? "";
  const hrefWith = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    return (qs ? `${pathname}?${qs}` : pathname) as Route;
  };
  return { get, hrefWith, set: (patch: Record<string, string>) => router.replace(hrefWith(patch), { scroll: false }) };
}

// `max-w-full min-w-0`: a native select is as wide as its longest option (e.g. the § 13b types) unless capped, and
// would widen the phone layout viewport.
export const selectClass =
  "h-11 min-w-0 max-w-full rounded-md border border-input bg-background px-2.5 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9 md:text-sm dark:bg-input/30";
