"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDownIcon, DownloadIcon, LockIcon, RefreshCwIcon, SendIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { EntityHistory } from "@/components/audit/entity-history";
import {
  ConfirmDialog,
  formatDate,
  formatDateTime,
  selectClass,
  todayBerlin,
  useCan,
  useRun,
} from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { InvoiceDunningSection } from "@/components/dunning/invoice-dunning-section";
import { DetailLayout, FactList, PageBody } from "@/components/layout/list-layout";
import { PageHeader } from "@/components/layout/page-header";
import { PaymentsSection } from "@/components/payments/payments-section";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  EXPORT_ENTRY_LABELS,
  type ExportEntry,
  POSTAL_HINT,
  SEND_CHANNEL_LABELS,
  SEND_CHANNELS,
  type SendChannel,
} from "@/domain/documents/dispatch";
import type { DisplayStatus } from "@/domain/documents/display-status";
import { DOC_TYPE_LABEL_DE, type DraftType, documentRoute, isLetterType } from "@/domain/documents/doc-types";
import type { DocumentSnapshot } from "@/domain/documents/snapshot";
import { formatMicros, formatMilli } from "@/domain/money/format";
import type { DraftValues } from "@/domain/schemas/documents";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { CorrectionActions, DraftBanner, docTypeKey, RelationsPanel } from "./corrections";
import { ChainCard, DocumentFlowActions } from "./document-actions";
import { InvoiceEditor } from "./invoice-editor";
import { DECISION_LABELS, downloadExport, FORMAT_LABELS, InvoiceStatusBadge, money } from "./invoice-shared";

type Detail = NonNullable<FunctionReturnType<typeof api.invoices.get>>;

const ARTIFACT_LABELS: Record<string, string> = {
  pdf: "PDF",
  zugferd_pdf: "ZUGFeRD-PDF",
  xrechnung_xml: "E-Rechnung (XML)",
  validation_report_kosit: "Prüfbericht KoSIT",
  validation_report_mustang: "Prüfbericht Mustang",
};
const VARIANT_LABELS: Record<string, string> = { original: "Original", copy: "Kopie", reading: "Lesefassung" };

const NAV_KEY: Partial<Record<string, "angebote" | "auftraege" | "lieferscheine">> = {
  quote: "angebote",
  order_confirmation: "auftraege",
  delivery_note: "lieferscheine",
};

/**
 * Beleg detail (F04 §6.3/§6.4) for invoices, proforma, quotes, order confirmations and delivery notes: the draft
 * editor, or the finalised document with next steps, chain, export, sent mark and dispatch history.
 */
export function InvoiceDetail({ id }: { id: string }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <InvoiceDetailInner id={id as Id<"salesDocuments">} />
    </ConvexGuard>
  );
}

