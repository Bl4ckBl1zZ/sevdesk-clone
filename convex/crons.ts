import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * P0 cron jobs (02 §7). Convex crons run in UTC; jobs that are specified in Europe/Berlin local time are
 * registered for both possible UTC hours (CET/CEST) and gate on the Berlin hour themselves. Every job skips
 * with IS_TEST=true unless invoked explicitly.
 */
const crons = cronJobs();

// integrity.verify — daily 02:00 Europe/Berlin (00:00 UTC in summer, 01:00 UTC in winter)
crons.cron("integrity.verify (CEST)", "0 0 * * *", internal.integrity.verifyCron, {});
crons.cron("integrity.verify (CET)", "0 1 * * *", internal.integrity.verifyCron, {});

// backups.verify — AUD-026 daily 05:30 Europe/Berlin (hourly tick, runs in the 05:xx Berlin hour)
crons.cron("backups.verify", "30 * * * *", internal.backups.verifyCron, {});

// verfahrensdoku.watch — AUD-025 / E-AUD-41 daily 07:00 UTC
crons.cron("verfahrensdoku.watch", "0 7 * * *", internal.verfahrensdoku.watchCron, {});

// system.clock — AUD-019 clock check every 10 minutes (no-op without CLOCK_REFERENCE_URL)
crons.interval("system.clock", { minutes: 10 }, internal.system.clockCron, {});

// integrity.startup — AUD-014 fast check (checkpoint signature + head continuity) every 6 hours
crons.interval("integrity.startup", { hours: 6 }, internal.integrity.startupCron, {});

// integrity.checkpoint — daily 02:30 Europe/Berlin; the hourly run also retries failed R2 uploads (AUD-016)
crons.cron("integrity.checkpoint", "30 * * * *", internal.integrity.checkpointCron, {});

// members.expire — hourly (02 §7)
crons.cron("members.expire", "5 * * * *", internal.members.expireCron, {});

// products.applyScheduledPrices — daily 00:05 Europe/Berlin (22:05 UTC in summer, 23:05 UTC in winter; F03 PRD-031)
crons.cron("products.applyScheduledPrices (CEST)", "5 22 * * *", internal.products.applyScheduledPricesCron, {});
crons.cron("products.applyScheduledPrices (CET)", "5 23 * * *", internal.products.applyScheduledPricesCron, {});

// api.cleanup — hourly: expired idempotency records (24 h) and confirm tokens (10 min), access log > 90 days (05 §3/§7)
crons.cron("api.cleanup", "15 * * * *", internal.apiKeys.cleanupCron, {});

// deadlines.notify — daily 08:00 Europe/Berlin (06:00 UTC in summer, 07:00 UTC in winter); P1: the
// "exported, not marked as sent" to-dos (F04 SND-21). The job is idempotent per document (dedupe key).
crons.cron("deadlines.notify (CEST)", "0 6 * * *", internal.invoices.notifyDeadlinesCron, {});
crons.cron("deadlines.notify (CET)", "0 7 * * *", internal.invoices.notifyDeadlinesCron, {});
// deadlines.notify, tax part (F08 TAX-019): UStVA/ZM/Sondervorauszahlung/Vorauszahlungen/annual returns; the dedupe key
// per deadline makes the second daily registration a no-op.
crons.cron("deadlines.notify tax (CEST)", "5 6 * * *", internal.taxes.notifyTaxDeadlinesCron, {});
crons.cron("deadlines.notify tax (CET)", "5 7 * * *", internal.taxes.notifyTaxDeadlinesCron, {});

// assets.depreciate (F08 AST-009): 1st of the month 05:00 Europe/Berlin for the previous month; idempotent per
// (asset, month), so the second registration is a no-op.
crons.cron("assets.depreciate (CEST)", "0 3 1 * *", internal.assets.depreciateCron, {});
crons.cron("assets.depreciate (CET)", "0 4 1 * *", internal.assets.depreciateCron, {});

