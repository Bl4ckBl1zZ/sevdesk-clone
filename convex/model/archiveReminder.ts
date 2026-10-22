import { archiveReminderFor, archiveReminderKey } from "../../src/domain/exports/archive-reminder";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { notify } from "./notifications";
import type { ModelCtx } from "./types";

/**
 * F09 EXP-025: from 31.01. the owner gets one in-app reminder per closed year (with bookings) to create the full export
 * and the GDPdU export and to store them off-host. Once per year: an existing notification with the key — open or
 * resolved — is never touched again, so a done reminder does not come back on the next cron run.
 */
export async function notifyArchiveReminder(ctx: ModelCtx): Promise<number> {
  const today = berlinCalendarDate(ctx.now());
  const closedYear = Number(today.slice(0, 4)) - 1;
  const existing = await ctx.db
    .query("notifications")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", archiveReminderKey(closedYear)))
    .first();
  if (existing) return 0;
  const booking = await ctx.db
    .query("journalLines")
    .withIndex("by_date", (q) => q.gte("date", `${closedYear}-01-01`).lt("date", `${closedYear + 1}-01-01`))
    .first();
  const reminder = archiveReminderFor(today, { hasBookingsInClosedYear: booking !== null });
  if (!reminder) return 0;
  await notify(ctx, {
    kind: "archive_export_due",
    severity: "info",
    title: reminder.title,
    body: reminder.body,
    link: reminder.link,
    dedupeKey: reminder.dedupeKey,
  });
  return 1;
}
