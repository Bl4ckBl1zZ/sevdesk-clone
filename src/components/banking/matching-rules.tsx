"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useDeferredValue, useId, useMemo, useState } from "react";
import { ConfirmDialog, formatDate, selectClass, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { checkRegex } from "@/domain/banking/rules";
import { formatCents, parseCents } from "@/domain/money";
import { TAX_RULE_LABEL_DE } from "@/domain/vouchers/tax-rules";
import { EXPENSE_TAX_RULES } from "@/domain/vouchers/types";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { Amount } from "./shared";

/**
 * Einstellungen › Bank › Regeln (F07 BNK-050…054, §6.4): rules by priority with mode badge and hits of the last 90
 * days; editor with condition builder, action and a live preview (BNK-051, no side effects); „Auf offene Umsätze
 * anwenden“ as the explicit act. Validation (RE2-safe regex, ignore only as suggestion) is re-checked in Convex.
 */

type RuleRow = FunctionReturnType<typeof api.matchingRules.list>[number];
type When = FunctionArgs<typeof api.matchingRules.preview>["when"];
type Apply = FunctionArgs<typeof api.matchingRules.create>["apply"];
type Action = Apply["action"];
type Suggestion = FunctionReturnType<typeof api.matchingRules.suggestions>[number];
type Draft = { name: string; when: When; apply: Apply };

const ACTIONS: readonly Action[] = ["categorize", "private", "transfer", "link_contact", "ignore"];

export function MatchingRules() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <MatchingRulesInner />
    </ConvexGuard>
  );
}

