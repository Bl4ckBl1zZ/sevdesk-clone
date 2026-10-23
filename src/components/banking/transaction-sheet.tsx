"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ConfirmDialog, formatDate, formatDateTime, selectClass, useCan, useRun } from "@/components/catalog/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { parseCents } from "@/domain/money/parse";
import { IGNORE_REASON_LABEL_DE, IGNORE_REASON_VALUES } from "@/domain/schemas/banking";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { Amount, money, SOURCE_LABEL, StatusBadge } from "./shared";

type Mark = "private" | "transfer" | "cash_withdrawal" | "ignored" | "loan";

/**
 * Transaction detail (F07 §6): booked data (immutable, BNK-122), sources and revisions (BNK-110/113), postings and
 * Eigenbelege, actions Privat / Geldtransit / Bargeld in die Kasse / Ignorieren (BNK-060/061/063, CSH-025),
 * „Markierung aufheben“ and the bank-reversal link (BNK-121).
 */
export function TransactionSheet({
  id,
  currency,
  onClose,
}: {
  id: Id<"bankTransactions"> | null;
  currency: string;
  onClose: () => void;
}) {
  const t = useTranslations("banking.detail");
  const tx = useAuthedQuery(api.banking.transaction, { id: id as Id<"bankTransactions"> }, id !== null);
  const canMark = useCan("banking.mark");
  const canWrite = useCan("banking.write");
  const run = useRun();
  const linkReversal = useMutation(api.banking.linkReversalTo);
  const canVoucher = useCan("vouchers.write");
  const tFeed = useTranslations("bankFeed");
  const router = useRouter();
  const newVoucher = useMutation(api.matchingRules.createVoucherFromTransaction);
  const rule = useAuthedQuery(
    api.matchingRules.forTransaction,
    { transactionId: id as Id<"bankTransactions"> },
    id !== null,
  );
  const [dialog, setDialog] = useState<Mark | "unmark" | null>(null);

  return (
    <Sheet open={id !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-xl">
        {tx && (
          <>
            <SheetHeader>
              <SheetTitle>{tx.counterpartyName ?? t("noCounterparty")}</SheetTitle>
              <SheetDescription>
                {formatDate(tx.bookingDate)} · <Amount cents={tx.amountCents} currency={tx.currency} />
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-5 px-4 pb-6 text-sm">
              <div className="flex flex-wrap gap-2">
                <StatusBadge status={tx.status} />
                {tx.reversal && <Badge variant="outline">{t("reversalFlag")}</Badge>}
                {rule && <Badge variant="outline">{tFeed("ruleChip", { name: rule.name })}</Badge>}
                {tx.ignoredReason && (
                  <Badge variant="secondary">
                    {IGNORE_REASON_LABEL_DE[tx.ignoredReason as keyof typeof IGNORE_REASON_LABEL_DE] ?? t("rolledBack")}
                  </Badge>
                )}
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">{t("purpose")}</dt>
                <dd className="break-words">{tx.purpose || "—"}</dd>
                {tx.counterpartyIban && (
                  <>
                    <dt className="text-muted-foreground">{t("iban")}</dt>
                    <dd>{tx.counterpartyIban}</dd>
                  </>
                )}
                {tx.valueDate && (
                  <>
                    <dt className="text-muted-foreground">{t("valueDate")}</dt>
                    <dd>{formatDate(tx.valueDate)}</dd>
                  </>
                )}
                {tx.endToEndId && (
                  <>
                    <dt className="text-muted-foreground">{t("endToEnd")}</dt>
                    <dd className="break-all">{tx.endToEndId}</dd>
                  </>
                )}
                {tx.feeCents !== null && (
                  <>
                    <dt className="text-muted-foreground">{t("fee")}</dt>
                    <dd>{money(tx.feeCents, tx.currency)}</dd>
                  </>
                )}
                {tx.bankTransactionCode && (
                  <>
                    <dt className="text-muted-foreground">{t("code")}</dt>
                    <dd>{tx.bankTransactionCode}</dd>
                  </>
                )}
                {tx.original && (
                  <>
                    <dt className="text-muted-foreground">{t("reversalOf")}</dt>
                    <dd>
                      {formatDate(tx.original.bookingDate)} {money(tx.original.amountCents, currency)}
                    </dd>
                  </>
                )}
              </dl>

              {canVoucher && tx.status === "open" && tx.allocatedCents === 0 && tx.amountCents < 0 && (
                <Button
                  className="h-11 self-start md:h-9"
                  onClick={async () => {
                    const r = await run(() => newVoucher({ transactionId: tx._id }), tFeed("newVoucherDone"));
                    if (r.ok) router.push(`/belege/${r.value}` as Route);
                  }}
                >
                  {tFeed("newVoucher")}
                </Button>
              )}
              {(canMark || canWrite) && (
                <section aria-labelledby={`actions-${tx._id}`} className="flex flex-col gap-2">
                  <h3 id={`actions-${tx._id}`} className="font-medium">
                    {t("actions")}
                  </h3>
                  {tx.status === "open" && tx.allocatedCents === 0 && canMark ? (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" className="h-11 md:h-9" onClick={() => setDialog("private")}>
                        {t("markPrivate")}
                      </Button>
                      <Button variant="outline" className="h-11 md:h-9" onClick={() => setDialog("transfer")}>
                        {t("markTransfer")}
                      </Button>
                      {tx.amountCents < 0 && tx.currency === "EUR" && (
                        <Button variant="outline" className="h-11 md:h-9" onClick={() => setDialog("cash_withdrawal")}>
                          {t("markCash")}
                        </Button>
                      )}
                      {tx.currency === "EUR" && (
                        <Button variant="outline" className="h-11 md:h-9" onClick={() => setDialog("loan")}>
                          {t("markLoan")}
                        </Button>
                      )}
                      <Button variant="outline" className="h-11 md:h-9" onClick={() => setDialog("ignored")}>
                        {t("markIgnored")}
                      </Button>
                    </div>
                  ) : (
                    ["private", "transfer", "ignored", "booked"].includes(tx.status) &&
                    tx.ignoredReason !== "import_rolled_back" &&
                    canMark && (
                      <Button variant="outline" className="h-11 self-start md:h-9" onClick={() => setDialog("unmark")}>
                        {t("unmark")}
                      </Button>
                    )
                  )}
                  {canWrite && tx.reversalCandidates.length > 0 && (
                    <ul className="flex flex-col gap-2">
                      {tx.reversalCandidates.map((c) => (
                        <li
                          key={c.originalId}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
                        >
                          <span>{c.label}</span>
                          <Button
                            variant="outline"
                            className="h-11 md:h-9"
                            onClick={() =>
                              void run(
                                () =>
                                  linkReversal({
                                    counterId: tx._id,
                                    originalId: c.originalId as Id<"bankTransactions">,
                                  }),
                                t("linked"),
                              )
                            }
                          >
                            {t("linkReversal")}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {tx.postings.length > 0 && (
                <section aria-labelledby={`postings-${tx._id}`} className="flex flex-col gap-2">
                  <h3 id={`postings-${tx._id}`} className="font-medium">
                    {t("postings")}
                  </h3>
                  <ul className="flex flex-col gap-2">
                    {tx.postings.map((p) => (
                      <li key={p.id} className="rounded-md border p-2">
                        <span className="font-medium">
                          {t("entry", { seq: p.seq })} · {formatDate(p.date)}
                        </span>{" "}
                        {p.text}
                        {p.reversal && (
                          <Badge variant="outline" className="ml-2">
                            {t("reversalEntry")}
                          </Badge>
                        )}
                        <span className="block text-muted-foreground">
                          {p.lines
                            .map((l) =>
                              l.debitCents > 0
                                ? `S ${l.account} ${money(l.debitCents)}`
                                : `H ${l.account} ${money(l.creditCents)}`,
                            )
                            .join(" · ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {tx.eigenbelege.length > 0 && (
                <section className="flex flex-col gap-1">
                  <h3 className="font-medium">{t("eigenbelege")}</h3>
                  {tx.eigenbelege.map((e) =>
                    e.url ? (
                      <a key={e.sha256} href={e.url} target="_blank" rel="noreferrer" className="underline">
                        {e.name}
                      </a>
                    ) : null,
                  )}
                </section>
              )}

              <section className="flex flex-col gap-1">
                <h3 className="font-medium">{t("sources")}</h3>
                <ul className="flex flex-col gap-1 text-muted-foreground">
                  {tx.sources.map((s) => (
                    <li key={`${s.kind}-${s.at}`}>
                      {SOURCE_LABEL[s.kind] ?? s.kind} · {formatDateTime(s.at)}
                      {s.reference && ` · ${s.reference}`}
                    </li>
                  ))}
                  {tx.revisions
                    .filter((r) => !r.applied)
                    .map((r) => (
                      <li key={`rev-${r.at}`} className="text-warning">
                        {t("revisionConflict", { fields: r.changedFields.join(", "), date: formatDateTime(r.at) })}
                      </li>
                    ))}
                </ul>
              </section>
            </div>
            {dialog && dialog !== "unmark" && (
              <MarkDialog
                kind={dialog}
                transactionId={tx._id}
                amountCents={tx.amountCents}
                onClose={() => setDialog(null)}
              />
            )}
            {dialog === "unmark" && <UnmarkDialog transactionId={tx._id} onClose={() => setDialog(null)} />}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function MarkDialog({
  kind,
  transactionId,
  amountCents,
  onClose,
}: {
  kind: Mark;
  transactionId: Id<"bankTransactions">;
  amountCents: number;
  onClose: () => void;
}) {
  const t = useTranslations("banking.mark");
  const run = useRun();
  const mark = useAction(api.banking.mark);
  const reasonId = useId();
  const linkId = useId();
  const nameId = useId();
  const noteId = useId();
  const [reason, setReason] = useState<(typeof IGNORE_REASON_VALUES)[number]>("test_or_zero");
  const [link, setLink] = useState("");
  const [shareholderName, setShareholderName] = useState("");
  const [shareholderNote, setShareholderNote] = useState("");
  const principalId = useId();
  const interestId = useId();
  const [principal, setPrincipal] = useState("");
  const [interest, setInterest] = useState("");
  const cents = (v: string) => {
    const r = parseCents(v);
    return v.trim() && r.ok ? r.value : undefined;
  };
  const loanSplit = {
    ...(cents(principal) !== undefined ? { principalCents: cents(principal) } : {}),
    ...(cents(interest) !== undefined ? { interestCents: cents(interest) } : {}),
  };
  const details = useAuthedQuery(api.banking.transaction, { id: transactionId });
  const candidates = details?.reversalCandidates ?? [];
  return (
    <ConfirmDialog
      title={t(`${kind}.title`)}
      description={t(`${kind}.description`, { direction: amountCents < 0 ? "out" : "in" })}
      confirmLabel={t(`${kind}.confirm`)}
      onClose={onClose}
      onConfirm={async () => {
        const r = await run(
          () =>
            mark({
              transactionId,
              as: kind,
              ...(kind === "ignored" ? { reason } : {}),
              ...(kind === "ignored" && link ? { linkId: link as Id<"bankTransactions"> } : {}),
              ...(kind === "private" && shareholderName
                ? { shareholder: { name: shareholderName, note: shareholderNote } }
                : {}),
              ...(kind === "loan" ? { loan: loanSplit } : {}),
            }),
          t("done"),
        );
        if (r.ok) onClose();
      }}
    >
      {kind === "private" && (
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1 text-muted-foreground">{t("private.corporation")}</legend>
          <label htmlFor={nameId}>{t("private.shareholder")}</label>
          <Input
            id={nameId}
            className="h-11 md:h-9"
            value={shareholderName}
            onChange={(e) => setShareholderName(e.target.value)}
          />
          <label htmlFor={noteId}>{t("private.note")}</label>
          <Input
            id={noteId}
            className="h-11 md:h-9"
            value={shareholderNote}
            onChange={(e) => setShareholderNote(e.target.value)}
          />
        </fieldset>
      )}
      {kind === "loan" && amountCents < 0 && (
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1 text-muted-foreground">{t("loan.split")}</legend>
          <label htmlFor={principalId}>{t("loan.principal")}</label>
          <Input
            id={principalId}
            inputMode="decimal"
            className="h-11 md:h-9"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
          />
          <label htmlFor={interestId}>{t("loan.interest")}</label>
          <Input
            id={interestId}
            inputMode="decimal"
            className="h-11 md:h-9"
            value={interest}
            onChange={(e) => setInterest(e.target.value)}
          />
        </fieldset>
      )}
      {kind === "ignored" && (
        <div className="flex flex-col gap-2 text-sm">
          <label htmlFor={reasonId}>{t("ignored.reason")}</label>
          <select
            id={reasonId}
            className={selectClass}
            value={reason}
            onChange={(e) => setReason(e.target.value as (typeof IGNORE_REASON_VALUES)[number])}
          >
            {IGNORE_REASON_VALUES.map((r) => (
              <option key={r} value={r}>
                {IGNORE_REASON_LABEL_DE[r]}
              </option>
            ))}
          </select>
          {reason === "neutralised_pair" && (
            <>
              <label htmlFor={linkId}>{t("ignored.link")}</label>
              <select id={linkId} className={selectClass} value={link} onChange={(e) => setLink(e.target.value)}>
                <option value="">{t("ignored.choose")}</option>
                {candidates.map((c) => (
                  <option key={c.originalId} value={c.originalId}>
                    {c.label}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}

function UnmarkDialog({ transactionId, onClose }: { transactionId: Id<"bankTransactions">; onClose: () => void }) {
  const t = useTranslations("banking.mark");
  const run = useRun();
  const unmark = useMutation(api.banking.unmark);
  const reasonId = useId();
  const [reason, setReason] = useState("");
  return (
    <ConfirmDialog
      title={t("unmark.title")}
      description={t("unmark.description")}
      confirmLabel={t("unmark.confirm")}
      confirmDisabled={reason.trim().length < 5}
      onClose={onClose}
      onConfirm={async () => {
        const r = await run(() => unmark({ transactionId, reason }), t("unmark.done"));
        if (r.ok) onClose();
      }}
    >
      <label htmlFor={reasonId} className="font-medium text-sm">
        {t("unmark.reason")}
      </label>
      <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} />
    </ConfirmDialog>
  );
}
