/**
 * Recurring-invoice template schema (F04 §3.4 REC-01…16, 03 §4 `recurringTemplates`). Shared by the template editor,
 * the Convex mutations, REST (`/recurring-invoices`) and MCP (`recurring_invoice_upsert`).
 *
 * `automation` is `{ finalize }` only and strict (REC-16): a `send` field is an unknown field and rejected — the app
 * never sends documents (owner decision B2).
 */
import { z } from "zod";
import { BILLING_MODES, RECURRING_INTERVALS } from "../recurring/schedule";
import { isCalendarDate } from "../time/calendar-date";
import { draftSchema } from "./documents";

const calendarDate = z.string().refine(isCalendarDate, { message: "Ungültiges Datum (JJJJ-MM-TT)." });

/** The template's draft content: an invoice draft without document and supply dates (set per occurrence). */
export const templateDraftSchema = draftSchema
  .omit({
    documentDate: true,
    supplyDate: true,
    supplyDateMode: true,
    backdateReason: true,
    chainOrder: true,
    validUntil: true,
    deliveryTerms: true,
    showPrices: true,
  })
  .extend({ type: z.literal("invoice") });

export const recurringScheduleSchema = z
  .object({
    interval: z.enum(RECURRING_INTERVALS),
    firstDate: calendarDate,
    endDate: calendarDate.optional(),
    maxCount: z.number().int().min(1).max(1000).optional(),
    billing: z.enum(BILLING_MODES),
    periodTextEnabled: z.boolean(),
  })
  .strict()
  .refine((s) => !s.endDate || s.endDate >= s.firstDate, {
    message: "Das Enddatum liegt vor der ersten Rechnung.",
    path: ["endDate"],
  });

export const recurringAutomationSchema = z.object({ finalize: z.boolean() }).strict();

export const recurringTemplateSchema = z
  .object({
    name: z.string().trim().min(1, "Bitte einen Namen angeben.").max(200),
    contractReference: z.string().trim().max(1000).optional(),
    draft: templateDraftSchema,
    schedule: recurringScheduleSchema,
    automation: recurringAutomationSchema,
  })
  .strict();

export type RecurringTemplateValues = z.infer<typeof recurringTemplateSchema>;
export type RecurringScheduleValues = z.infer<typeof recurringScheduleSchema>;
export type TemplateDraftValues = z.infer<typeof templateDraftSchema>;

/** REC-10 resume: „nachberechnen“ (true) or „überspringen“ (false). */
export const resumeSchema = z.object({ catchUp: z.boolean() }).strict();