function InvoiceDetailInner({ id }: { id: Id<"salesDocuments"> }) {
  const t = useTranslations("invoices.detail");
  const tDoc = useTranslations("documents.detail");
  const tNav = useTranslations("nav");
  const tc = useTranslations("invoiceCorrections");
  const data = useAuthedQuery(api.invoices.get, { id });
  const chain = useAuthedQuery(api.documentFlows.chain, { id });
  const canWrite = useCan("documents.write");
  if (data === undefined) return <div className="h-96" aria-busy="true" />;
  const type = (data?.doc.type ?? "invoice") as DraftType;
  const navKey = NAV_KEY[type] ?? "rechnungen";
  const crumbs = [{ label: tNav(`items.${navKey}`), href: documentRoute(type) as Route }];
  if (data === null) {
    return (
      <>
        <PageHeader title={tDoc("notFound")} breadcrumbs={crumbs} />
        <PageBody>
          <p role="alert">{tDoc("notFound")}</p>
        </PageBody>
      </>
    );
  }
  const status = data.displayStatus as { token: DisplayStatus; label: string };
  const typeLabel = DOC_TYPE_LABEL_DE[type];
  const letter = isLetterType(type);
  const kind = docTypeKey(data.doc.type, data.doc.correctionKind);
  if (data.doc.status === "draft") {
    const draftTitle = letter ? tDoc("draftTitle", { label: typeLabel }) : tc(`draftTitles.${kind}` as never);
    return (
      <>
        <PageHeader
          title={draftTitle}
          description={data.doc.contactName ?? t("noCustomer")}
          breadcrumbs={[...crumbs, { label: draftTitle }]}
        />
        <PageBody>
          <DraftBanner type={data.doc.type} correctionKind={data.doc.correctionKind ?? null} />
          <RelationsPanel id={id} type={data.doc.type} />
          {canWrite && "values" in data && data.values ? (
            <InvoiceEditor
              id={id}
              initial={data.values as DraftValues}
              version={data.doc.version}
              type={type}
              chainRoot={data.doc.chainRootId === undefined}
            />
          ) : (
            <p>{t("readOnlyDraft")}</p>
          )}
          <ChainCard chain={chain} />
          <EntityHistory table="salesDocuments" id={id} />
        </PageBody>
      </>
    );
  }
  const number = data.doc.number ?? "";
  return (
    <>
      <PageHeader
        title={
          letter ? tDoc("title", { label: typeLabel, number }) : tc(`titles.${kind}` as "titles.invoice", { number })
        }
        description={`${data.doc.contactName ?? ""} · ${status.label}`}
        breadcrumbs={[...crumbs, { label: number }]}
        actions={
          <>
            <CorrectionActions doc={data.doc} snapshot={data.snapshot as DocumentSnapshot | null} />
            <FinalActions data={data} />
          </>
        }
      />
      <DetailLayout aside={<Facts data={data} />}>
        <div className="flex flex-wrap items-center gap-2">
          <InvoiceStatusBadge token={status.token} label={status.label} />
          <span className="inline-flex items-center gap-1 text-muted-foreground text-sm">
            <LockIcon className="size-3.5" aria-hidden="true" />
            {t("locked")}
          </span>
        </div>
        <ArtifactState data={data} />
        <DocumentFlowActions doc={data.doc} targets={chain?.targets ?? []} />
        <ChainCard chain={chain} />
        <RelationsPanel id={id} type={data.doc.type} />
        <SnapshotView snapshot={data.snapshot as DocumentSnapshot | null} />
        {data.doc.status !== "cancelled" && <PaymentsSection documentId={data.doc._id} number={number} />}
        {data.doc.status !== "cancelled" && <InvoiceDunningSection invoiceId={data.doc._id} type={data.doc.type} />}
        <Files data={data} />
        <SendLog data={data} />
        <EntityHistory table="salesDocuments" id={data.doc._id} />
      </DetailLayout>
    </>
  );
}

function ArtifactState({ data }: { data: Detail }) {
  const t = useTranslations("invoices.detail");
  const run = useRun();
  const retry = useMutation(api.invoices.retryArtifacts);
  const canFinalize = useCan("invoices.finalize");
  if (data.doc.artifactStatus === "ready") return null;
  if (data.doc.artifactStatus === "blocked") {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm"
      >
        <span>
          {t("artifactsBlocked")}
          {data.doc.artifactError ? ` (${data.doc.artifactError})` : ""}
        </span>
        {canFinalize && (
          <Button
            variant="outline"
            className="h-11 md:h-9"
            onClick={() => void run(() => retry({ id: data.doc._id }), t("retryStarted"))}
          >
            <RefreshCwIcon aria-hidden="true" />
            {t("retry")}
          </Button>
        )}
      </div>
    );
  }
  return (
    <p role="status" className="rounded-lg border border-info/30 bg-info/5 p-3 text-sm" data-testid="artifacts-pending">
      {t("artifactsPending")}
    </p>
  );
}

