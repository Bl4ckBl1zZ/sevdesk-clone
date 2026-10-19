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

// recurringVouchers.generate — daily 06:15 Europe/Berlin (04:15 / 05:15 UTC; F06 VOU-064). Idempotent per (template,
// occurrence date), so the second registration of the day finds nothing due.
crons.cron("recurringVouchers.generate (CEST)", "15 4 * * *", internal.vouchers.generateRecurringCron, {});
crons.cron("recurringVouchers.generate (CET)", "15 5 * * *", internal.vouchers.generateRecurringCron, {});

export default crons;
