"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { PaperclipIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { uploadFile } from "@/components/banking/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { adapterErrorReason } from "@/components/setup/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { buildManualLines, MANUAL_TAX_KEYS, type ManualLineInput } from "@/domain/accounting/manual-entry";
import { parseCents } from "@/domain/money/parse";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { euro } from "./format";
import { SELECT } from "./journal-viewer";

const berlinToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

interface LineState {
  key: number;
  account: string;
  debit: string;
  credit: string;
  taxKey: string;
  costCenterId: string;
  contactId: string;
}

let nextKey = 1;
const blankLine = (patch: Partial<LineState> = {}): LineState => ({
  key: nextKey++,
  account: "",
  debit: "",
  credit: "",
  taxKey: "",
  costCenterId: "",
  contactId: "",
  ...patch,
});

const amount = (s: string): number | null => {
  if (s.trim() === "") return 0;
  const r = parseCents(s);
  return r.ok ? r.value : null;
};

/**
 * Manual journal entry editor (F08 §6 /buchhaltung/journal/neu; ACC-011, GOBD-07): date, text, line grid (Konto with
 * autocomplete, Soll, Haben, Steuer, Kostenstelle, Kontakt), templates, mandatory Beleg, live balance bar and the
 * preview of the resulting journal lines (gross tax-key lines split into net and VAT). Desktop-first: on narrow
 * containers only the notice is shown.
 */
export function ManualEntryEditor() {
  const t = useTranslations("manualEntry");
  return (
    <ConvexGuard fallback={null}>
      <p className="rounded-lg border p-4 text-sm @3xl/main:hidden">{t("mobileNotice")}</p>
      <div className="hidden @3xl/main:block">
        <Editor />
      </div>
    </ConvexGuard>
  );
}

