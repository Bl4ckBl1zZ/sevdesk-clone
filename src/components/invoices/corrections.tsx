"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDownIcon, FileMinusIcon, FilePlusIcon, MoreHorizontalIcon, Undo2Icon, WrenchIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, formatDate, useCan, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { RECTIFIED_FIELD_LABELS } from "@/domain/documents/corrections";
import type { DocumentSnapshot } from "@/domain/documents/snapshot";
import { formatMicros, formatMilli } from "@/domain/money/format";
import { parseMicros, parseMilli } from "@/domain/money/parse";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { money } from "./invoice-shared";

/**
 * Storno, Korrektur-Assistent and the advance → final chain in the UI (F04 §4.7/§4.8, §6.3/§6.4). German texts in
 * `invoiceCorrections` (de.json). Every write goes through convex/corrections.ts; correction and chain drafts open in
 * the normal editor and are finalised with „Fertigstellen“.
 */

type DocType = "invoice" | "advance_invoice" | "partial_invoice" | "final_invoice" | "cancellation" | "correction";
type Relations = NonNullable<FunctionReturnType<typeof api.corrections.relations>>;
type Advance = NonNullable<Relations["chain"]>["advances"][number];

/** Title key of a document type („Abschlagsrechnung“, „Rechnungsberichtigung“ …). */
export function docTypeKey(type: string, correctionKind?: string | null): string {
  if (type === "correction") return correctionKind === "rectification" ? "rectification" : "credit";
  return type;
}

export function useDocTypeLabel() {
  const t = useTranslations("invoiceCorrections.types");
  return (type: string, correctionKind?: string | null) => t(docTypeKey(type, correctionKind) as never);
}

const INVOICE_FAMILY: readonly string[] = ["invoice", "advance_invoice", "partial_invoice", "final_invoice"];
const CHAIN: readonly string[] = ["advance_invoice", "partial_invoice", "final_invoice"];

const href = (id: string) => `/rechnungen/${id}` as Route;

// ── header actions of a finalised document ──────────────────────────────────────────────────────────────────────

