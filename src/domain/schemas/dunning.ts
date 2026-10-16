/**
 * Dunning inputs shared by the UI, Convex, REST and MCP (F05 §3.7–§3.10, CLAUDE.md rule 5). Domain rules
 * (EC-DUN-*) are checked by src/domain/dunning; these schemas only validate shapes.
 */
import { z } from "zod";
import { isCalendarDate } from "../time/calendar-date";

const calendarDate = z.string().refine(isCalendarDate, { message: "Ungültiges Datum (JJJJ-MM-TT)." });
const cents = z.number().int().min(0).max(100_000_000);
const days = z.number().int().min(0).max(3650);

export const policyStepSchema = z.object({
  level: z.number().int().min(1).max(20),
  daysAfter: days,
  title: z.string().trim().min(1, "Titel fehlt.").max(80),
  feeCents: cents,
  addInterest: z.boolean(),
  addFlatFee40: z.boolean(),
  newDueDays: z.number().int().min(1).max(365),
  textTemplateId: z.string().optional(),
  autoFinalize: z.boolean(),
});

export const policySchema = z.object({
  name: z.string().trim().min(1, "Bitte einen Namen angeben.").max(80),
  isDefault: z.boolean(),
  appliesTo: z.object({ consumer: z.boolean(), business: z.boolean() }),
  steps: z.array(policyStepSchema).min(1, "Mindestens eine Mahnstufe anlegen.").max(20),
  dueSoonDays: days.optional(),
  dueSoonTodo: z.boolean(),
  minOpenAmountCents: cents,
  pauseOnPartialPaymentDays: days,
  stopAfterLastLevel: z.boolean(),
});
export type PolicyValues = z.infer<typeof policySchema>;

/** Einstellungen › Mahnwesen global switches (companyProfile.receivables, F05 §6.6). */
export const dunningSettingsSchema = z.object({
  /** §6.6 „Mahnungen automatisch erstellen“ (default on). */
  autoCreateReminders: z.boolean().optional(),
  autoFinalizeReminders: z.boolean(),
  postalDeliveryDays: z.number().int().min(0).max(14),
  bankDataMaxAgeDays: z.number().int().min(1).max(90),
  defaultStartViaReminder: z.enum(["after_printed_deadline", "zugang_plus_1"]),
  reopenGraceDays: z.number().int().min(0).max(60),
  agingBucketEdgesDays: z.array(z.number().int().min(1).max(3650)).min(1).max(6),
});
export type DunningSettingsValues = z.infer<typeof dunningSettingsSchema>;

/** Manual reminder (DUN-008): prefilled from the policy step, amounts editable. */
export const reminderCreateSchema = z.object({
  level: z.number().int().min(1).max(20).optional(),
  feeCents: cents.optional(),
  interestCents: cents.optional(),
  interestReason: z.string().trim().max(500).optional(),
  includeFlatFee: z.boolean().optional(),
  newDueDate: calendarDate.optional(),
  headText: z.string().max(20_000).optional(),
  footText: z.string().max(20_000).optional(),
  acknowledgeWarnings: z.array(z.string().max(60)).max(20).optional(),
});
export type ReminderCreateValues = z.infer<typeof reminderCreateSchema>;

export const reminderWithdrawSchema = z.object({
  reason: z.string().trim().min(5, "Bitte einen Grund angeben (mindestens 5 Zeichen).").max(1000),
  voidNotice: z.boolean().optional(),
});

export const caseActionSchema = z.object({
  action: z.enum(["pause", "resume", "dispute", "block", "unblock", "hand_over"]),
  reason: z.string().trim().max(1000).optional(),
  until: calendarDate.optional(),
  partner: z.string().trim().max(200).optional(),
  acknowledgeWarnings: z.array(z.string().max(60)).max(10).optional(),
});
export type CaseActionValues = z.infer<typeof caseActionSchema>;

/** PAY-052 manual Zugang override (EC-DUE-09). */
export const zugangOverrideSchema = z.object({
  date: calendarDate,
  reason: z.string().trim().min(5, "Bitte begründen (mindestens 5 Zeichen).").max(1000),
});

export const interestQuerySchema = z.object({
  amountCents: z.number().int().min(1).max(10_000_000_000),
  from: calendarDate,
  to: calendarDate,
  margin: z.union([z.enum(["b2b", "b2c"]), z.number().int().min(-1000).max(5000)]),
  payments: z
    .array(z.object({ date: calendarDate, amountCents: z.number().int().min(1) }))
    .max(50)
    .optional(),
});