function Editor() {
  const t = useTranslations("manualEntry");
  const router = useRouter();
  const base = useId();
  const ids = {
    date: `${base}-date`,
    text: `${base}-text`,
    long: `${base}-long`,
    template: `${base}-template`,
    files: `${base}-files`,
    contact: `${base}-contact`,
  };
  const [date, setDate] = useState(berlinToday());
  const [text, setText] = useState("");
  const [longText, setLongText] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [lines, setLines] = useState<LineState[]>([blankLine(), blankLine()]);
  const [files, setFiles] = useState<File[]>([]);
  const [contactQuery, setContactQuery] = useState("");
  const [ackVat, setAckVat] = useState(false);
  const [busy, setBusy] = useState(false);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);

  const chart = useAuthedQuery(api.accounting.chartOfAccounts, {});
  const templates = useAuthedQuery(api.manualEntries.templates, validDate ? { date } : {}) ?? [];
  const costCenters = (useAuthedQuery(api.lookups.listCostCenters, {}) ?? []).filter((c) => c.archivedAt === null);
  const contacts = useAuthedQuery(api.contacts.options, contactQuery ? { q: contactQuery } : {}) ?? [];
  const uploadUrl = useMutation(api.manualEntries.generateUploadUrl);
  const create = useMutation(api.manualEntries.create);
  const showError = useAdapterErrorToast();

  const accounts = useMemo(() => new Map((chart?.accounts ?? []).map((a) => [a.number, a])), [chart]);
  const vatAccounts = useMemo(
    () =>
      new Set(
        (chart?.roles ?? []).filter((r) => r.role.startsWith("vat.") && r.account).map((r) => r.account as string),
      ),
    [chart],
  );

  const parsed = lines.map((l) => ({ l, debit: amount(l.debit), credit: amount(l.credit) }));
  const invalidAmount = parsed.some((p) => p.debit === null || p.credit === null);
  const debitSum = parsed.reduce((s, p) => s + (p.debit ?? 0), 0);
  const creditSum = parsed.reduce((s, p) => s + (p.credit ?? 0), 0);
  const diff = debitSum - creditSum;
  const inputLines: ManualLineInput[] = parsed
    .filter((p) => p.l.account.trim() !== "" || (p.debit ?? 0) > 0 || (p.credit ?? 0) > 0)
    .map((p) => ({
      account: p.l.account.trim(),
      debitCents: p.debit ?? 0,
      creditCents: p.credit ?? 0,
      ...(p.l.taxKey ? { taxKey: p.l.taxKey } : {}),
      ...(p.l.costCenterId ? { costCenterId: p.l.costCenterId } : {}),
      ...(p.l.contactId ? { contactId: p.l.contactId } : {}),
    }));
  const preview =
    chart && validDate && !invalidAmount
      ? buildManualLines(
          { date, text: text || "–", lines: inputLines, attachmentCount: Math.max(1, files.length) },
          {
            accountType: (nr) => accounts.get(nr)?.type ?? null,
            vatAccounts,
            acknowledged: ackVat ? ["E-ACC-10"] : [],
          },
        )
      : null;
  const vatWarning = preview?.ok ? preview.value.warnings.find((w) => w.code === "E-ACC-10") : undefined;
  const needsVatAck = inputLines.some((l) => vatAccounts.has(l.account));

  const applyTemplate = (key: string) => {
    setTemplateKey(key);
    const tpl = templates.find((x) => x.key === key);
    if (!tpl) return;
    setText(tpl.text);
    setLines(tpl.lines.map((l) => blankLine({ account: l.account ?? "", taxKey: l.taxKey ?? "" })));
  };
  const patch = (key: number, p: Partial<LineState>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const template = templates.find((x) => x.key === templateKey);

  const submit = async () => {
    setBusy(true);
    try {
      const attachments: { storageId: Id<"_storage">; name: string }[] = [];
      for (const f of files) attachments.push({ storageId: await uploadFile(await uploadUrl({}), f), name: f.name });
      const r = await create({
        date,
        text,
        ...(longText.trim() ? { longText } : {}),
        ...(templateKey ? { templateKey } : {}),
        lines: inputLines,
        attachments,
        ...(ackVat ? { acknowledgedWarnings: ["E-ACC-10"] } : {}),
      });
      toast.success(t("done", { seq: r.seq }));
      router.push("/buchhaltung/journal" as Route);
    } catch (e) {
      if (adapterErrorReason(e) === "WARNINGS_UNACKNOWLEDGED") setAckVat(false);
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const balanced = diff === 0 && debitSum > 0;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted-foreground text-sm">{t("intro")}</p>
      <div className="grid grid-cols-4 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.template}>{t("template")}</Label>
          <select
            id={ids.template}
            className={SELECT}
            value={templateKey}
            onChange={(e) => applyTemplate(e.target.value)}
          >
            <option value="">{t("noTemplate")}</option>
            {templates.map((x) => (
              <option key={x.key} value={x.key}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.date}>{t("date")}</Label>
          <Input
            id={ids.date}
            type="date"
            className="h-9"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </div>
        <div className="col-span-2 flex flex-col gap-1.5">
          <Label htmlFor={ids.text}>{t("text")}</Label>
          <Input
            id={ids.text}
            className="h-9"
            maxLength={60}
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
          />
        </div>
      </div>
      {template?.hint && <p className="rounded-md border bg-muted p-3 text-sm">{template.hint}</p>}

      <datalist id={`${ids.template}-accounts`}>
        {(chart?.accounts ?? [])
          .filter((a) => !a.archived)
          .map((a) => (
            <option key={a.number} value={a.number}>
              {a.name}
            </option>
          ))}
      </datalist>
      <section aria-labelledby={`${ids.template}-lines`} className="flex flex-col gap-2">
        <div className="flex items-end justify-between gap-3">
          <h2 id={`${ids.template}-lines`} className="font-medium">
            {t("lines")}
          </h2>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.contact}>{t("contactSearch")}</Label>
            <Input
              id={ids.contact}
              type="search"
              className="h-9 w-64"
              value={contactQuery}
              onChange={(e) => setContactQuery(e.target.value)}
            />
          </div>
        </div>
        <Table aria-label={t("lines")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("account")}</TableHead>
              <TableHead className="text-right">{t("debit")}</TableHead>
              <TableHead className="text-right">{t("credit")}</TableHead>
              <TableHead>{t("taxKey")}</TableHead>
              <TableHead>{t("costCenter")}</TableHead>
              <TableHead>{t("contact")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("removeLine")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, i) => {
              const acc = accounts.get(l.account.trim());
              const n = i + 1;
              return (
                <TableRow key={l.key}>
                  <TableCell className="min-w-56 whitespace-normal">
                    <Input
                      aria-label={t("accountOf", { n })}
                      list={`${ids.template}-accounts`}
                      inputMode="numeric"
                      className="h-9 font-mono"
                      value={l.account}
                      onChange={(e) => patch(l.key, { account: e.target.value })}
                    />
                    <span className="mt-1 block text-muted-foreground text-xs">
                      {l.account.trim() === ""
                        ? " "
                        : acc
                          ? `${acc.name} · ${t(`types.${acc.type}`)}`
                          : t("unknownAccount")}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={t("debitOf", { n })}
                      inputMode="decimal"
                      className="h-9 w-32 text-right tabular-nums"
                      value={l.debit}
                      aria-invalid={amount(l.debit) === null}
                      onChange={(e) =>
                        patch(l.key, { debit: e.target.value, ...(e.target.value ? { credit: "" } : {}) })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={t("creditOf", { n })}
                      inputMode="decimal"
                      className="h-9 w-32 text-right tabular-nums"
                      value={l.credit}
                      aria-invalid={amount(l.credit) === null}
                      onChange={(e) =>
                        patch(l.key, { credit: e.target.value, ...(e.target.value ? { debit: "" } : {}) })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <select
                      aria-label={t("taxKeyOf", { n })}
                      className={SELECT}
                      value={l.taxKey}
                      onChange={(e) => patch(l.key, { taxKey: e.target.value })}
                    >
                      <option value="">–</option>
                      {MANUAL_TAX_KEYS.map((k) => (
                        <option key={k} value={k}>
                          {t(`taxKeys.${k}`)}
                        </option>
                      ))}
                    </select>
                  </TableCell>
                  <TableCell>
                    <select
                      aria-label={t("costCenterOf", { n })}
                      className={SELECT}
                      value={l.costCenterId}
                      onChange={(e) => patch(l.key, { costCenterId: e.target.value })}
                    >
                      <option value="">–</option>
                      {costCenters.map((c) => (
                        <option key={c.costCenterId} value={c.costCenterId}>
                          {c.number} {c.name}
                        </option>
                      ))}
                    </select>
                  </TableCell>
                  <TableCell>
                    <select
                      aria-label={t("contactOf", { n })}
                      className={`${SELECT} max-w-48`}
                      value={l.contactId}
                      onChange={(e) => patch(l.key, { contactId: e.target.value })}
                    >
                      <option value="">–</option>
                      {contacts.map((c) => (
                        <option key={c._id} value={c._id}>
                          {c.number} {c.displayName}
                        </option>
                      ))}
                    </select>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("removeLineOf", { n })}
                      disabled={lines.length <= 2}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <Button variant="outline" className="h-9 self-start" onClick={() => setLines((ls) => [...ls, blankLine()])}>
          <PlusIcon aria-hidden="true" />
          {t("addLine")}
        </Button>
        <output
          aria-live="polite"
          className={`rounded-md border p-3 font-medium text-sm tabular-nums ${balanced ? "border-success bg-success/10" : "border-warning bg-warning/10"}`}
        >
          {t("balance", { debit: euro(debitSum), credit: euro(creditSum), diff: euro(Math.abs(diff)) })}
        </output>
        {invalidAmount && (
          <p className="text-destructive text-sm" role="alert">
            {t("invalidAmount")}
          </p>
        )}
      </section>

      <section aria-labelledby={`${ids.files}-h`} className="flex flex-col gap-2">
        <h2 id={`${ids.files}-h`} className="font-medium">
          {t("attachments")}
        </h2>
        <Label
          htmlFor={ids.files}
          className="flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-4 font-normal text-sm"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setFiles((fs) => [...fs, ...Array.from(e.dataTransfer.files)].slice(0, 10));
          }}
        >
          <PaperclipIcon aria-hidden="true" className="size-5" />
          {t("dropZone")}
        </Label>
        <input
          id={ids.files}
          type="file"
          multiple
          accept="application/pdf,image/*"
          className="sr-only"
          onChange={(e) => setFiles((fs) => [...fs, ...Array.from(e.target.files ?? [])].slice(0, 10))}
        />
        {files.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("attachmentRequired")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {files.map((f) => (
              <li key={`${f.name}-${f.size}-${f.lastModified}`} className="flex items-center gap-2">
                <span className="truncate">{f.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setFiles((fs) => fs.filter((x) => x !== f))}
                  aria-label={t("removeFile", { name: f.name })}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.long}>{t("longText")}</Label>
          <Textarea id={ids.long} value={longText} maxLength={500} onChange={(e) => setLongText(e.target.value)} />
        </div>
      </section>

      <section aria-labelledby={`${ids.date}-preview`} className="flex flex-col gap-2">
        <h2 id={`${ids.date}-preview`} className="font-medium">
          {t("preview")}
        </h2>
        {preview && !preview.ok ? (
          <p className="text-muted-foreground text-sm">{preview.error.message}</p>
        ) : preview?.ok ? (
          <Table aria-label={t("preview")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("account")}</TableHead>
                <TableHead>{t("taxKey")}</TableHead>
                <TableHead className="text-right">{t("debit")}</TableHead>
                <TableHead className="text-right">{t("credit")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.value.lines.map((l, i) => {
                const nr = l.account ?? chart?.roles.find((r) => r.role === l.role)?.account ?? "";
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: preview lines have no id
                  <TableRow key={i}>
                    <TableCell>
                      <span className="font-mono">{nr}</span> {accounts.get(nr)?.name ?? ""}
                    </TableCell>
                    <TableCell>{l.taxKey ?? (l.role ? t("vatLine") : "")}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.debitCents ? euro(l.debitCents) : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {l.creditCents ? euro(l.creditCents) : ""}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
      </section>

      {(vatWarning || (needsVatAck && ackVat)) && (
        <div className="flex items-start gap-2 rounded-md border border-warning bg-warning/10 p-3">
          <Checkbox id={`${ids.date}-ack`} checked={ackVat} onCheckedChange={(v) => setAckVat(v === true)} />
          <Label htmlFor={`${ids.date}-ack`} className="font-normal leading-snug">
            {t("vatAck")}
          </Label>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" className="h-9" onClick={() => router.push("/buchhaltung/journal" as Route)}>
          {t("cancel")}
        </Button>
        <Button
          className="h-9"
          disabled={busy || !balanced || files.length === 0 || text.trim() === "" || !preview?.ok || !!vatWarning}
          onClick={submit}
        >
          {t("submit")}
        </Button>
      </div>
    </div>
  );
}
