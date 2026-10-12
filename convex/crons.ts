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

export default crons;