function FinalActions({ data }: { data: Detail }) {
  const t = useTranslations("invoices.detail");
  const run = useRun();
  const exportFiles = useAction(api.documentArtifacts.exportFiles);
  const canSend = useCan("invoices.send");
  const [markOpen, setMarkOpen] = useState(false);
  const [originalEntry, setOriginalEntry] = useState<ExportEntry | null>(null);
  const ready = data.doc.artifactStatus === "ready";
  const marked = data.doc.sentAt !== undefined;
  const doExport = async (entry: ExportEntry, original = false, reason?: string) => {
    const r = await run(async () => {
      const res = await exportFiles({
        id: data.doc._id,
        request: { entry, ...(original ? { original: true } : {}), ...(reason ? { reason } : {}) },
      });
      await downloadExport(res.files, res.zipName);
      return res;
    }, t("exported"));
    return r.ok;
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" className="h-11 md:h-9" disabled={!ready} />}>
          <DownloadIcon aria-hidden="true" />
          {t("export")}
          <ChevronDownIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {data.exportEntries.map((e) => (
            <DropdownMenuItem key={e} onClick={() => void doExport(e as ExportEntry)}>
              {EXPORT_ENTRY_LABELS[e as ExportEntry]}
              {marked ? ` (${t("copy")})` : ""}
            </DropdownMenuItem>
          ))}
          {marked && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setOriginalEntry((data.exportEntries[0] as ExportEntry) ?? "default")}>
                {t("exportOriginal")}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <p className="px-2 py-1.5 text-muted-foreground text-xs" data-testid="postal-hint">
            {POSTAL_HINT}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      {canSend && (
        <Button className="h-11 md:h-9" disabled={!ready} onClick={() => setMarkOpen(true)}>
          <SendIcon aria-hidden="true" />
          {marked ? t("markAgain") : t("markSent")}
        </Button>
      )}
      {markOpen && <MarkSentDialog data={data} onClose={() => setMarkOpen(false)} />}
      {originalEntry && (
        <ReasonDialog
          title={t("exportOriginal")}
          description={t("exportOriginalHint")}
          confirmLabel={t("export")}
          onClose={() => setOriginalEntry(null)}
          onConfirm={async (reason) => {
            if (await doExport(originalEntry, true, reason)) setOriginalEntry(null);
          }}
        />
      )}
    </>
  );
}

function ReasonDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useTranslations("invoices.detail");
  const [reason, setReason] = useState("");
  const rid = useId();
  return (
    <ConfirmDialog
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      confirmDisabled={!reason.trim()}
      onConfirm={() => onConfirm(reason.trim())}
      onClose={onClose}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={rid} className="font-medium text-sm">
          {t("reason")}
        </label>
        <Textarea id={rid} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}

const ELECTRONIC: readonly SendChannel[] = ["email_manual", "upload_portal"];

