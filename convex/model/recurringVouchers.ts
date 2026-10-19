import type { Infer } from "convex/values";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { CalendarDate } from "../../src/domain/time/calendar-date";
import {
  checkRecurringSchedule,
  dueVoucherDates,
  lastThree,
  nextVoucherDate,
  type VoucherInterval,
} from "../../src/domain/vouchers/recurring";
import { unacknowledgedWarnings } from "../../src/domain/vouchers/validate";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import type { vRecurringTemplate } from "../voucherValidators";
import { auditedInsert, auditedPatch } from "./audit";
import type { FileRefValue } from "./bankImport";
import type { ModelCtx } from "./types";
import { createVoucher, finalizeVoucher, previewVoucher } from "./vouchers";

/**
 * Recurring vouchers (F06 VOU-064; EC-VOU-33/34): templates (audited configuration) and the daily generation
 * (02 §7 `recurringVouchers.generate`, 06:15 Europe/Berlin). One voucher per due occurrence, missed ones in order;
 * idempotent per (template, date). `createAs: "open"` books the voucher when its validation is clean and the template
 * links a reference document (the Beleg, e.g. the rental contract); otherwise it stays a draft for review.
 */

export type RecurringTemplate = Infer<typeof vRecurringTemplate>;

export interface RecurringInput {
  name: string;
  template: RecurringTemplate;
  interval: VoucherInterval;
  firstDate: string;
  endDate?: string;
  createAs: "open" | "draft";
  expectedMandateRef?: string;
  expectedIban?: string;
  referenceFile?: FileRefValue;
  recurringPayment?: boolean;
}

function check(input: Pick<RecurringInput, "interval" | "firstDate" | "endDate" | "name">) {
  if (!input.name.trim()) throw appError("invalid_input", "Bitte einen Namen angeben.");
  const issue = checkRecurringSchedule({
    interval: input.interval,
    firstDate: input.firstDate,
    ...(input.endDate ? { endDate: input.endDate } : {}),
  });
  if (issue) throw appError("invalid_input", issue.message, { reason: issue.code.toUpperCase() });
}

export async function createRecurringVoucher(ctx: ModelCtx, input: RecurringInput): Promise<Id<"recurringVouchers">> {
  check(input);
  return auditedInsert(
    ctx,
    "recurringVouchers",
    {
      name: input.name.trim(),
      template: input.template,
      interval: input.interval,
      firstDate: input.firstDate,
      nextDate: input.firstDate,
      ...(input.endDate ? { endDate: input.endDate } : {}),
      active: true,
      createAs: input.createAs,
      ...(input.expectedMandateRef ? { expectedMandateRef: input.expectedMandateRef } : {}),
      ...(input.expectedIban ? { expectedIban: input.expectedIban.replace(/\s+/g, "").toUpperCase() } : {}),
      ...(input.referenceFile ? { referenceFile: input.referenceFile } : {}),
      ...(input.recurringPayment !== undefined ? { recurringPayment: input.recurringPayment } : {}),
      lastGeneratedIds: [],
      actor: ctx.actor,
      version: 1,
    },
    { action: "voucher.recurring_create", label: input.name.trim() },
  );
}

/** EC-VOU-34: edits affect only future vouchers (generated vouchers are copies). */
export async function updateRecurringVoucher(
  ctx: ModelCtx,
  args: { id: Id<"recurringVouchers">; version?: number; patch: Partial<RecurringInput> & { active?: boolean } },
): Promise<void> {
  const r = await ctx.db.get(args.id);
  if (!r) throw appError("not_found", "Die Vorlage existiert nicht.");
  if (args.version !== undefined && args.version !== r.version) {
    throw appError("conflict", "Die Vorlage wurde inzwischen geändert. Bitte neu laden.", {
      reason: "VERSION_CONFLICT",
    });
  }
  const next = { ...r, ...args.patch };
  check({
    name: next.name,
    interval: next.interval,
    firstDate: next.firstDate,
    ...(next.endDate ? { endDate: next.endDate } : {}),
  });
  const { referenceFile, ...rest } = args.patch;
  await auditedPatch(
    ctx,
    "recurringVouchers",
    r._id,
    {
      ...rest,
      ...(referenceFile ? { referenceFile } : {}),
      // A new first date restarts the schedule (nothing generated before it).
      ...(args.patch.firstDate && args.patch.firstDate !== r.firstDate ? { nextDate: args.patch.firstDate } : {}),
      version: r.version + 1,
    },
    { action: "voucher.recurring_update", label: r.name },
  );
}

/** The daily job (and „Jetzt erzeugen“): every due occurrence of every active template, oldest first. */
export async function generateDueRecurringVouchers(
  ctx: ModelCtx,
  now: number,
  only?: Id<"recurringVouchers">,
): Promise<{ created: Id<"vouchers">[]; booked: Id<"vouchers">[] }> {
  const today = berlinCalendarDate(now) as CalendarDate;
  const templates: Doc<"recurringVouchers">[] = only
    ? [await ctx.db.get(only)].filter((r): r is Doc<"recurringVouchers"> => r !== null)
    : await ctx.db
        .query("recurringVouchers")
        .withIndex("by_active_next", (q) => q.eq("active", true).lte("nextDate", today))
        .collect();
  const created: Id<"vouchers">[] = [];
  const booked: Id<"vouchers">[] = [];
  for (const r of templates) {
    let last = r.lastGeneratedIds;
    let nextDate = r.nextDate;
    for (const o of dueVoucherDates(r, today)) {
      const existing = await ctx.db
        .query("vouchers")
        .withIndex("by_recurring", (q) => q.eq("recurringVoucherId", r._id).eq("documentDate", o.date))
        .first();
      nextDate = nextVoucherDate(r, o.index);
      if (existing) continue;
      const t = r.template;
      const id = await createVoucher(ctx, {
        input: {
          direction: t.direction,
          kind: t.kind,
          ...(t.supplierContactId ? { supplierContactId: t.supplierContactId } : {}),
          ...(t.supplierName ? { supplierName: t.supplierName } : {}),
          ...(t.supplierVatId ? { supplierVatId: t.supplierVatId } : {}),
          ...(t.documentNumber ? { documentNumber: t.documentNumber } : {}),
          documentDate: o.date,
          currency: t.currency,
          priceMode: t.priceMode,
          taxRule: t.taxRule,
          lines: t.lines,
          ...(t.internalNote ? { internalNote: t.internalNote } : {}),
          ...(r.recurringPayment !== undefined ? { recurringPayment: r.recurringPayment } : {}),
        },
        recurringVoucherId: r._id,
      });
      created.push(id);
      last = lastThree(last, id);
      if (r.createAs === "open") {
        const p = await previewVoucher(ctx, { id }, now);
        const clean =
          p.check.errors.length === 0 &&
          unacknowledgedWarnings(p.check, []).length === 0 &&
          p.payment.warnings.length === 0;
        if (clean) {
          await finalizeVoucher(ctx, { id });
          booked.push(id);
        }
      }
    }
    await auditedPatch(
      ctx,
      "recurringVouchers",
      r._id,
      { nextDate, lastGeneratedIds: last },
      { action: "voucher.recurring_generate", label: r.name },
    );
  }
  return { created, booked };
}