function MatchingRulesInner() {
  const t = useTranslations("bankRules");
  const rules = useAuthedQuery(api.matchingRules.list, {});
  const suggestions = useAuthedQuery(api.matchingRules.suggestions, {});
  const canWrite = useCan("bankRules.write");
  const [editing, setEditing] = useState<RuleRow | "new" | Draft | null>(null);
  const [deleting, setDeleting] = useState<RuleRow | null>(null);
  const run = useRun();
  const remove = useMutation(api.matchingRules.remove);
  if (!rules) return <div className="h-96" aria-busy="true" />;
  return (
    <div className="@container flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
        {canWrite && (
          <Button className="h-11 md:h-9" onClick={() => setEditing("new")}>
            <PlusIcon className="size-4" aria-hidden="true" />
            {t("new")}
          </Button>
        )}
      </div>
      {canWrite && suggestions && suggestions.length > 0 && (
        <section aria-labelledby="rule-suggestions" className="flex flex-col gap-2 rounded-md border border-dashed p-3">
          <h2 id="rule-suggestions" className="font-medium">
            {t("suggestionsTitle")}
          </h2>
          <ul className="flex flex-col gap-2">
            {suggestions.map((s: Suggestion) => (
              <li key={s.key} className="flex flex-col gap-2 @xl:flex-row @xl:items-center @xl:justify-between">
                <span className="text-sm">{s.message}</span>
                <Button
                  variant="outline"
                  className="h-11 md:h-9"
                  aria-label={t("suggestionCreate", { name: s.name })}
                  onClick={() => setEditing({ name: s.name, when: s.when as When, apply: s.apply as Apply })}
                >
                  <PlusIcon className="size-4" aria-hidden="true" />
                  {t("new")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {rules.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {rules.map((r) => (
            <li key={r._id} className="flex flex-col gap-2 rounded-md border p-3 @xl:flex-row @xl:items-center">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  <span className="text-muted-foreground tabular-nums">{r.priority}</span>
                  {r.name}
                  <Badge variant={r.mode === "auto" ? "default" : "secondary"}>{t(`mode.${r.mode}`)}</Badge>
                  {!r.enabled && <Badge variant="outline">{t("disabled")}</Badge>}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t(`action.${r.apply.action}`)}
                  {r.apply.account ? ` · ${r.apply.account}` : ""} · {t("hits", { count: r.hits90 })}
                </span>
              </div>
              {canWrite && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-11 md:size-9"
                    aria-label={t("edit", { name: r.name })}
                    onClick={() => setEditing(r)}
                  >
                    <PencilIcon className="size-4" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-11 md:size-9"
                    aria-label={t("delete", { name: r.name })}
                    onClick={() => setDeleting(r)}
                  >
                    <Trash2Icon className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {editing && (
        <RuleEditor
          rule={editing === "new" || !("_id" in editing) ? null : editing}
          {...(editing !== "new" && !("_id" in editing) ? { draft: editing } : {})}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t("deleteTitle")}
          description={t("deleteHint", { name: deleting.name })}
          confirmLabel={t("deleteConfirm")}
          destructive
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const r = await run(() => remove({ id: deleting._id }), t("deleted"));
            if (r.ok) setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

const centsText = (c: number | undefined) => (c === undefined ? "" : formatCents(c));

function RuleEditor({ rule, draft, onClose }: { rule: RuleRow | null; draft?: Draft; onClose: () => void }) {
  const t = useTranslations("bankRules");
  const run = useRun();
  const create = useMutation(api.matchingRules.create);
  const update = useMutation(api.matchingRules.update);
  const applyExisting = useAction(api.matchingRules.applyToExisting);
  const accounts = useAuthedQuery(api.banking.accounts, {});
  const contacts = useAuthedQuery(api.contacts.options, {});
  const [name, setName] = useState(rule?.name ?? draft?.name ?? "");
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [mode, setMode] = useState<"suggest" | "auto">(rule?.mode ?? "suggest");
  const [when, setWhen] = useState<When>(rule?.when ?? draft?.when ?? { direction: "out" });
  const [minText, setMinText] = useState(centsText(rule?.when.amountMinCents));
  const [maxText, setMaxText] = useState(centsText(rule?.when.amountMaxCents));
  const [mccText, setMccText] = useState((rule?.when.mccIn ?? []).join(", "));
  const [apply, setApply] = useState<Apply>(
    rule?.apply ?? draft?.apply ?? { action: "categorize", account: "", statementSufficesAsVoucher: false },
  );
  const ids = { name: useId(), prio: useId(), mode: useId(), action: useId(), enabled: useId() };

  const amount = (s: string) => {
    if (!s.trim()) return { ok: true as const, value: undefined };
    const r = parseCents(s.trim());
    return r.ok ? { ok: true as const, value: Math.abs(Number(r.value)) } : { ok: false as const };
  };
  const min = amount(minText);
  const max = amount(maxText);
  const regex = when.purposeRegex ? checkRegex(when.purposeRegex) : null;
  const effectiveWhen: When = useMemo(() => {
    const mcc = mccText
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    const w: When = { ...when };
    for (const k of Object.keys(w) as (keyof When)[]) if (w[k] === "" || w[k] === undefined) delete w[k];
    if (min.ok && min.value !== undefined) w.amountMinCents = min.value;
    else delete w.amountMinCents;
    if (max.ok && max.value !== undefined) w.amountMaxCents = max.value;
    else delete w.amountMaxCents;
    if (mcc.length > 0) w.mccIn = mcc;
    else delete w.mccIn;
    if (regex && !regex.ok) delete w.purposeRegex;
    return w;
  }, [when, mccText, min.ok, min.value, max.ok, max.value, regex]);
  const deferredWhen = useDeferredValue(effectiveWhen);
  const preview = useAuthedQuery(api.matchingRules.preview, { when: deferredWhen });

  const set = <K extends keyof When>(k: K, v: When[K] | "") =>
    setWhen((w) => ({ ...w, [k]: v === "" ? undefined : v }));
  const setA = <K extends keyof Apply>(k: K, v: Apply[K] | undefined) => setApply((a) => ({ ...a, [k]: v }));

  const prio = Number.parseInt(priority, 10);
  const valid =
    name.trim().length > 0 &&
    Number.isFinite(prio) &&
    min.ok &&
    max.ok &&
    (!regex || regex.ok) &&
    apply.action !== undefined;

  const cleanApply = (): Apply => {
    const a: Apply = { action: apply.action };
    if (apply.action === "categorize") {
      a.account = apply.account?.trim();
      if (apply.taxRule) a.taxRule = apply.taxRule;
      if (apply.statementSufficesAsVoucher) a.statementSufficesAsVoucher = true;
    }
    if (apply.action === "transfer" && apply.transferTarget) a.transferTarget = apply.transferTarget;
    if (apply.action === "link_contact" && apply.contactId) a.contactId = apply.contactId;
    return a;
  };

  const save = async () => {
    const body = { name: name.trim(), priority: prio, enabled, mode, when: effectiveWhen, apply: cleanApply() };
    const r = await run(
      () => (rule ? update({ id: rule._id, ...body }) : create(body)),
      rule ? t("saved") : t("created"),
    );
    if (r.ok) onClose();
  };

  const openHits = (preview?.hits ?? []).filter((h) => h.status === "open");
  const applyToOpen = async () => {
    if (!rule) return;
    const r = await run(() => applyExisting({ ruleId: rule._id, transactionIds: openHits.map((h) => h.id) }));
    if (r.ok) onClose();
  };

  const field = (label: string, k: keyof When, opts: { placeholder?: string; invalid?: string | null } = {}) => {
    const id = `rule-${String(k)}`;
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          value={(when[k] as string | undefined) ?? ""}
          placeholder={opts.placeholder}
          aria-invalid={!!opts.invalid}
          aria-describedby={opts.invalid ? `${id}-error` : undefined}
          onChange={(e) => set(k, e.target.value as never)}
        />
        {opts.invalid && (
          <p id={`${id}-error`} className="text-xs text-danger">
            {opts.invalid}
          </p>
        )}
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{rule ? t("editTitle") : t("newTitle")}</DialogTitle>
          <DialogDescription>{t("editorHint")}</DialogDescription>
        </DialogHeader>
        <div className="@container flex flex-col gap-4 text-sm">
          <div className="grid gap-3 @lg:grid-cols-[minmax(0,1fr)_8rem_10rem]">
            <div className="flex flex-col gap-1">
              <Label htmlFor={ids.name}>{t("name")}</Label>
              <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={ids.prio}>{t("priority")}</Label>
              <Input id={ids.prio} inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={ids.mode}>{t("modeLabel")}</Label>
              <select
                id={ids.mode}
                className={selectClass}
                value={mode}
                onChange={(e) => setMode(e.target.value as "suggest" | "auto")}
              >
                <option value="suggest">{t("mode.suggest")}</option>
                <option value="auto" disabled={apply.action === "ignore"}>
                  {t("mode.auto")}
                </option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id={ids.enabled} checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
            <Label htmlFor={ids.enabled}>{t("enabled")}</Label>
          </div>

          <fieldset className="flex flex-col gap-3 rounded-md border p-3">
            <legend className="px-1 font-medium">{t("conditions")}</legend>
            <div className="grid gap-3 @lg:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="rule-account">{t("when.account")}</Label>
                <select
                  id="rule-account"
                  className={selectClass}
                  value={when.accountId ?? ""}
                  onChange={(e) => set("accountId", e.target.value)}
                >
                  <option value="">{t("when.anyAccount")}</option>
                  {(accounts ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rule-direction">{t("when.direction")}</Label>
                <select
                  id="rule-direction"
                  className={selectClass}
                  value={when.direction ?? ""}
                  onChange={(e) => set("direction", e.target.value as "in" | "out" | "")}
                >
                  <option value="">{t("when.anyDirection")}</option>
                  <option value="out">{t("when.out")}</option>
                  <option value="in">{t("when.in")}</option>
                </select>
              </div>
              {field(t("when.purposeContains"), "purposeContains")}
              {field(t("when.purposeRegex"), "purposeRegex", {
                invalid: regex && !regex.ok ? regex.error.message : null,
              })}
              {field(t("when.counterpartyContains"), "counterpartyContains")}
              {field(t("when.merchantContains"), "merchantContains")}
              {field(t("when.ibanEquals"), "ibanEquals")}
              {field(t("when.currency"), "currency", { placeholder: "EUR" })}
              {field(t("when.bankTransactionCode"), "bankTransactionCode")}
              {field(t("when.proprietaryCode"), "proprietaryCode", { placeholder: "CARD_PAYMENT" })}
              <div className="flex flex-col gap-1">
                <Label htmlFor="rule-mcc">{t("when.mcc")}</Label>
                <Input
                  id="rule-mcc"
                  value={mccText}
                  placeholder="5734, 7372"
                  onChange={(e) => setMccText(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="rule-min">{t("when.min")}</Label>
                  <Input
                    id="rule-min"
                    inputMode="decimal"
                    value={minText}
                    aria-invalid={!min.ok}
                    onChange={(e) => setMinText(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="rule-max">{t("when.max")}</Label>
                  <Input
                    id="rule-max"
                    inputMode="decimal"
                    value={maxText}
                    aria-invalid={!max.ok}
                    onChange={(e) => setMaxText(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3 rounded-md border p-3">
            <legend className="px-1 font-medium">{t("actionLabel")}</legend>
            <div className="flex flex-col gap-1">
              <Label htmlFor={ids.action}>{t("actionLabel")}</Label>
              <select
                id={ids.action}
                className={selectClass}
                value={apply.action}
                onChange={(e) => {
                  const action = e.target.value as Action;
                  setApply({ action });
                  if (action === "ignore") setMode("suggest");
                }}
              >
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {t(`action.${a}`)}
                  </option>
                ))}
              </select>
            </div>
            {apply.action === "categorize" && (
              <div className="grid gap-3 @lg:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="rule-ledger">{t("apply.account")}</Label>
                  <Input
                    id="rule-ledger"
                    inputMode="numeric"
                    value={apply.account ?? ""}
                    placeholder="6855"
                    onChange={(e) => setA("account", e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="rule-tax">{t("apply.taxRule")}</Label>
                  <select
                    id="rule-tax"
                    className={selectClass}
                    value={apply.taxRule ?? ""}
                    onChange={(e) => setA("taxRule", e.target.value || undefined)}
                  >
                    <option value="">{t("apply.taxRuleDefault")}</option>
                    {EXPENSE_TAX_RULES.map((r) => (
                      <option key={r} value={r}>
                        {TAX_RULE_LABEL_DE[r]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2 @lg:col-span-2">
                  <Checkbox
                    id="rule-statement"
                    checked={apply.statementSufficesAsVoucher === true}
                    onCheckedChange={(v) => setA("statementSufficesAsVoucher", v === true)}
                  />
                  <Label htmlFor="rule-statement">{t("apply.statementSuffices")}</Label>
                </div>
              </div>
            )}
            {apply.action === "transfer" && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="rule-target">{t("apply.target")}</Label>
                <select
                  id="rule-target"
                  className={selectClass}
                  value={
                    apply.transferTarget?.kind === "bank"
                      ? apply.transferTarget.accountId
                      : apply.transferTarget?.kind === "cash"
                        ? "cash"
                        : ""
                  }
                  onChange={(e) =>
                    setA(
                      "transferTarget",
                      e.target.value === "cash"
                        ? { kind: "cash" }
                        : e.target.value
                          ? { kind: "bank", accountId: e.target.value as Id<"bankAccounts"> }
                          : undefined,
                    )
                  }
                >
                  <option value="">{t("apply.choose")}</option>
                  <option value="cash">{t("apply.cash")}</option>
                  {(accounts ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {apply.action === "link_contact" && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="rule-contact">{t("apply.contact")}</Label>
                <select
                  id="rule-contact"
                  className={selectClass}
                  value={apply.contactId ?? ""}
                  onChange={(e) => setA("contactId", (e.target.value || undefined) as Id<"contacts"> | undefined)}
                >
                  <option value="">{t("apply.choose")}</option>
                  {(contacts ?? []).map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.displayName} ({c.number})
                    </option>
                  ))}
                </select>
              </div>
            )}
            {apply.action === "ignore" && <p className="text-muted-foreground">{t("apply.ignoreHint")}</p>}
            {mode === "auto" && apply.action === "categorize" && !apply.statementSufficesAsVoucher && (
              <p className="text-muted-foreground">{t("apply.receiptMissingHint")}</p>
            )}
          </fieldset>

          <section aria-live="polite" className="flex flex-col gap-2 rounded-md border p-3">
            <h3 className="font-medium">{preview?.message ?? t("previewLoading")}</h3>
            {preview && preview.hits.length > 0 && (
              <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                {preview.hits.map((h) => (
                  <li key={h.id} className="flex flex-wrap justify-between gap-2">
                    <span className="min-w-0 truncate">
                      {formatDate(h.bookingDate)} · {h.counterpartyName ?? h.purpose}
                    </span>
                    <Amount cents={h.amountCents} currency={h.currency} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <DialogFooter className="flex-wrap gap-2">
          {rule && openHits.length > 0 && (
            <Button variant="outline" className="h-11 md:h-9" onClick={applyToOpen}>
              {t("applyToOpen", { count: openHits.length })}
            </Button>
          )}
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button className="h-11 md:h-9" disabled={!valid} onClick={save}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