/** „Als versendet markieren“ (SND-07, MAIL-02): date, channel, note and the handed-over files (hashes recorded). */
function MarkSentDialog({ data, onClose }: { data: Detail; onClose: () => void }) {
  const t = useTranslations("invoices.mark");
  const run = useRun();
  const markSent = useMutation(api.invoices.markSent);
  const [sentOn, setSentOn] = useState(todayBerlin());
  const [channel, setChannel] = useState<SendChannel>("email_manual");
  const [note, setNote] = useState("");
  const [electronic, setElectronic] = useState(false);
  const selectable = data.artifacts.filter((a) => !a.kind.startsWith("validation_report"));
  const [selected, setSelected] = useState<string[]>(
    data.defaultMarkSelection.length > 0 ? data.defaultMarkSelection : selectable.map((a) => a._id),
  );
  const ids = { date: useId(), channel: useId(), note: useId() };
  const mustE = data.doc.einvoice.decision === "MUST_E";
  const buyer = data.buyer as { invoiceEmail?: string } | null;
  return (
    <ConfirmDialog
      title={t("title")}
      description={t("description")}
      confirmLabel={t("confirm")}
      confirmDisabled={selected.length === 0}
      onConfirm={async () => {
        const r = await run(
          () =>
            markSent({
              id: data.doc._id,
              values: {
                sentOn,
                channel,
                ...(note.trim() ? { note: note.trim() } : {}),
                ...(channel === "other" && electronic ? { electronicConfirmed: true } : {}),
                artifactIds: selected,
              },
            }),
          t("done"),
        );
        if (r.ok) {
          onClose();
        }
      }}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        {!buyer?.invoiceEmail && <p className="text-sm text-warning">{t("noInvoiceEmail")}</p>}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.date} className="font-medium text-sm">
            {t("sentOn")}
          </label>
          <Input
            id={ids.date}
            type="date"
            max={todayBerlin()}
            value={sentOn}
            onChange={(e) => setSentOn(e.target.value)}
            className="h-11 md:h-9"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.channel} className="font-medium text-sm">
            {t("channel")}
          </label>
          <select
            id={ids.channel}
            className={selectClass}
            value={channel}
            onChange={(e) => setChannel(e.target.value as SendChannel)}
          >
            {SEND_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {SEND_CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
          {mustE && !ELECTRONIC.includes(channel) && channel !== "other" && (
            <p role="alert" className="text-danger text-sm">
              {t("mustE")}
            </p>
          )}
        </div>
        {channel === "other" && (
          <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
            <input
              type="checkbox"
              className="size-5 accent-primary md:size-4"
              checked={electronic}
              onChange={(e) => setElectronic(e.target.checked)}
            />
            {t("electronic")}
          </label>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.note} className="font-medium text-sm">
            {t("note")}
          </label>
          <Textarea id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 font-medium text-sm">{t("files")}</legend>
          {selectable.map((a) => (
            <label key={a._id} className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
              <input
                type="checkbox"
                className="size-5 accent-primary md:size-4"
                checked={selected.includes(a._id)}
                onChange={(e) => setSelected((s) => (e.target.checked ? [...s, a._id] : s.filter((x) => x !== a._id)))}
              />
              {a.name} · {ARTIFACT_LABELS[a.kind] ?? a.kind} ({VARIANT_LABELS[a.variant] ?? a.variant})
            </label>
          ))}
        </fieldset>
      </div>
    </ConfirmDialog>
  );
}

function Facts({ data }: { data: Detail }) {
  const t = useTranslations("invoices.detail");
  const tDoc = useTranslations("documents.detail");
  const s = data.snapshot as DocumentSnapshot | null;
  const d = data.doc;
  const invoice = d.type === "invoice";
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4" aria-label={t("facts")}>
      <FactList
        items={[
          { label: t("number"), value: d.number ?? "—" },
          ...(d.revision && d.revision > 1 ? [{ label: tDoc("revision"), value: String(d.revision) }] : []),
          { label: invoice ? t("documentDate") : tDoc("documentDate"), value: formatDate(d.documentDate) },
          ...(d.dueDate ? [{ label: t("dueDate"), value: formatDate(d.dueDate) }] : []),
          ...(d.validUntil ? [{ label: tDoc("validUntil"), value: formatDate(d.validUntil) }] : []),
          ...(d.type !== "delivery_note" || d.showPrices
            ? [{ label: t("gross"), value: money(d.totals.grossCents, d.currency), numeric: true }]
            : []),
          ...(invoice
            ? [
                { label: t("format"), value: FORMAT_LABELS[s?.einvoice.format ?? ""] ?? "—" },
                { label: t("decision"), value: DECISION_LABELS[d.einvoice.decision ?? ""] ?? "—" },
              ]
            : []),
          ...(d.acceptance
            ? [
                {
                  label: tDoc("acceptance"),
                  value: tDoc("acceptanceValue", { date: formatDate(d.acceptance.date), name: d.acceptance.byName }),
                },
              ]
            : []),
          ...(d.rejection ? [{ label: tDoc("rejection"), value: formatDate(d.rejection.date) }] : []),
          ...(d.received
            ? [
                {
                  label: tDoc("received"),
                  value: tDoc("receivedValue", { date: formatDate(d.received.date), name: d.received.byName }),
                },
              ]
            : []),
          ...(d.cancellation && d.type !== "invoice"
            ? [{ label: tDoc("cancellation"), value: d.cancellation.reason }]
            : []),
          { label: t("sentOn"), value: formatDate(d.sentOn) },
          ...(data.register
            ? [{ label: t("register"), value: `${data.register.number} (${formatDateTime(data.register.assignedAt)})` }]
            : []),
        ]}
      />
      {data.doc.contactId && (
        <Link href={`/kontakte/${data.doc.contactId}` as Route} className="text-sm underline">
          {t("toContact")}
        </Link>
      )}
    </section>
  );
}

