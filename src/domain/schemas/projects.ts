/**
 * F11 projects and time tracking, F03 stock (P4): form schemas shared by the UI and the Convex mutations (and later
 * REST/MCP). Amounts are typed as German decimal strings and transformed into integers (rates in micros, budgets
 * in minutes or cents, quantities in milli).
 */
import { z } from "zod";
import { parseCents, parseMicros, parseMilli } from "../money/parse";
import { roundHalfAway } from "../money/rounding";
import { MANUAL_STOCK_KINDS } from "../products/stock";
import { TIME_GROUPINGS } from "../projects/invoicing";
import { parseDuration } from "../projects/time-entries";
import { isCalendarDate } from "../time/calendar-date";

const trimmed = () => z.string().trim();
const optionalDate = trimmed().refine((v) => v === "" || isCalendarDate(v), { message: "Ungültiges Datum." });
const date = trimmed().refine(isCalendarDate, { message: "Bitte ein gültiges Datum angeben." });

const micros = (v: string) => {
  if (!v) return undefined;
  const r = parseMicros(v);
  return r.ok ? Number(r.value) : Number.NaN;
};
const rateField = (label: string) =>
  trimmed().refine((v) => v === "" || !Number.isNaN(micros(v)), {
    message: `${label}: bitte einen Betrag mit höchstens 4 Nachkommastellen angeben.`,
  });

export const roundingSchema = z.object({
  incrementMinutes: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(5),
    z.literal(6),
    z.literal(10),
    z.literal(15),
    z.literal(30),
    z.literal(60),
  ]),
  mode: z.enum(["up", "nearest"]),
  minimumMinutes: z.number().int().min(0).max(240).optional(),
});

// ── projects (PRJ-001) ─────────────────────────────────────────────────────────────────────────────────────

export const projectFormSchema = z
  .object({
    name: trimmed().min(1, "Bitte einen Projektnamen angeben.").max(200),
    description: z.string().max(5000),
    contactId: trimmed(),
    status: z.enum(["active", "done", "archived"]),
    billingMode: z.enum(["hourly", "fixed", "non_billable"]),
    hourlyRate: rateField("Stundensatz"),
    internalCostRate: rateField("Interner Kostensatz"),
    budgetKind: z.enum(["none", "hours", "amount"]),
    /** Hours („10“, „12,5“) or an amount („5.000,00“). */
    budgetValue: trimmed(),
    startDate: optionalDate,
    endDate: optionalDate,
    defaultProductId: trimmed(),
    roundingIncrement: z.enum(["default", "0", "1", "5", "6", "10", "15", "30", "60"]),
    roundingMode: z.enum(["up", "nearest"]),
    roundingMinimum: trimmed().regex(/^\d{0,3}$/, "Bitte Minuten als ganze Zahl angeben."),
  })
  .superRefine((v, ctx) => {
    if (v.budgetKind !== "none") {
      const r = v.budgetKind === "hours" ? parseMilli(v.budgetValue) : parseCents(v.budgetValue);
      if (!v.budgetValue || !r.ok || Number(r.value) <= 0) {
        ctx.addIssue({ code: "custom", path: ["budgetValue"], message: "Bitte einen gültigen Budgetwert angeben." });
      }
    }
    if (v.startDate && v.endDate && v.endDate < v.startDate) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "Das Projektende liegt vor dem Beginn." });
    }
  })
  .transform((v) => {
    const hours = parseMilli(v.budgetValue);
    const amount = parseCents(v.budgetValue);
    const budgetValue =
      v.budgetKind === "hours" && hours.ok
        ? Number(roundHalfAway(BigInt(hours.value) * 60n, 1000n))
        : v.budgetKind === "amount" && amount.ok
          ? Number(amount.value)
          : undefined;
    return {
      name: v.name,
      ...(v.description.trim() ? { description: v.description.trim() } : {}),
      ...(v.contactId ? { contactId: v.contactId } : {}),
      status: v.status,
      billingMode: v.billingMode,
      ...(v.hourlyRate ? { hourlyRateMicros: micros(v.hourlyRate) as number } : {}),
      ...(v.internalCostRate ? { internalCostRateMicros: micros(v.internalCostRate) as number } : {}),
      ...(v.budgetKind !== "none" && budgetValue !== undefined
        ? { budget: { kind: v.budgetKind, value: budgetValue } }
        : {}),
      ...(v.startDate ? { startDate: v.startDate } : {}),
      ...(v.endDate ? { endDate: v.endDate } : {}),
      ...(v.defaultProductId ? { defaultProductId: v.defaultProductId } : {}),
      ...(v.roundingIncrement !== "default"
        ? {
            rounding: {
              incrementMinutes: Number(v.roundingIncrement) as z.infer<typeof roundingSchema>["incrementMinutes"],
              mode: v.roundingMode,
              ...(v.roundingMinimum ? { minimumMinutes: Number(v.roundingMinimum) } : {}),
            },
          }
        : {}),
    };
  });

