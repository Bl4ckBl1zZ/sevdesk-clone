import { resolveRole } from "../../src/domain/accounting/resolve";
import { selfBillingVoucherInput } from "../../src/domain/documents/self-billing";
import type { DocumentSnapshot } from "../../src/domain/documents/snapshot";
import { calendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedPatch } from "./audit";
import { resolveContextAt } from "./journal";
import { notify } from "./notifications";
import type { ModelCtx } from "./types";
import { cancelVoucher, createVoucher, finalizeVoucher, previewVoucher, requireVoucher } from "./vouchers";

/**
 * Self-billing Gutschrift as a purchase (F04 §4.9 step 4/5, INV-16): the finalised Gutschrift creates its purchase
 * voucher (input VAT and payable, F06) in the same transaction and books it when nothing needs the owner's decision;
 * the archived PDF becomes the voucher's original file; an objection reverses the voucher.
 */

const EXPENSE_ROLE = "expense.services";

async function expenseAccount(ctx: ModelCtx, date: string): Promise<string | null> {
  const r = resolveRole(EXPENSE_ROLE, await resolveContextAt(ctx, calendarDate(date)));
  return r.ok ? r.value.account : null;
}

/** Called by the finalisation commit of a `self_billing` document (salesDocuments.commitFinalization). */
export async function recordSelfBillingVoucher(
  ctx: ModelCtx,
  doc: Doc<"salesDocuments">,
  snapshot: DocumentSnapshot,
): Promise<Id<"vouchers">> {
  const account = (await expenseAccount(ctx, snapshot.documentDate)) ?? "";
  const input = selfBillingVoucherInput(snapshot, account);
  const voucherId = await createVoucher(ctx, {
    input: {
      ...input,
      ...(doc.contactId ? { supplierContactId: doc.contactId } : {}),
      lines: input.lines.map((l) => ({ ...l })),
    },
  });
  await auditedPatch(
    ctx,
    "vouchers",
    voucherId,
    { selfBillingDocumentId: doc._id },
    { action: "voucher.self_billing_link", label: snapshot.number },
  );
  await auditedPatch(
    ctx,
    "salesDocuments",
    doc._id,
    { selfBillingVoucherId: voucherId },
    { action: "document.self_billing_voucher", label: snapshot.number },
  );
  // Book now when the voucher needs no decision (no errors, only acknowledgeable warnings); else the owner finishes it.
  const p = await previewVoucher(ctx, { id: voucherId }, ctx.now());
  const warnings = [...p.check.warnings, ...p.payment.warnings];
  if (p.check.errors.length === 0 && warnings.every((w) => w.acknowledge)) {
    await finalizeVoucher(ctx, { id: voucherId, acknowledgeWarnings: warnings.map((w) => w.code) });
  } else {
    await notify(ctx, {
      kind: "self_billing_voucher_review",
      severity: "warning",
      title: `Beleg zur Gutschrift ${snapshot.number} bitte prüfen und buchen`,
      body: [...p.check.errors, ...warnings]
        .map((i) => i.message)
        .join(" ")
        .slice(0, 500),
      link: `/belege/${voucherId}`,
      entity: { table: "salesDocuments", id: doc._id },
      dedupeKey: `self_billing_voucher_review:${doc._id}`,
    });
  }
  return voucherId;
}

/** The archived Gutschrift PDF (initial artifacts) is added to the voucher's original files (VOU-120). */
export async function attachSelfBillingPdf(
  ctx: ModelCtx,
  doc: Doc<"salesDocuments">,
  artifacts: readonly {
    kind: string;
    storageId: Id<"_storage">;
    sha256: string;
    bytes: number;
    mime: string;
    name: string;
    variant?: string;
  }[],
): Promise<void> {
  if (!doc.selfBillingVoucherId) return;
  const pdf = artifacts.find((a) => a.mime === "application/pdf" && (a.variant ?? "original") === "original");
  if (!pdf) return;
  const v = await requireVoucher(ctx, doc.selfBillingVoucherId);
  if (v.originalFiles.some((f) => f.sha256 === pdf.sha256)) return;
  await auditedPatch(
    ctx,
    "vouchers",
    v._id,
    {
      originalFiles: [
        ...v.originalFiles,
        {
          storageId: pdf.storageId,
          sha256: pdf.sha256,
          bytes: pdf.bytes,
          mime: pdf.mime,
          name: pdf.name,
          role: "original" as const,
          capturedAt: ctx.now(),
          capturedBy: ctx.actor,
          capturedVia: "api" as const,
        },
      ],
    },
    { action: "voucher.file_add", label: v.internalNumber ?? doc.number ?? "Gutschrift" },
  );
}

/**
 * F04 §4.9 step 5: the objection reverses the purchase voucher (VOU-009 Storno, dated today). A payment to the
 * supplier must be reversed first (the payable would otherwise stay settled against nothing).
 */
export async function reverseSelfBillingVoucher(
  ctx: ModelCtx,
  doc: Doc<"salesDocuments">,
  reason: string,
): Promise<void> {
  if (!doc.selfBillingVoucherId) return;
  const v = await requireVoucher(ctx, doc.selfBillingVoucherId);
  if (v.status === "cancelled") return;
  if (v.status === "draft") {
    // Never booked (owner review pending): nothing to reverse; the draft stays as a record linked to the Gutschrift.
    return;
  }
  try {
    await cancelVoucher(ctx, { id: v._id, reason });
  } catch (e) {
    const reasonCode = (e as { data?: { reason?: string } }).data?.reason;
    if (reasonCode === "ACTIVE_PAYMENTS") {
      throw appError(
        "invalid_input",
        "Die Gutschrift wurde bereits ausgezahlt. Bitte zuerst die Zahlung am Beleg stornieren, dann den Widerspruch erfassen.",
        { reason: "SELF_BILLING_PAID" },
      );
    }
    throw e;
  }
}
