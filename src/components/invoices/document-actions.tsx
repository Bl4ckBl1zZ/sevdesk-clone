"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  ArrowRightLeftIcon,
  CheckIcon,
  CopyPlusIcon,
  PackageCheckIcon,
  RotateCcwIcon,
  UndoIcon,
  XIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, formatDate, selectClass, todayBerlin, useCan, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DISPLAY_STATUS_LABELS, type DisplayStatus } from "@/domain/documents/display-status";
import { DOC_TYPE_LABEL_DE, documentPath } from "@/domain/documents/doc-types";
import type { SalesDocType } from "@/domain/documents/snapshot";
import { formatMilli } from "@/domain/money/format";
import { parseMilli } from "@/domain/money/parse";
import { ACCEPTANCE_CHANNELS } from "@/domain/schemas/documents";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { InvoiceStatusBadge, money } from "./invoice-shared";

/**
 * Next steps of a finalised quote, order confirmation, delivery note or proforma (F04 §4.2, §6.3): „Angenommen“,
 * „Abgelehnt“, „Wieder öffnen“, „Neue Version“, „Umwandeln“, „Erhalten“, „Zurückziehen“ — and the chain view
 * („Verknüpft“, DOC-34). Every rule is checked again by Convex; the buttons only follow the lifecycle table.
 */

type Doc = NonNullable<FunctionReturnType<typeof api.invoices.get>>["doc"];
type Target = "order_confirmation" | "delivery_note" | "proforma" | "invoice";

const CONVERTIBLE: Partial<Record<SalesDocType, readonly string[]>> = {
  quote: ["finalized", "sent", "expired", "accepted", "partially_invoiced"],
  order_confirmation: ["finalized", "sent", "partially_invoiced"],
  delivery_note: ["finalized", "sent", "accepted"],
  proforma: ["finalized", "sent"],
  invoice: ["finalized", "sent"],
};

const WITHDRAWABLE: Partial<Record<SalesDocType, readonly string[]>> = {
  quote: ["finalized", "sent", "accepted"],
  order_confirmation: ["finalized", "sent"],
  delivery_note: ["finalized", "sent", "accepted"],
  proforma: ["finalized", "sent"],
};

const CHANNEL_LABELS: Record<(typeof ACCEPTANCE_CHANNELS)[number], string> = {
  email: "E-Mail",
  phone: "Telefon",
  manual: "Persönlich / Brief / Sonstiges",
};

type Dialog = "accept" | "reject" | "reopen" | "revise" | "convert" | "withdraw" | "received" | null;

export function DocumentFlowActions({ doc, targets }: { doc: Doc; targets: readonly Target[] }) {
  const t = useTranslations("documents.actions");
  const canWrite = useCan("documents.write");
  const [open, setOpen] = useState<Dialog>(null);
  if (!canWrite || doc.status === "draft") return null;
  const isQuote = doc.type === "quote";
  const buttons: { key: Exclude<Dialog, null>; label: string; icon: typeof CheckIcon; primary?: boolean }[] = [];
  if (isQuote && ["finalized", "sent", "expired"].includes(doc.status)) {
    buttons.push({ key: "accept", label: t("accept"), icon: CheckIcon, primary: true });
    buttons.push({ key: "reject", label: t("reject"), icon: XIcon });
  }
  if (isQuote && doc.status === "rejected") buttons.push({ key: "reopen", label: t("reopen"), icon: RotateCcwIcon });
  if (isQuote && ["finalized", "sent", "expired", "rejected"].includes(doc.status)) {
    buttons.push({ key: "revise", label: t("revise"), icon: CopyPlusIcon });
  }
  if (doc.type === "delivery_note" && (doc.status === "finalized" || doc.status === "sent")) {
    buttons.push({ key: "received", label: t("received"), icon: PackageCheckIcon });
  }
  if (targets.length > 0 && CONVERTIBLE[doc.type]?.includes(doc.status)) {
    buttons.push({
      key: "convert",
      label: targets.length === 1 ? t(`convertTo.${targets[0] as Target}`) : t("convert"),
      icon: ArrowRightLeftIcon,
      primary: !isQuote || doc.status === "accepted" || doc.status === "partially_invoiced",
    });
  }
  if (WITHDRAWABLE[doc.type]?.includes(doc.status)) {
    buttons.push({ key: "withdraw", label: t("withdraw"), icon: UndoIcon });
  }
  if (buttons.length === 0) return null;
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4" aria-label={t("title")}>
      <h2 className="font-semibold text-base">{t("title")}</h2>
      <div className="flex flex-wrap gap-2">
        {buttons.map((b) => (
          <Button
            key={b.key}
            variant={b.primary ? "default" : "outline"}
            className="h-11 md:h-9"
            onClick={() => setOpen(b.key)}
          >
            <b.icon aria-hidden="true" />
            {b.label}
          </Button>
        ))}
      </div>
      {open === "accept" && <AcceptDialog doc={doc} onClose={() => setOpen(null)} />}
      {open === "reject" && <RejectDialog doc={doc} onClose={() => setOpen(null)} />}
      {open === "reopen" && (
        <ReasonAction doc={doc} kind="reopen" onClose={() => setOpen(null)} confirmLabel={t("reopen")} />
      )}
      {open === "withdraw" && (
        <ReasonAction doc={doc} kind="withdraw" onClose={() => setOpen(null)} confirmLabel={t("withdraw")} />
      )}
      {open === "revise" && <ReviseDialog doc={doc} onClose={() => setOpen(null)} />}
      {open === "received" && <ReceivedDialog doc={doc} onClose={() => setOpen(null)} />}
      {open === "convert" && <ConvertDialog doc={doc} targets={targets} onClose={() => setOpen(null)} />}
    </section>
  );
}

function AcceptDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const t = useTranslations("documents.actions");
  const run = useRun();
  const accept = useMutation(api.documentFlows.accept);
  const [date, setDate] = useState(todayBerlin());
  const [byName, setByName] = useState(doc.contactName ?? "");
  const [channel, setChannel] = useState<(typeof ACCEPTANCE_CHANNELS)[number]>("email");
  const [note, setNote] = useState("");
  const [late, setLate] = useState(false);
  const ids = { date: useId(), name: useId(), channel: useId(), note: useId() };
  const expired = doc.status === "expired";
  return (
    <ConfirmDialog
      title={t("acceptTitle")}
      description={t("acceptHint")}
      confirmLabel={t("save")}
      confirmDisabled={!byName.trim() || (expired && !late)}
      onConfirm={async () => {
        const r = await run(
          () =>
            accept({
              id: doc._id,
              values: {
                date,
                byName: byName.trim(),
                channel,
                ...(note.trim() ? { note } : {}),
                ...(late ? { late } : {}),
              },
            }),
          t("accepted"),
        );
        if (r.ok) onClose();
      }}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        {expired && (
          <label className="flex min-h-11 items-center gap-2 text-sm text-warning md:min-h-9">
            <input
              type="checkbox"
              className="size-5 accent-primary md:size-4"
              checked={late}
              onChange={(e) => setLate(e.target.checked)}
            />
            {t("acceptLate", { date: formatDate(doc.validUntil ?? null) })}
          </label>
        )}
        <Field id={ids.date} label={t("date")}>
          <Input
            id={ids.date}
            type="date"
            max={todayBerlin()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-11 md:h-9"
          />
        </Field>
        <Field id={ids.name} label={t("byName")}>
          <Input id={ids.name} value={byName} onChange={(e) => setByName(e.target.value)} className="h-11 md:h-9" />
        </Field>
        <Field id={ids.channel} label={t("channel")}>
          <select
            id={ids.channel}
            className={selectClass}
            value={channel}
            onChange={(e) => setChannel(e.target.value as typeof channel)}
          >
            {ACCEPTANCE_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field id={ids.note} label={t("note")}>
          <Textarea id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

function RejectDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const t = useTranslations("documents.actions");
  const run = useRun();
  const reject = useMutation(api.documentFlows.reject);
  const [date, setDate] = useState(todayBerlin());
  const [reason, setReason] = useState("");
  const ids = { date: useId(), reason: useId() };
  return (
    <ConfirmDialog
      title={t("rejectTitle")}
      confirmLabel={t("save")}
      onConfirm={async () => {
        const r = await run(
          () => reject({ id: doc._id, values: { date, ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
          t("rejected"),
        );
        if (r.ok) onClose();
      }}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <Field id={ids.date} label={t("date")}>
          <Input
            id={ids.date}
            type="date"
            max={todayBerlin()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-11 md:h-9"
          />
        </Field>
        <Field id={ids.reason} label={t("rejectReason")}>
          <Textarea id={ids.reason} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

function ReasonAction({
  doc,
  kind,
  confirmLabel,
  onClose,
}: {
  doc: Doc;
  kind: "reopen" | "withdraw";
  confirmLabel: string;
  onClose: () => void;
}) {
  const t = useTranslations("documents.actions");
  const run = useRun();
  const reopen = useMutation(api.documentFlows.reopen);
  const withdraw = useMutation(api.documentFlows.withdraw);
  const [reason, setReason] = useState("");
  const rid = useId();
  return (
    <ConfirmDialog
      title={kind === "reopen" ? t("reopenTitle") : t("withdrawTitle", { label: DOC_TYPE_LABEL_DE[doc.type] })}
      description={kind === "reopen" ? undefined : t("withdrawHint")}
      confirmLabel={confirmLabel}
      destructive={kind === "withdraw"}
      confirmDisabled={reason.trim().length < 3}
      onConfirm={async () => {
        const values = { reason: reason.trim() };
        const r = await run(
          () => (kind === "reopen" ? reopen({ id: doc._id, values }) : withdraw({ id: doc._id, values })),
          kind === "reopen" ? t("reopened") : t("withdrawn"),
        );
        if (r.ok) onClose();
      }}
      onClose={onClose}
    >
      <Field id={rid} label={t("reason")}>
        <Textarea id={rid} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}

function ReviseDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const t = useTranslations("documents.actions");
  const run = useRun();
  const router = useRouter();
  const revise = useMutation(api.documentFlows.revise);
  const [reason, setReason] = useState("");
  const rid = useId();
  return (
    <ConfirmDialog
      title={t("reviseTitle")}
      description={t("reviseHint", { number: doc.number ?? "" })}
      confirmLabel={t("reviseConfirm")}
      onConfirm={async () => {
        const r = await run(
          () => revise({ id: doc._id, values: reason.trim() ? { reason: reason.trim() } : {} }),
          t("revised"),
        );
        if (r.ok) router.push(documentPath("quote", r.value.id) as Route);
      }}
      onClose={onClose}
    >
      <Field id={rid} label={t("reasonOptional")}>
        <Textarea id={rid} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}

function ReceivedDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const t = useTranslations("documents.actions");
  const run = useRun();
  const mark = useMutation(api.documentFlows.markReceived);
  const [date, setDate] = useState(todayBerlin());
  const [byName, setByName] = useState("");
  const ids = { date: useId(), name: useId() };
  return (
    <ConfirmDialog
      title={t("receivedTitle")}
      confirmLabel={t("save")}
      confirmDisabled={!byName.trim()}
      onConfirm={async () => {
        const r = await run(() => mark({ id: doc._id, values: { date, byName: byName.trim() } }), t("receivedDone"));
        if (r.ok) onClose();
      }}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <Field id={ids.date} label={t("date")}>
          <Input
            id={ids.date}
            type="date"
            max={todayBerlin()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-11 md:h-9"
          />
        </Field>
        <Field id={ids.name} label={t("receivedBy")}>
          <Input id={ids.name} value={byName} onChange={(e) => setByName(e.target.value)} className="h-11 md:h-9" />
        </Field>
      </div>
    </ConfirmDialog>
  );
}

/** „Umwandeln“ (§6.3): target, optional lines, quantities (remaining proposed), „Angebot als angenommen markieren“. */
function ConvertDialog({ doc, targets, onClose }: { doc: Doc; targets: readonly Target[]; onClose: () => void }) {
  const t = useTranslations("documents.actions");
  const run = useRun();
  const router = useRouter();
  const convert = useMutation(api.documentFlows.convert);
  const [to, setTo] = useState<Target>(targets[0] as Target);
  const proposal = useAuthedQuery(api.documentFlows.proposal, { id: doc._id, to });
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<string[]>([]);
  const [acceptSource, setAcceptSource] = useState(true);
  const toId = useId();
  const qty = (lineId: string, proposed: number) => quantities[lineId] ?? formatMilli(proposed);
  const parsed: Record<string, number> = {};
  let invalid = false;
  for (const l of proposal?.lines ?? []) {
    if (l.optional) continue;
    const r = parseMilli(qty(l.id, l.proposedMilli));
    if (r.ok && r.value >= 0) parsed[l.id] = r.value;
    else invalid = true;
  }
  for (const id of chosen) {
    const l = proposal?.lines.find((x) => x.id === id);
    if (l) parsed[id] = l.quantityMilli;
  }
  return (
    <ConfirmDialog
      title={t("convertTitle", { label: DOC_TYPE_LABEL_DE[doc.type], number: doc.number ?? "" })}
      confirmLabel={t("convertConfirm")}
      confirmDisabled={!proposal?.allowed || invalid || (proposal.acceptRequired && !acceptSource)}
      onConfirm={async () => {
        const r = await run(
          () =>
            convert({
              id: doc._id as Id<"salesDocuments">,
              values: {
                to,
                mode: "quantities",
                quantities: parsed,
                ...(chosen.length ? { optionalLineIds: chosen } : {}),
                ...(proposal?.acceptRequired ? { acceptSource: true } : {}),
              },
            }),
          t("converted", { label: DOC_TYPE_LABEL_DE[to] }),
        );
        if (r.ok) {
          for (const n of r.value.notices) toast.info(n);
          router.push(documentPath(to, r.value.id) as Route);
        }
      }}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        {targets.length > 1 && (
          <Field id={toId} label={t("target")}>
            <select id={toId} className={selectClass} value={to} onChange={(e) => setTo(e.target.value as Target)}>
              {targets.map((x) => (
                <option key={x} value={x}>
                  {DOC_TYPE_LABEL_DE[x]}
                </option>
              ))}
            </select>
          </Field>
        )}
        {proposal && !proposal.allowed && (
          <p role="alert" className="text-danger text-sm">
            {proposal.error?.message}
          </p>
        )}
        {proposal?.acceptRequired && (
          <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
            <input
              type="checkbox"
              className="size-5 accent-primary md:size-4"
              checked={acceptSource}
              onChange={(e) => setAcceptSource(e.target.checked)}
            />
            {proposal.expired ? t("acceptSourceExpired") : t("acceptSource")}
          </label>
        )}
        {proposal?.allowed && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-medium text-sm">{t("lines")}</legend>
            {proposal.lines.map((l) =>
              l.optional ? (
                <label key={l.id} className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
                  <input
                    type="checkbox"
                    className="size-5 accent-primary md:size-4"
                    checked={chosen.includes(l.id)}
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, l.id] : c.filter((x) => x !== l.id)))}
                  />
                  {t("optionalLine", { name: l.name })}
                </label>
              ) : (
                <div key={l.id} className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2">
                  <label htmlFor={`${toId}-${l.id}`} className="min-w-0 text-sm">
                    {l.name}
                    <span className="block text-muted-foreground text-xs tabular-nums">
                      {t("ofQuantity", { qty: formatMilli(l.quantityMilli) })}
                    </span>
                  </label>
                  <Input
                    id={`${toId}-${l.id}`}
                    inputMode="decimal"
                    value={qty(l.id, l.proposedMilli)}
                    onChange={(e) => setQuantities((q) => ({ ...q, [l.id]: e.target.value }))}
                    className="h-11 text-right tabular-nums md:h-9"
                  />
                </div>
              ),
            )}
          </fieldset>
        )}
      </div>
    </ConfirmDialog>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-sm">
        {label}
      </label>
      {children}
    </div>
  );
}

/** „Verknüpft“ (DOC-34): every document of the chain with status, amount and invoicing progress. */
export function ChainCard({ chain }: { chain: FunctionReturnType<typeof api.documentFlows.chain> | undefined }) {
  const t = useTranslations("documents.chain");
  if (!chain || chain.documents.length < 2) return null;
  return (
    <section className="flex flex-col gap-2 rounded-xl border p-4" aria-label={t("title")}>
      <h2 className="font-semibold text-base">{t("title")}</h2>
      <ul className="flex flex-col divide-y text-sm" data-testid="chain">
        {chain.documents.map((d) => (
          <li key={d._id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="flex min-w-0 flex-col">
              {d.isCurrent ? (
                <span className="font-medium">
                  {DOC_TYPE_LABEL_DE[d.type]} {d.number ?? t("draft")}
                </span>
              ) : (
                <Link href={documentPath(d.type, d._id) as Route} className="font-medium hover:underline">
                  {DOC_TYPE_LABEL_DE[d.type]} {d.number ?? t("draft")}
                </Link>
              )}
              <span className="text-muted-foreground text-xs">
                {formatDate(d.documentDate)}
                {(d.type === "quote" || d.type === "order_confirmation") && d.status !== "draft"
                  ? ` · ${t("invoiced", { percent: Math.floor(d.coveredBp / 100) })}`
                  : ""}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <InvoiceStatusBadge token={statusToken(d.type, d.status)} label={statusLabel(d.type, d.status)} />
              <span className="tabular-nums">{money(d.grossCents, d.currency)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATUS_TOKEN: Record<string, DisplayStatus> = {
  draft: "draft",
  finalized: "unsent",
  sent: "open",
  cancelled: "cancelled",
  accepted: "accepted",
  rejected: "rejected",
  expired: "expired",
  superseded: "superseded",
  partially_invoiced: "partially_invoiced",
  invoiced: "invoiced",
};

const statusToken = (_type: string, status: string): DisplayStatus => STATUS_TOKEN[status] ?? "open";
const statusLabel = (type: string, status: string) =>
  type === "delivery_note" && status === "accepted" ? "Erhalten" : DISPLAY_STATUS_LABELS[statusToken(type, status)];
