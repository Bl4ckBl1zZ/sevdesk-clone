"use client";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ConfirmDialog, formatDate, todayBerlin, useCan, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { objectionIssue } from "@/domain/documents/self-billing";

/**
 * Self-billing Gutschrift on the detail page (F04 §4.9, INV-16): the linked purchase voucher, the recorded
 * objection, and „Widerspruch erfassen“ (§ 14 Abs. 2 Satz 3 UStG) instead of the Storno.
 */
type SelfBillingDoc = Pick<
  Doc<"salesDocuments">,
  "_id" | "type" | "status" | "documentDate" | "number" | "selfBillingVoucherId" | "objection"
>;

export function SelfBillingPanel({ doc }: { doc: SelfBillingDoc }) {
  const t = useTranslations("selfBilling");
  const canCancel = useCan("invoices.cancel");
  const record = useMutation(api.corrections.recordObjection);
  const run = useRun();
  const [open, setOpen] = useState(false);
  const objectionAllowed = doc.status === "finalized" || doc.status === "sent";
  return (
    <section aria-labelledby="self-billing-title" className="flex flex-col gap-2 rounded-xl border p-4 text-sm">
      <h2 id="self-billing-title" className="font-semibold text-base">
        {t("panelTitle")}
      </h2>
      <p className="text-muted-foreground">{t("panelHint")}</p>
      {doc.selfBillingVoucherId && (
        <p>
          <Link href={`/belege/${doc.selfBillingVoucherId}` as Route} className="underline">
            {t("voucherLink")}
          </Link>
        </p>
      )}
      {doc.objection ? (
        <p role="status">
          {t("objectionRecorded", { date: formatDate(doc.objection.date), text: doc.objection.text })}
        </p>
      ) : (
        canCancel &&
        objectionAllowed && (
          <div>
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setOpen(true)}>
              {t("objection")}
            </Button>
          </div>
        )
      )}
      {open && (
        <ObjectionDialog
          documentDate={doc.documentDate ?? ""}
          number={doc.number ?? ""}
          onClose={() => setOpen(false)}
          onConfirm={async (v) => {
            const r = await run(() => record({ id: doc._id, ...v }), t("objectionDone"));
            if (r.ok) setOpen(false);
          }}
        />
      )}
    </section>
  );
}

export function ObjectionDialog({
  documentDate,
  number,
  onConfirm,
  onClose,
  today = todayBerlin(),
}: {
  documentDate: string;
  number: string;
  onConfirm: (v: { date: string; text: string }) => Promise<void>;
  onClose: () => void;
  today?: string;
}) {
  const t = useTranslations("selfBilling");
  const [date, setDate] = useState(today);
  const [text, setText] = useState("");
  const dateId = useId();
  const textId = useId();
  const errorId = useId();
  const issue = objectionIssue({ type: "self_billing", status: "finalized", documentDate, date, text, today });
  return (
    <ConfirmDialog
      title={t("objectionTitle", { number })}
      description={t("objectionDescription")}
      confirmLabel={t("objectionConfirm")}
      destructive
      confirmDisabled={issue !== null}
      onConfirm={() => onConfirm({ date, text: text.trim() })}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={dateId} className="font-medium text-sm">
            {t("objectionDate")}
          </label>
          <Input
            id={dateId}
            type="date"
            value={date}
            min={documentDate}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            className="h-11 md:h-9"
            aria-describedby={issue && text.trim() ? errorId : undefined}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={textId} className="font-medium text-sm">
            {t("objectionText")}
          </label>
          <Textarea id={textId} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {issue && text.trim() && (
          <p id={errorId} role="alert" className="text-danger text-sm">
            {issue}
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}
