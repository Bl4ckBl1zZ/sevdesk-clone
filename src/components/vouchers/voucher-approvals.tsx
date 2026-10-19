"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction } from "convex/react";
import { ConvexError } from "convex/values";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { formatDateTime } from "@/components/catalog/shared";
import { adapterErrorMessage, adapterErrorReason } from "@/components/setup/actions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { parseCents } from "@/domain/money/parse";
import { CheckboxInput, SelectInput, TextArea, TextInput } from "./voucher-fields";

type VId = Id<"vouchers">;

interface StoredBewirtung {
  occasionType: "geschaeftlich" | "arbeitnehmer";
  occasion: string;
  participants: string[];
  host: string;
  place: string;
  date: string;
  tipCents?: number;
  tseConfirmed: boolean;
  hostOnInvoiceConfirmed?: boolean;
  approvedAt?: number;
}

/** Runs an approval; a ⚑ warning block (`WARNINGS_UNACKNOWLEDGED`) is shown with a confirm checkbox instead of a toast. */
function useApproval() {
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const exec = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      const msg = adapterErrorMessage(e) ?? (e instanceof Error ? e.message : String(e));
      if (adapterErrorReason(e) === "WARNINGS_UNACKNOWLEDGED" && e instanceof ConvexError) {
        setWarnings(
          String((e.data as { warnings?: string }).warnings ?? "")
            .split(",")
            .filter(Boolean),
        );
      }
      setError(msg);
      return false;
    }
  };
  return { error, warnings, exec };
}

/**
 * VOU-060…062 Bewirtung sheet (mobile-first, F06 §6.4): occasion type, concrete occasion, participants, host, place,
 * tip and confirmations. „Freigeben“ renders the Bewirtungsbeleg (PDF, SHA-256) — a personal declaration, only in
 * the app; a later approval needs a reason and keeps the earlier version.
 */