// recurring.generate — daily 06:00 Europe/Berlin (04:00 UTC in summer, 05:00 UTC in winter; F04 REC-05). The job is
// idempotent per (template, occurrence), so the second registration of the day finds nothing due.
crons.cron("recurring.generate (CEST)", "0 4 * * *", internal.recurring.generateCron, {});
crons.cron("recurring.generate (CET)", "0 5 * * *", internal.recurring.generateCron, {});

// documents.artifactsWatchdog — every 10 min: renders that died with their Node process count as a failed attempt
// and restart (F04 DOC-28, EC-005); a no-op while no document is `pending`.
crons.interval("documents.artifactsWatchdog", { minutes: 10 }, internal.invoices.artifactsWatchdog, {});

// receivables.refreshOverdue — daily 00:15 Europe/Berlin (22:15 / 23:15 UTC): overdue stamp once per invoice and the
// optional „Bald fällig“ to-dos (F05 PAY-044, DUN-053); idempotent (stamp / dedupe key).
crons.cron("receivables.refreshOverdue (CEST)", "15 22 * * *", internal.dunning.refreshOverdueCron, {});
crons.cron("receivables.refreshOverdue (CET)", "15 23 * * *", internal.dunning.refreshOverdueCron, {});

// dunning.run — daily 07:00 Europe/Berlin (05:00 UTC in summer, 06:00 UTC in winter; F05 DUN-030). The job gates on
// the Berlin hour and runs once per day; it creates drafts or finalises reminders and never sends anything.
crons.cron("dunning.run (CEST)", "0 5 * * *", internal.dunning.runCron, {});
crons.cron("dunning.run (CET)", "0 6 * * *", internal.dunning.runCron, {});

// notifications.maintain — hourly: read notifications older than 90 days are purged (not GoBD-relevant) and unresolved
// `error` notifications older than 24 h are re-sent once (F12 NTF-001, NTF-006).
crons.cron("notifications.maintain", "40 * * * *", internal.notifications.maintainCron, {});

// jobs.expire — daily 03:15 UTC: export job results older than 30 days are removed from storage (F09 EXP-026).
crons.cron("jobs.expire", "15 3 * * *", internal.jobs.expireCron, {});
// recurringVouchers.generate — daily 06:15 Europe/Berlin (04:15 / 05:15 UTC; F06 VOU-064). Idempotent per (template,
// occurrence date), so the second registration of the day finds nothing due.
crons.cron("recurringVouchers.generate (CEST)", "15 4 * * *", internal.vouchers.generateRecurringCron, {});
crons.cron("recurringVouchers.generate (CET)", "15 5 * * *", internal.vouchers.generateRecurringCron, {});

// inbox.pollR2 — every 5 min (02 §7, F06 INB-049): e-mail-in via Cloudflare Email Routing → Worker → R2. A no-op while
// the R2 env is missing, the integration is disabled/without AVV, or polling is paused after 401/403 (EC-INB-29).
crons.interval("inbox.pollR2", { minutes: 5 }, internal.inboxNode.pollR2, {});

// bank.sync — every 6 h at 05:30 / 11:30 / 17:30 / 23:30 Europe/Berlin (F07 BNK-106): 03:30/09:30/15:30/21:30 UTC in
// summer, 04:30/10:30/16:30/22:30 UTC in winter; the job gates on the Berlin hour. A no-op without an active
// Enable Banking connection. Polling only — there is no inbound bank webhook (BNK-108).
crons.cron("bank.sync (CEST)", "30 3,9,15,21 * * *", internal.bankFeedNode.syncCron, {});
crons.cron("bank.sync (CET)", "30 4,10,16,22 * * *", internal.bankFeedNode.syncCron, {});

// bank.consentExpiryReminder — daily 08:00 Europe/Berlin (F07 BNK-105): T−14/T−3/T−0 reminders, once each.
crons.cron("bank.consentExpiryReminder (CEST)", "0 6 * * *", internal.bankFeed.consentExpiryReminderCron, {});
crons.cron("bank.consentExpiryReminder (CET)", "0 7 * * *", internal.bankFeed.consentExpiryReminderCron, {});

export default crons;