function SnapshotView({ snapshot }: { snapshot: DocumentSnapshot | null }) {
  const t = useTranslations("invoices.detail");
  const tDoc = useTranslations("documents.detail");
  if (!snapshot) return null;
  const priced = snapshot.type !== "delivery_note" || snapshot.flags.showPrices === true;
  const optionalMark = (l: { optional?: boolean }) => (l.optional ? ` (${tDoc("optional")})` : "");
  const items = snapshot.lines.filter((l) => l.kind === "item");
  const b = snapshot.buyer;
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4" aria-label={t("content")}>
      <address className="text-sm not-italic">
        <span className="font-medium">{b.name}</span>
        {b.contactPerson ? <span className="block">z. Hd. {b.contactPerson.name}</span> : null}
        {b.address && (
          <span className="block">
            {b.address.street}, {b.address.postalCode} {b.address.city}
          </span>
        )}
      </address>
      {/* The frozen texts of the document (DOC-17), e.g. „Grund der Stornierung: …“ of a Storno (F04 §4.8). */}
      {snapshot.texts.subject && <p className="font-medium text-sm">{snapshot.texts.subject}</p>}
      {snapshot.texts.headText && <p className="whitespace-pre-line text-sm">{snapshot.texts.headText}</p>}
      {/* Narrow containers (phones) get a stacked list instead of a horizontally scrolling table. */}
      <div className="@container/lines">
        <ul className="flex flex-col divide-y text-sm @xl/lines:hidden">
          {items.map((l) =>
            l.kind === "item" ? (
              <li key={l.position} className="flex flex-col gap-0.5 py-2">
                <span className="flex justify-between gap-3">
                  <span className="min-w-0 font-medium">
                    {l.position}. {l.name}
                    {optionalMark(l)}
                  </span>
                  {priced && <span className="tabular-nums">{money(l.netCents, snapshot.currency)}</span>}
                </span>
                {l.description && <span className="text-muted-foreground text-xs">{l.description}</span>}
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatMilli(l.quantityMilli)} {l.unitLabel ?? l.unitCode} × {formatMicros(l.unitPriceMicros)} ·{" "}
                  {t("vat")} {l.vatCategory} {(l.vatRateBp / 100).toLocaleString("de-DE")} %
                </span>
              </li>
            ) : null,
          )}
        </ul>
        <div className="hidden @xl/lines:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("pos")}</TableHead>
                <TableHead>{t("item")}</TableHead>
                <TableHead className="text-right">{t("qty")}</TableHead>
                <TableHead className="text-right">{t("unitPrice")}</TableHead>
                <TableHead className="text-right">{t("vat")}</TableHead>
                <TableHead className="text-right">{t("net")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((l) =>
                l.kind === "item" ? (
                  <TableRow key={l.position}>
                    <TableCell className="tabular-nums">{l.position}</TableCell>
                    <TableCell>
                      {l.name}
                      {optionalMark(l)}
                      {l.description && <span className="block text-muted-foreground text-xs">{l.description}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMilli(l.quantityMilli)} {l.unitLabel ?? l.unitCode}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatMicros(l.unitPriceMicros)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {l.vatCategory} {(l.vatRateBp / 100).toLocaleString("de-DE")} %
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(l.netCents, snapshot.currency)}</TableCell>
                  </TableRow>
                ) : null,
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      {priced && (
        <dl className="ml-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("net")}</dt>
          <dd className="text-right tabular-nums">{money(snapshot.totals.netCents, snapshot.currency)}</dd>
          <dt className="text-muted-foreground">{t("vatTotal")}</dt>
          <dd className="text-right tabular-nums">{money(snapshot.totals.vatCents, snapshot.currency)}</dd>
          <dt className="font-semibold">{t("gross")}</dt>
          <dd className="text-right font-semibold tabular-nums">
            {money(snapshot.totals.grossCents, snapshot.currency)}
          </dd>
        </dl>
      )}
      {snapshot.texts.footText && <p className="whitespace-pre-line text-sm">{snapshot.texts.footText}</p>}
      {snapshot.notes.length > 0 && (
        <ul className="flex flex-col gap-1 text-muted-foreground text-sm">
          {snapshot.notes.map((n) => (
            <li key={n.id}>{n.de}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Files({ data }: { data: Detail }) {
  const t = useTranslations("invoices.detail");
  if (data.artifacts.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 rounded-xl border p-4" aria-label={t("files")}>
      <h2 className="font-semibold text-base">{t("files")}</h2>
      <ul className="flex flex-col gap-1 text-sm" data-testid="artifacts">
        {data.artifacts.map((a) => (
          <li key={a._id} className="flex flex-col">
            <span>
              {a.name} · {ARTIFACT_LABELS[a.kind] ?? a.kind} ({VARIANT_LABELS[a.variant] ?? a.variant})
            </span>
            <span className="break-all font-mono text-muted-foreground text-xs">SHA-256 {a.sha256}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SendLog({ data }: { data: Detail }) {
  const t = useTranslations("invoices.detail");
  const run = useRun();
  const retract = useMutation(api.invoices.retractMark);
  const canSend = useCan("invoices.send");
  const [target, setTarget] = useState<string | null>(null);
  const retracted = new Set(data.sendLog.filter((r) => r.kind === "retraction").map((r) => r.retractsId));
  return (
    <section className="flex flex-col gap-2 rounded-xl border p-4" aria-label={t("sendLog")}>
      <h2 className="font-semibold text-base">{t("sendLog")}</h2>
      {data.sendLog.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("notSent")}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm" data-testid="send-log">
          {data.sendLog.map((r) => (
            <li key={r._id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
              <span>
                {r.kind === "mark_sent"
                  ? t("markedOn", {
                      date: formatDate(r.sentOn),
                      channel: SEND_CHANNEL_LABELS[r.channel as SendChannel],
                    })
                  : t("retractedOn", { date: formatDateTime(r.at) })}
                {r.note ? ` – ${r.note}` : ""}
                {retracted.has(r._id) ? ` (${t("retracted")})` : ""}
              </span>
              {canSend && r.kind === "mark_sent" && !retracted.has(r._id) && (
                <Button variant="ghost" className="h-11 md:h-9" onClick={() => setTarget(r._id)}>
                  {t("retract")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {target && (
        <ReasonDialog
          title={t("retractTitle")}
          description={t("retractHint")}
          confirmLabel={t("retract")}
          onClose={() => setTarget(null)}
          onConfirm={async (reason) => {
            const r = await run(
              () => retract({ id: data.doc._id, values: { retractsId: target, reason } }),
              t("retractDone"),
            );
            if (r.ok) setTarget(null);
          }}
        />
      )}
    </section>
  );
}
