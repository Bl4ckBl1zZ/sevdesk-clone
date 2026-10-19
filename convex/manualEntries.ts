import { v } from "convex/values";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { calendarDate, isCalendarDate } from "../src/domain/time/calendar-date";
import { mutation, query } from "./functions";
import { appError } from "./lib/errors";
import { createManualEntry, manualTemplatesAt, reverseManualEntry } from "./model/manualEntries";

/**
 * Manual journal entries (F08 ACC-011, §6 /buchhaltung/journal/neu): UI only — REST and MCP get read access to the
 * journal, never this editor (ACC-011 „UI/API/MCP-read only“).
 */

const vManualLine = v.object({
  account: v.string(),
  debitCents: v.number(),
  creditCents: v.number(),
  taxKey: v.optional(v.string()),
  costCenterId: v.optional(v.string()),
  contactId: v.optional(v.string()),
});

export const generateUploadUrl = mutation({
  permission: "accounting.write",
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

/** Post a manual entry (balance E-ACC-01, Beleg E-ACC-02, locked period E-ACC-04, VAT account ⚑ E-ACC-10). */
export const create = mutation({
  permission: "accounting.write",
  args: {
    date: v.string(),
    text: v.string(),
    longText: v.optional(v.string()),
    templateKey: v.optional(v.string()),
    lines: v.array(vManualLine),
    attachments: v.array(v.object({ storageId: v.id("_storage"), name: v.string() })),
    acknowledgedWarnings: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => createManualEntry(ctx, args),
});

/** „Gegenbuchung“ of a manual entry on a date in an open period. */
export const reverse = mutation({
  permission: "accounting.write",
  args: { entryId: v.id("journalEntries"), date: v.string(), reason: v.string() },
  handler: async (ctx, args) => reverseManualEntry(ctx, args),
});

/** Templates with the accounts of the chart valid on `date` (default today). */
export const templates = query({
  permission: "accounting.read",
  args: { date: v.optional(v.string()) },
  handler: async (ctx, { date }) => {
    if (date !== undefined && !isCalendarDate(date)) throw appError("invalid_input", "Ungültiges Datum.");
    return manualTemplatesAt(ctx, calendarDate(date ?? berlinCalendarDate(ctx.now())));
  },
});