export type ProjectFormValues = z.input<typeof projectFormSchema>;
export type ProjectInput = z.output<typeof projectFormSchema>;

export const emptyProjectForm = (): ProjectFormValues => ({
  name: "",
  description: "",
  contactId: "",
  status: "active",
  billingMode: "hourly",
  hourlyRate: "",
  internalCostRate: "",
  budgetKind: "none",
  budgetValue: "",
  startDate: "",
  endDate: "",
  defaultProductId: "",
  roundingIncrement: "default",
  roundingMode: "up",
  roundingMinimum: "",
});

// ── time entries (PRJ-007) ─────────────────────────────────────────────────────────────────────────────────

export const timeEntryFormSchema = z
  .object({
    date,
    /** „start_end“: wall-clock times; „duration“: any accepted notation. */
    mode: z.enum(["duration", "start_end"]),
    duration: trimmed(),
    startTime: trimmed(),
    endTime: trimmed(),
    description: trimmed().max(2000),
    projectId: trimmed(),
    contactId: trimmed(),
    productId: trimmed(),
    billable: z.boolean(),
    /** Rate override („95,00“); empty = resolved by the chain (PRJ-008). */
    rate: rateField("Stundensatz"),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "duration") {
      const r = parseDuration(v.duration);
      if (!r.ok) ctx.addIssue({ code: "custom", path: ["duration"], message: r.error.message });
    }
  });

export type TimeEntryFormValues = z.input<typeof timeEntryFormSchema>;
export type TimeEntryFormOutput = z.output<typeof timeEntryFormSchema>;

export const emptyTimeEntryForm = (today: string): TimeEntryFormValues => ({
  date: today,
  mode: "duration",
  duration: "",
  startTime: "",
  endTime: "",
  description: "",
  projectId: "",
  contactId: "",
  productId: "",
  billable: true,
  rate: "",
});

export const rateOverrideMicros = (rate: string): number | undefined => micros(rate.trim());

// ── invoice from time entries (PRJ-010) ────────────────────────────────────────────────────────────────────

export const invoiceFromEntriesSchema = z.object({
  entryIds: z.array(z.string()).min(1, "Bitte mindestens einen Zeiteintrag auswählen.").max(1000),
  grouping: z.enum(TIME_GROUPINGS),
  unit: z.enum(["HUR", "MIN"]).optional(),
  rounding: roundingSchema.optional(),
  perGroup: z.boolean().optional(),
  /** Append to this draft (same contact) instead of creating a new one. */
  draftId: z.string().optional(),
});

export type InvoiceFromEntriesValues = z.infer<typeof invoiceFromEntriesSchema>;

// ── stock (PRD-090/094/096) ────────────────────────────────────────────────────────────────────────────────

const milliOrNaN = (v: string) => {
  const r = parseMilli(v);
  return r.ok ? Number(r.value) : Number.NaN;
};

export const stockSettingsSchema = z
  .object({
    enabled: z.boolean(),
    /** Empty = no reorder level. */
    reorderLevel: trimmed(),
  })
  .superRefine((v, ctx) => {
    if (v.reorderLevel && (Number.isNaN(milliOrNaN(v.reorderLevel)) || milliOrNaN(v.reorderLevel) < 0)) {
      ctx.addIssue({ code: "custom", path: ["reorderLevel"], message: "Bitte eine Menge ≥ 0 angeben." });
    }
  })
  .transform((v) => ({
    enabled: v.enabled,
    ...(v.reorderLevel ? { reorderLevelMilli: milliOrNaN(v.reorderLevel) } : {}),
  }));

export type StockSettingsValues = z.input<typeof stockSettingsSchema>;

export const stockAdjustmentSchema = z
  .object({
    kind: z.enum(MANUAL_STOCK_KINDS),
    /** Zugang/Abgang: positive; Korrektur: signed („-2“). */
    quantity: trimmed(),
    text: trimmed().max(500),
  })
  .superRefine((v, ctx) => {
    if (Number.isNaN(milliOrNaN(v.quantity))) {
      ctx.addIssue({ code: "custom", path: ["quantity"], message: "Bitte eine gültige Menge angeben." });
    }
  })
  .transform((v) => ({ kind: v.kind, quantityMilli: milliOrNaN(v.quantity), text: v.text }));

export type StockAdjustmentValues = z.input<typeof stockAdjustmentSchema>;