export function BewirtungSheet({
  id,
  stored,
  documentDate,
  onClose,
}: {
  id: VId;
  stored: StoredBewirtung | null;
  documentDate: string;
  onClose: () => void;
}) {
  const t = useTranslations("vouchers.bewirtung");
  const approve = useAction(api.vouchers.approveBewirtungBeleg);
  const { error, warnings, exec } = useApproval();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    occasionType: stored?.occasionType ?? ("geschaeftlich" as const),
    occasion: stored?.occasion ?? "",
    participants: (stored?.participants ?? []).join("\n"),
    host: stored?.host ?? "",
    place: stored?.place ?? "",
    date: stored?.date ?? documentDate,
    tip: stored?.tipCents ? (stored.tipCents / 100).toFixed(2).replace(".", ",") : "",
    tse: stored?.tseConfirmed ?? false,
    hostOnInvoice: stored?.hostOnInvoiceConfirmed ?? false,
    reason: "",
  });
  const tip = f.tip.trim() ? parseCents(f.tip.trim()) : null;
  const submit = async () => {
    setBusy(true);
    const ok = await exec(() =>
      approve({
        id,
        data: {
          occasionType: f.occasionType,
          occasion: f.occasion.trim(),
          participants: f.participants
            .split("\n")
            .map((p) => p.trim())
            .filter(Boolean),
          host: f.host.trim(),
          place: f.place.trim(),
          date: f.date,
          ...(tip?.ok ? { tipCents: tip.value } : {}),
          tseConfirmed: f.tse,
          hostOnInvoiceConfirmed: f.hostOnInvoice,
        },
        ...(f.reason.trim() ? { reason: f.reason.trim() } : {}),
        ...(ack && warnings ? { acknowledgeWarnings: warnings } : {}),
      }),
    );
    setBusy(false);
    if (ok) {
      toast.success(t("approved"));
      onClose();
    }
  };
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-testid="bewirtung-sheet">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        <div className="@container/form flex flex-col gap-4 px-4">
          {stored?.approvedAt && (
            <p className="text-muted-foreground text-sm">
              {t("approvedAt", { date: formatDateTime(stored.approvedAt) })}
            </p>
          )}
          <SelectInput
            label={t("occasionType")}
            value={f.occasionType}
            onChange={(v) => setF({ ...f, occasionType: v as typeof f.occasionType })}
            options={(["geschaeftlich", "arbeitnehmer"] as const).map((o) => ({
              value: o,
              label: t(`occasionTypes.${o}`),
            }))}
          />
          <TextInput
            label={t("occasion")}
            hint={t("occasionHint")}
            value={f.occasion}
            onChange={(occasion) => setF({ ...f, occasion })}
            testId="bewirtung-occasion"
          />
          <TextArea
            label={t("participants")}
            hint={t("participantsHint")}
            value={f.participants}
            onChange={(participants) => setF({ ...f, participants })}
            testId="bewirtung-participants"
          />
          <TextInput label={t("host")} value={f.host} onChange={(host) => setF({ ...f, host })} />
          <TextInput label={t("place")} value={f.place} onChange={(place) => setF({ ...f, place })} />
          <TextInput label={t("date")} type="date" value={f.date} onChange={(date) => setF({ ...f, date })} />
          <TextInput
            label={t("tip")}
            inputMode="decimal"
            value={f.tip}
            error={tip && !tip.ok ? t("tipInvalid") : undefined}
            onChange={(v) => setF({ ...f, tip: v })}
          />
          <CheckboxInput label={t("tse")} checked={f.tse} onChange={(tse) => setF({ ...f, tse })} />
          <CheckboxInput
            label={t("hostOnInvoice")}
            checked={f.hostOnInvoice}
            onChange={(hostOnInvoice) => setF({ ...f, hostOnInvoice })}
          />
          {stored?.approvedAt && (
            <TextArea label={t("reason")} value={f.reason} onChange={(reason) => setF({ ...f, reason })} rows={2} />
          )}
          {error && (
            <p role="alert" className="text-danger text-sm">
              {error}
            </p>
          )}
          {warnings && warnings.length > 0 && (
            <CheckboxInput label={t("acknowledge")} checked={ack} onChange={setAck} />
          )}
        </div>
        <SheetFooter>
          <Button className="h-11 md:h-9" disabled={busy} onClick={() => void submit()} data-testid="bewirtung-approve">
            {t("approve")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** VOU-063 Eigenbeleg (replacement receipt): reason, recipient, purpose; „Freigeben“ renders the PDF, which is the Beleg. */
export function EigenbelegSheet({ id, onClose }: { id: VId; onClose: () => void }) {
  const t = useTranslations("vouchers.eigenbeleg");
  const approve = useAction(api.vouchers.approveEigenbelegBeleg);
  const { error, exec } = useApproval();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    reason: "lost" as "lost" | "not_obtainable" | "other",
    reasonText: "",
    recipient: "",
    purpose: "",
  });
  const submit = async () => {
    setBusy(true);
    const ok = await exec(() =>
      approve({
        id,
        data: {
          reason: f.reason,
          ...(f.reasonText.trim() ? { reasonText: f.reasonText.trim() } : {}),
          recipient: f.recipient.trim(),
          purpose: f.purpose.trim(),
        },
      }),
    );
    setBusy(false);
    if (ok) {
      toast.success(t("approved"));
      onClose();
    }
  };
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-testid="eigenbeleg-sheet">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        <div className="@container/form flex flex-col gap-4 px-4">
          <SelectInput
            label={t("reason")}
            value={f.reason}
            onChange={(v) => setF({ ...f, reason: v as typeof f.reason })}
            options={(["lost", "not_obtainable", "other"] as const).map((o) => ({
              value: o,
              label: t(`reasons.${o}`),
            }))}
          />
          <TextArea
            label={t("reasonText")}
            value={f.reasonText}
            onChange={(reasonText) => setF({ ...f, reasonText })}
            rows={2}
          />
          <TextInput label={t("recipient")} value={f.recipient} onChange={(recipient) => setF({ ...f, recipient })} />
          <TextInput label={t("purpose")} value={f.purpose} onChange={(purpose) => setF({ ...f, purpose })} />
          {error && (
            <p role="alert" className="text-danger text-sm">
              {error}
            </p>
          )}
        </div>
        <SheetFooter>
          <Button
            className="h-11 md:h-9"
            disabled={busy}
            onClick={() => void submit()}
            data-testid="eigenbeleg-approve"
          >
            {t("approve")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