export function CorrectionActions({
  doc,
  snapshot,
}: {
  doc: { _id: Id<"salesDocuments">; type: string; status: string; correctionKind?: string; number?: string };
  snapshot: DocumentSnapshot | null;
}) {
  const t = useTranslations("invoiceCorrections");
  const router = useRouter();
  const run = useRun();
  const canWrite = useCan("documents.write");
  const canCancel = useCan("invoices.cancel");
  const createChainDraft = useMutation(api.corrections.createChainDraft);
  const [assistant, setAssistant] = useState(false);
  const [storno, setStorno] = useState(false);
  const [final, setFinal] = useState(false);
  const active = doc.status === "finalized" || doc.status === "sent";
  if (!active) return null;
  const isFamily = INVOICE_FAMILY.includes(doc.type);
  const isCredit = doc.type === "correction" && doc.correctionKind === "credit";
  const isAdvance = doc.type === "advance_invoice" || doc.type === "partial_invoice";
  const nextAdvance = async () => {
    const r = await run(
      () => createChainDraft({ fromId: doc._id, type: "advance_invoice" }),
      t("chain.advanceCreated"),
    );
    if (r.ok) router.push(href(r.value.id));
  };
  const items = [
    isFamily && canWrite && { key: "correct", icon: WrenchIcon, label: t("correct"), run: () => setAssistant(true) },
    isCredit && canCancel && { key: "cancel", icon: Undo2Icon, label: t("cancel"), run: () => setStorno(true) },
    isAdvance &&
      canWrite && { key: "advance", icon: FilePlusIcon, label: t("chain.nextAdvance"), run: () => void nextAdvance() },
    isAdvance &&
      canWrite && { key: "final", icon: FilePlusIcon, label: t("chain.createFinal"), run: () => setFinal(true) },
  ].filter((i) => i !== false);
  // One menu keeps the phone action bar (04 §1.2) at three buttons next to „Exportieren“ and „Als versendet markieren“.
  return (
    <>
      {items.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" className="h-11 md:h-9" />}>
            <MoreHorizontalIcon aria-hidden="true" />
            {t("more")}
            <ChevronDownIcon aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {items.map((i) => (
              <DropdownMenuItem key={i.key} onClick={i.run}>
                <i.icon aria-hidden="true" />
                {i.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {assistant && (
        <CorrectionAssistant
          id={doc._id}
          number={doc.number ?? ""}
          snapshot={snapshot}
          onClose={() => setAssistant(false)}
          onStorno={() => {
            setAssistant(false);
            setStorno(true);
          }}
        />
      )}
      {storno && (
        <StornoDialog
          id={doc._id}
          onClose={() => setStorno(false)}
          {...(isFamily && canWrite
            ? {
                onCorrection: () => {
                  setStorno(false);
                  setAssistant(true);
                },
              }
            : {})}
        />
      )}
      {final && <FinalWizard id={doc._id} onClose={() => setFinal(false)} />}
    </>
  );
}

// ── Korrektur-Assistent (§4.8) ───────────────────────────────────────────────────────────────────────────────────

type Path = "rectification" | "storno" | "credit";

function CorrectionAssistant({
  id,
  number,
  snapshot,
  onClose,
  onStorno,
}: {
  id: Id<"salesDocuments">;
  number: string;
  snapshot: DocumentSnapshot | null;
  onClose: () => void;
  onStorno: () => void;
}) {
  const t = useTranslations("invoiceCorrections.assistant");
  const router = useRouter();
  const run = useRun();
  const create = useMutation(api.corrections.createCorrection);
  const preview = useAuthedQuery(api.corrections.cancelPreview, { id });
  const [path, setPath] = useState<Path>("rectification");
  const [full, setFull] = useState(false);
  const [changes, setChanges] = useState<Record<number, { qty: string; price: string }>>({});
  const items = (snapshot?.lines ?? []).filter((l) => l.kind === "item");
  const stornoBlocked = preview?.guard ?? null;
  const name = useId();

  const creditChanges = () => {
    const out: { position: number; quantityMilli?: number; unitPriceMicros?: number }[] = [];
    for (const [i, l] of items.entries()) {
      if (l.kind !== "item") continue;
      const c = changes[i + 1];
      if (!c) continue;
      const pq = c.qty.trim() ? parseMilli(c.qty) : null;
      const pp = c.price.trim() ? parseMicros(c.price) : null;
      const q = pq?.ok ? pq.value : null;
      const p = pp?.ok ? pp.value : null;
      if (q === null && p === null) continue;
      out.push({
        position: i + 1,
        ...(q !== null ? { quantityMilli: q } : {}),
        ...(p !== null ? { unitPriceMicros: p } : {}),
      });
    }
    return out;
  };

  const confirm = async () => {
    if (path === "storno") return onStorno();
    const r = await run(
      () =>
        create({
          originalId: id,
          kind: path,
          ...(path === "credit" && !full ? { changes: creditChanges() } : {}),
        }),
      path === "credit" ? t("creditCreated") : t("rectificationCreated"),
    );
    if (r.ok) router.push(href(r.value.id));
  };

  const options: { value: Path; title: string; text: string; disabled?: string | null }[] = [
    { value: "rectification", title: t("rectificationTitle"), text: t("rectificationText") },
    { value: "storno", title: t("stornoTitle"), text: t("stornoText"), disabled: stornoBlocked?.message ?? null },
    { value: "credit", title: t("creditTitle"), text: t("creditText") },
  ];
  return (
    <ConfirmDialog
      title={t("title", { number })}
      description={t("description")}
      confirmLabel={path === "storno" ? t("toStorno") : t("createDraft")}
      confirmDisabled={
        (path === "storno" && !!stornoBlocked) || (path === "credit" && !full && creditChanges().length === 0)
      }
      onConfirm={confirm}
      onClose={onClose}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{t("question")}</legend>
        {options.map((o) => (
          <label
            key={o.value}
            className="flex cursor-pointer gap-3 rounded-lg border p-3 text-sm has-[:checked]:border-primary"
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              className="mt-0.5 size-5 accent-primary md:size-4"
              checked={path === o.value}
              onChange={() => setPath(o.value)}
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{o.title}</span>
              <span className="text-muted-foreground">{o.text}</span>
              {o.disabled && path === o.value && (
                <span role="alert" className="text-danger">
                  {o.disabled}
                </span>
              )}
              {o.disabled && path === o.value && stornoBlocked?.code === "storno_paid_invoice" && (
                <PaidStornoPaths onCorrection={() => setPath("credit")} onClose={onClose} />
              )}
            </span>
          </label>
        ))}
      </fieldset>
      {path === "credit" && (
        <div className="flex flex-col gap-2">
          <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
            <input
              type="checkbox"
              className="size-5 accent-primary md:size-4"
              checked={full}
              onChange={(e) => setFull(e.target.checked)}
            />
            {t("creditFull")}
          </label>
          {!full && (
            <ul className="flex flex-col gap-2" aria-label={t("creditLines")}>
              {items.map((l, i) =>
                l.kind === "item" ? (
                  <CreditLine
                    key={l.position}
                    position={i + 1}
                    name={l.name}
                    qty={formatMilli(l.quantityMilli)}
                    price={formatMicros(l.unitPriceMicros)}
                    value={changes[i + 1] ?? { qty: "", price: "" }}
                    onChange={(v) => setChanges((c) => ({ ...c, [i + 1]: v }))}
                  />
                ) : null,
              )}
            </ul>
          )}
          <p className="text-muted-foreground text-xs">{t("creditHint")}</p>
        </div>
      )}
      <p className="text-muted-foreground text-xs">{t("moreHint")}</p>
    </ConfirmDialog>
  );
}

function CreditLine({
  position,
  name,
  qty,
  price,
  value,
  onChange,
}: {
  position: number;
  name: string;
  qty: string;
  price: string;
  value: { qty: string; price: string };
  onChange: (v: { qty: string; price: string }) => void;
}) {
  const t = useTranslations("invoiceCorrections.assistant");
  const q = useId();
  const p = useId();
  return (
    <li className="grid grid-cols-2 gap-2 rounded-md border p-2 text-sm">
      <span className="col-span-2 font-medium">
        {position}. {name} ({qty} × {price})
      </span>
      <div className="flex flex-col gap-1">
        <label htmlFor={q} className="text-xs">
          {t("newQty", { n: position })}
        </label>
        <Input
          id={q}
          inputMode="decimal"
          placeholder={qty}
          value={value.qty}
          onChange={(e) => onChange({ ...value, qty: e.target.value })}
          className="h-11 md:h-9"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={p} className="text-xs">
          {t("newPrice", { n: position })}
        </label>
        <Input
          id={p}
          inputMode="decimal"
          placeholder={price}
          value={value.price}
          onChange={(e) => onChange({ ...value, price: e.target.value })}
          className="h-11 md:h-9"
        />
      </div>
    </li>
  );
}

// ── Storno (INV-10/11) ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * PAY-034 / EC-074: a paid invoice cannot be cancelled. The block names both legal paths and links to them:
 * Rechnungskorrektur (+ Erstattung/Guthaben) if it was really paid, or release the wrong allocation first (PAY-040).
 */
function PaidStornoPaths({ onCorrection, onClose }: { onCorrection?: () => void; onClose: () => void }) {
  const t = useTranslations("invoiceCorrections.paidStorno");
  return (
    <span className="mt-1 flex flex-wrap gap-2" data-testid="paid-storno-paths">
      {onCorrection && (
        <Button type="button" variant="outline" size="sm" className="min-h-11 md:min-h-8" onClick={onCorrection}>
          {t("correction")}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 md:min-h-8"
        onClick={() => {
          onClose();
          document.getElementById("payments-heading")?.scrollIntoView({ block: "start" });
        }}
      >
        {t("payments")}
      </Button>
    </span>
  );
}

export function StornoDialog({
  id,
  onClose,
  onCorrection,
}: {
  id: Id<"salesDocuments">;
  onClose: () => void;
  onCorrection?: () => void;
}) {
  const t = useTranslations("invoiceCorrections.storno");
  const router = useRouter();
  const run = useRun();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const preview = useAuthedQuery(api.corrections.cancelPreview, { id });
  const validate = useAction(api.corrections.validateCancel);
  const cancel = useMutation(api.corrections.cancel);
  const rid = useId();
  const m = preview?.mirror;
  const blocked = preview?.guard ?? null;
  return (
    <ConfirmDialog
      title={t("title", { number: preview?.original.number ?? "" })}
      description={t("description", {
        number: preview?.original.number ?? "",
        date: formatDate(preview?.original.documentDate),
      })}
      confirmLabel={t("confirm")}
      destructive
      confirmDisabled={busy || !preview || !!blocked}
      onConfirm={async () => {
        setBusy(true);
        const reasonArg = reason.trim() ? { reason: reason.trim() } : {};
        const check = await run(() => validate({ id, ...reasonArg }));
        if (!check.ok) return setBusy(false);
        if (check.value.status === "failed" || check.value.status === "blocked") {
          toast.error(check.value.message ?? t("xmlInvalid"));
          return setBusy(false);
        }
        const r = await run(() => cancel({ id, ...reasonArg }));
        setBusy(false);
        if (r.ok) {
          toast.success(t("done", { number: r.value.number }));
          onClose();
          router.push(href(r.value.id));
        }
      }}
      onClose={onClose}
    >
      {blocked ? (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm"
          data-testid="storno-blocked"
        >
          {blocked.message}
          {blocked.code === "storno_paid_invoice" && (
            <PaidStornoPaths onClose={onClose} {...(onCorrection ? { onCorrection } : {})} />
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          {m && (
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">{t("date")}</dt>
              <dd className="text-right">{formatDate(m.documentDate)}</dd>
              <dt className="text-muted-foreground">{t("net")}</dt>
              <dd className="text-right tabular-nums">{money(m.totals.netCents, m.currency)}</dd>
              <dt className="text-muted-foreground">{t("vat")}</dt>
              <dd className="text-right tabular-nums">{money(m.totals.vatCents, m.currency)}</dd>
              <dt className="font-medium">{t("gross")}</dt>
              <dd className="text-right font-medium tabular-nums" data-testid="storno-gross">
                {money(m.totals.grossCents, m.currency)}
              </dd>
            </dl>
          )}
          <p className="text-muted-foreground">{preview?.notice}</p>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={rid} className="font-medium">
              {t("reason")}
            </label>
            <Textarea id={rid} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
      )}
    </ConfirmDialog>
  );
}

// ── chain: Schlussrechnung wizard (INV-06/07, EC-071) ────────────────────────────────────────────────────────────

function AdvanceRow({ a, onStorno }: { a: Advance; onStorno: (id: Id<"salesDocuments">) => void }) {
  const t = useTranslations("invoiceCorrections.chain");
  const router = useRouter();
  const run = useRun();
  const reduce = useMutation(api.corrections.reduceAdvance);
  const finalize = useAction(api.invoices.finalize);
  const canWrite = useCan("documents.write");
  const canFinalize = useCan("invoices.finalize");
  const canCancel = useCan("invoices.cancel");
  return (
    <TableRow data-testid={`advance-${a.number}`}>
      <TableCell>
        <Link className="underline" href={href(a.id)}>
          {a.number}
        </Link>
        <span className="block text-muted-foreground text-xs">{formatDate(a.documentDate)}</span>
      </TableCell>
      <TableCell className="text-right tabular-nums">{money(a.invoicedCents)}</TableCell>
      <TableCell className="text-right tabular-nums">{money(a.receivedCents)}</TableCell>
      <TableCell className="text-right tabular-nums">{money(a.openCents)}</TableCell>
      <TableCell>
        <span className="block">{t(`resolution.${a.resolution}` as never)}</span>
        {a.resolution === "storno" && canCancel && (
          <Button variant="outline" className="mt-1 h-11 md:h-9" onClick={() => onStorno(a.id)}>
            {t("doStorno")}
          </Button>
        )}
        {a.resolution === "reduce" && canWrite && canFinalize && (
          <Button
            variant="outline"
            className="mt-1 h-11 md:h-9"
            onClick={async () => {
              const created = await run(() => reduce({ advanceId: a.id }));
              if (!created.ok) return;
              const done = await run(
                () => finalize({ id: created.value.id, version: created.value.version }),
                t("reduced", { number: a.number }),
              );
              if (!done.ok) router.push(href(created.value.id));
            }}
          >
            <FileMinusIcon aria-hidden="true" />
            {t("doReduce", { amount: money(a.receivedCents) })}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

export function ChainTable({ relations }: { relations: Relations }) {
  const t = useTranslations("invoiceCorrections.chain");
  const [storno, setStorno] = useState<Id<"salesDocuments"> | null>(null);
  const c = relations.chain;
  if (!c) return null;
  return (
    <div className="@container/chain flex flex-col gap-2">
      <Table scrollLabel={t("advances")} aria-label={t("advances")}>
        <TableHeader>
          <TableRow>
            <TableHead>{t("advance")}</TableHead>
            <TableHead className="text-right">{t("invoiced")}</TableHead>
            <TableHead className="text-right">{t("received")}</TableHead>
            <TableHead className="text-right">{t("open")}</TableHead>
            <TableHead>{t("beforeFinal")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {c.advances.map((a) => (
            <AdvanceRow key={a.id} a={a} onStorno={setStorno} />
          ))}
        </TableBody>
      </Table>
      {storno && <StornoDialog id={storno} onClose={() => setStorno(null)} />}
    </div>
  );
}

function FinalWizard({ id, onClose }: { id: Id<"salesDocuments">; onClose: () => void }) {
  const t = useTranslations("invoiceCorrections.chain");
  const router = useRouter();
  const run = useRun();
  const relations = useAuthedQuery(api.corrections.relations, { id });
  const create = useMutation(api.corrections.createChainDraft);
  const c = relations?.chain;
  const unresolved = c?.advances.filter((a) => a.resolution === "storno" || a.resolution === "reduce") ?? [];
  const existing = c?.finals[0];
  return (
    <ConfirmDialog
      title={t("wizardTitle", { order: c?.order?.number ?? "" })}
      description={t("wizardDescription")}
      confirmLabel={t("createFinalDraft")}
      confirmDisabled={!c || unresolved.length > 0 || !c.canCreateFinal}
      onConfirm={async () => {
        const r = await run(() => create({ fromId: id, type: "final_invoice" }), t("finalCreated"));
        if (r.ok) {
          onClose();
          router.push(href(r.value.id));
        }
      }}
      onClose={onClose}
    >
      {relations && <ChainTable relations={relations} />}
      {unresolved.length > 0 && (
        <p role="alert" className="text-danger text-sm" data-testid="advance-not-settled">
          {t("unresolved")}
        </p>
      )}
      {existing && (
        <p className="text-sm">
          {t("finalExists")}{" "}
          <Link className="underline" href={href(existing.id)}>
            {existing.number ?? t("draft")}
          </Link>
        </p>
      )}
    </ConfirmDialog>
  );
}

// ── related documents (detail page) ──────────────────────────────────────────────────────────────────────────────

export function RelationsPanel({ id, type }: { id: Id<"salesDocuments">; type: DocType | string }) {
  const t = useTranslations("invoiceCorrections.relations");
  const label = useDocTypeLabel();
  const r = useAuthedQuery(api.corrections.relations, { id });
  if (!r) return null;
  const hasAny = r.original || r.cancelledBy || r.corrections.length > 0 || r.chain || r.rectifiedFields.length > 0;
  if (!hasAny) return null;
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4" aria-label={t("title")} data-testid="relations">
      <h2 className="font-semibold text-base">{t("title")}</h2>
      {r.original && (
        <p className="text-sm">
          {t("refersTo", { type: label(r.original.type, r.original.correctionKind) })}{" "}
          <Link className="underline" href={href(r.original.id)}>
            {r.original.number}
          </Link>{" "}
          {t("of", { date: formatDate(r.original.documentDate) })}
        </p>
      )}
      {r.cancelledBy && (
        <p role="status" className="text-sm">
          {t("cancelledBy")}{" "}
          <Link className="underline" href={href(r.cancelledBy.id)}>
            {r.cancelledBy.number}
          </Link>
          {r.cancellationReason ? ` – ${r.cancellationReason}` : ""}
        </p>
      )}
      {r.rectifiedFields.length > 0 && (
        <p className="text-sm">
          {t("rectified")}: {r.rectifiedFields.join(", ")}
        </p>
      )}
      {r.corrections.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {r.corrections.map((c) => (
            <li key={c.id}>
              <Link className="underline" href={href(c.id)}>
                {label(c.type, c.correctionKind)} {c.number ?? t("draft")}
              </Link>{" "}
              {c.documentDate ? t("of", { date: formatDate(c.documentDate) }) : ""} · {money(c.grossCents)}
              {c.status === "cancelled" ? ` (${t("cancelled")})` : ""}
            </li>
          ))}
        </ul>
      )}
      {r.chain && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            {t("chain", { order: r.chain.order?.number ?? "—", date: formatDate(r.chain.order?.date) })}
          </p>
          {type === "final_invoice" && <p className="text-muted-foreground text-sm">{t("finalHint")}</p>}
          <ChainTable relations={r} />
          {r.deductions.length > 0 && (
            <p className="text-sm" data-testid="deductions">
              {t("deducted", {
                list: r.deductions.map((d) => `${d.advanceNumber} (${money(d.deductedGrossCents)})`).join(", "),
              })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Banner of a correction/chain draft above the editor: what this document is and what it may change. */
export function DraftBanner({ type, correctionKind }: { type: string; correctionKind?: string | null }) {
  const t = useTranslations("invoiceCorrections.banner");
  const key = docTypeKey(type, correctionKind);
  if (!["credit", "rectification", "advance_invoice", "partial_invoice", "final_invoice"].includes(key)) return null;
  return (
    <p className="rounded-lg border border-info/30 bg-info/5 p-3 text-sm" data-testid="draft-banner">
      {t(key as never)}
    </p>
  );
}

export const RECTIFIED_LABELS = RECTIFIED_FIELD_LABELS;
export const isChainDoc = (type: string) => CHAIN.includes(type);
