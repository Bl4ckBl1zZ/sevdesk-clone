import { v } from "convex/values";
import { customAction, customMutation, customQuery } from "convex-helpers/server/customFunctions";
import type { Permission } from "../src/domain/access/permissions";
import { confirmIntentFor, PERMISSIONS } from "../src/domain/access/permissions";
import type { ConfirmIntent } from "../src/domain/api/confirm";
import type { Actor } from "../src/domain/schemas/actor";
import { internal } from "./_generated/api";
import {
  action as rawAction,
  internalAction as rawInternalAction,
  internalMutation as rawInternalMutation,
  internalQuery as rawInternalQuery,
  mutation as rawMutation,
  query as rawQuery,
} from "./_generated/server";
import { resolveActor } from "./lib/actor";
import { auditorScopedDb } from "./lib/auditorScope";
import { appError } from "./lib/errors";
import { consumeConfirmToken } from "./model/confirmTokens";
import { guardedDb, newWriteStats, type WriteStats } from "./model/db";
import type { ActorContext, ModelCtx } from "./model/types";
import { vActorContext } from "./validators";

/**
 * Function wrappers (02 §4.4, CLAUDE.md non-negotiable 6, F12 AUD-001/AUD-011). EVERY Convex function is built
 * with one of these builders; the raw builders from ./_generated/server are used nowhere else
 * (mutation-inventory test).
 *
 * Public (clients, Next server, REST/MCP via server JWT) — each declares the permission it needs:
 *   query({ permission: "settings.read", args, handler })
 *   mutation({ permission: "invites.manage", args, handler })
 *   action({ permission: "integrations.manage", args, handler })
 *
 * Internal:
 *   systemQuery / systemMutation / systemAction({ job: "cron.integrity.verify", … })  → actor `system:<job>`
 *   actorMutation({ permission, … })  → internal mutation that receives the ActorContext from a trusted action
 *
 * Every builder adds `ctx.actor` (canonical `"<kind>:<id>"`), `ctx.role`, `ctx.actorContext` and `ctx.now()`.
 * Mutations get the guarded db (immutability matrix) and abort with `audit_missing` if they wrote without an
 * audit entry.
 */

// ── job registry (02 §7, 03 §0.1) ─────────────────────────────────────────────────────────────────────
export const SYSTEM_JOBS = [
  "cron.integrity.verify",
  "cron.integrity.checkpoint",
  "cron.backups.verify", // F12 AUD-026 / 02 §7 backups.verify: lists the R2 backup bucket (read-only), notifies stale
  "cron.verfahrensdoku.watch", // F12 AUD-025 / E-AUD-41: daily watch-list check → verfahrensdoku.outdated
  "verfahrensdoku.release", // F12 AUD-025: read side of the owner's release action (Markdown + sources)
  "cron.system.clock", // F12 AUD-019: clock check every 10 minutes (reference CLOCK_REFERENCE_URL)
  "cron.members.expire",
  "cron.invariants.check",
  "cron.products.applyScheduledPrices", // F03 PRD-031, 02 §7 products.applyScheduledPrices
  "cron.api.cleanup", // 05 §3/§7, 06 §2.3: expired idempotency records and confirm tokens, access log > 90 days
  "cron.deadlines.notify", // 02 §7 deadlines.notify (F04 SND-21 to-dos)
  "cron.assets.depreciate", // 02 §7 assets.depreciate (F08 AST-009): 1st of the month 05:00 Europe/Berlin
  "cron.notifications.maintain", // F12 NTF-001/006: purge read > 90 days, escalate unresolved errors after 24 h
  "notifications.deliver", // F12 NTF-003/004: e-mail (Cloudflare Email Sending) and ntfy delivery of one notification
  "exports.run", // F09 EXP-026 / F04 SND-20: job workers (CSV, bulk export ZIP, bulk mark) — file storage only
  "cron.jobs.expire", // F09 EXP-026: job results older than 30 days are removed from storage
  "cron.exports.archiveReminder", // F09 EXP-025: from 31.01. a reminder to archive the closed year (full + GDPdU)
  "cron.recurring.generate", // 02 §7 recurring.generate (F04 REC-05), daily 06:00 Europe/Berlin
  "cron.dunning.run", // 02 §7 dunning.run (F05 DUN-030): drafts or finalises reminders, never sends
  "cron.receivables.refreshOverdue", // 02 §7 receivables.refreshOverdue (F05 PAY-044, DUN-053 „Bald fällig“ to-dos)
  "cron.recurringVouchers.generate", // 02 §7 recurringVouchers.generate (F06 VOU-064), daily 06:15 Europe/Berlin
  "cron.inbox.pollR2", // 02 §7 inbox.pollR2 (F06 INB-049): every 5 min, lists/reads/deletes the R2 e-mail-in bucket
  "cron.bank.sync", // 02 §7 bank.sync (F07 BNK-106): every 6 h at 05:30/11:30/17:30/23:30 Europe/Berlin
  "cron.bank.consentExpiryReminder", // 02 §7 bank.consentExpiryReminder (F07 BNK-105): daily 08:00 Europe/Berlin
  "bank.feed", // F07 internal reads of the Enable Banking Node actions (encrypted secrets, poll targets; no writes)
  "bank.rules", // F07 BNK-050/052 rule application after an import or poll (scheduled; marks render an Eigenbeleg)
  "inbox.classify", // F06 §4.1 classification pipeline (Node action; writes through actorMutations with the capturer)
  "documents.pipeline", // F04 §4.6 step 1 reads and step 3 renderArtifacts (scheduled, retried)
  "imports.files", // F09 IMP-016 Node action that unpacks uploaded ZIPs into storage (no db writes)
  "imports.protocol", // F09 IMP-024 Node action that renders the import protocol PDF into storage (no db writes)
  "auth", // member created by the sign-up trigger, OTP throttle, auth-mail failures
  "test", // IS_TEST-only fixtures for the E2E journeys (convex/testFixtures.ts); refuse to run otherwise
  "migration", // migrations:run — the runner then acts as system:migration.<name> (AUD-028)
  "system.restore", // F09 EXP-024 ops only (npx convex run restore:preflight / restore:complete) → system.restore
  "cron.retention.scan", // F12 PRV-003 monthly scan → retention.purge_eligible (never purges)
  "cron.dsgvo.deadlines", // F12 PRV-010 daily: reminders at due − 7 / − 1 days, overdue error (E-PRV-12)
  "retention.purge", // F12 PRV-006/008 purge worker reads (writes run as the owner via actorMutations)
  "retention.replay", // F12 PRV-009 ops: re-applies the off-host purge log after a restore
  "dsgvo.export", // F12 PRV-013 access/portability export worker reads (Node action)
] as const;
export type SystemJob = (typeof SYSTEM_JOBS)[number];

/** Metadata attached to every registered function for the mutation inventory (AUD-012). */
export const WRAPPER_TAG = "__rechnungenWrapper";
export interface WrapperMeta {
  wrapper: "query" | "mutation" | "action" | "systemQuery" | "systemMutation" | "systemAction" | "actorMutation";
  permission?: Permission;
  job?: SystemJob;
}

// biome-ignore lint/suspicious/noExplicitAny: generic builder pass-through; types come from convex-helpers
function tagged<B extends (def: any) => any>(meta: Omit<WrapperMeta, "permission" | "job">, builder: B): B {
  return ((def: { permission?: Permission; job?: SystemJob } | ((...a: unknown[]) => unknown)) => {
    if (typeof def === "function") throw new Error(`${meta.wrapper}: use the object form with permission/job`);
    if (meta.wrapper === "systemQuery" || meta.wrapper === "systemMutation" || meta.wrapper === "systemAction") {
      if (!def.job || !(SYSTEM_JOBS as readonly string[]).includes(def.job)) {
        throw new Error(`${meta.wrapper}: unknown system job ${String(def.job)}`);
      }
    } else if (!def.permission || !(def.permission in PERMISSIONS)) {
      throw new Error(
        `${meta.wrapper}: every function must declare a known permission (got ${String(def.permission)})`,
      );
    }
    const intent = def.permission ? confirmIntentFor(def.permission) : undefined;
    // ⚠ acts that render a voucher first (Eigenbeleg) run as action → actorMutation: the action only forwards the
    // token, the actorMutation consumes it in the transaction of the act (06 §2.3). Both must declare it.
    if (intent && (meta.wrapper === "action" || meta.wrapper === "actorMutation")) {
      const args = (def as { args?: Record<string, unknown> }).args;
      if (!args || "isConvexValidator" in args || !("confirmToken" in args)) {
        throw new Error(`${meta.wrapper}: the ⚠ permission ${def.permission} needs \`confirmToken: vConfirmToken\``);
      }
    }
    const fn = builder(
      intent && (meta.wrapper === "mutation" || meta.wrapper === "actorMutation")
        ? withConfirmToken(def as ConfirmableDef, intent)
        : def,
    );
    return Object.assign(fn, {
      [WRAPPER_TAG]: {
        ...meta,
        ...(def.permission ? { permission: def.permission } : {}),
        ...(def.job ? { job: def.job } : {}),
      },
    });
  }) as B;
}

/**
 * ⚠ actions (permission rule `confirm`, 06 §2.3, CLAUDE.md rule 8, EC-188): the mutation must declare
 * `confirmToken: vConfirmToken` in its args (typed in the generated API; registration fails otherwise). For `mcp:`
 * actors a valid token for the intent — bound to the key, the canonical arguments (without the token) and the
 * previewed entity versions — is required and consumed in this transaction; UI and REST callers are unaffected.
 * The handler never sees `confirmToken`.
 */
export const vConfirmToken = v.optional(v.string());

interface ConfirmableDef {
  permission: Permission;
  args?: Record<string, unknown>;
  /**
   * actorMutation only: the argument names the token binds (the preview cannot know server-made arguments such as
   * the stored Eigenbeleg file); `actorContext` is never part of the hash.
   */
  confirmArgs?: readonly string[];
  handler: (ctx: ModelCtx, args: Record<string, unknown>) => unknown;
}

function withConfirmToken(def: ConfirmableDef, intent: ConfirmIntent): ConfirmableDef {
  if (!def.args || "isConvexValidator" in def.args || !("confirmToken" in def.args)) {
    throw new Error(`mutation: the ⚠ permission ${def.permission} needs \`confirmToken: vConfirmToken\` in its args`);
  }
  return {
    ...def,
    handler: async (ctx, args) => {
      const { confirmToken, ...rest } = args;
      if (ctx.actorContext.channel === "mcp") {
        const { actorContext: _a, ...bound } = rest;
        const hashed = def.confirmArgs
          ? Object.fromEntries(Object.entries(bound).filter(([k]) => def.confirmArgs?.includes(k)))
          : bound;
        await consumeConfirmToken(ctx, intent, confirmToken as string | undefined, hashed);
      }
      return def.handler(ctx, rest);
    },
  };
}

/** AUD-001 / E-AUD-01: a mutation that wrote without an audit entry is aborted (exported for the unit test). */
export const auditCheck = (stats: WriteStats) => () => {
  if (stats.writes > 0 && stats.audits === 0) throw appError("audit_missing");
};

function systemContext(job: SystemJob): ActorContext {
  return { actor: `system:${job}` as Actor, channel: job.startsWith("cron.") ? "cron" : "system" };
}

const fields = (a: ActorContext) => ({ actor: a.actor, role: a.role, actorContext: a, now: () => Date.now() });

// ── public builders ───────────────────────────────────────────────────────────────────────────────────
export const query = tagged(
  { wrapper: "query" },
  customQuery(rawQuery, {
    args: {},
    input: async (ctx, _args, extra: { permission: Permission }) => {
      const a = await resolveActor(ctx, extra.permission, { checkSession: false, now: Date.now() });
      if (a.role !== "auditor") return { ctx: fields(a), args: {} };
      // F12 AUD-023: year-scoped tables only show the granted fiscal years to an auditor.
      const startMonth = (await ctx.db.query("companyProfile").first())?.fiscalYearStartMonth ?? 1;
      return { ctx: { ...fields(a), db: auditorScopedDb(ctx.db, a.auditorYears ?? [], startMonth) }, args: {} };
    },
  }),
);

export const mutation = tagged(
  { wrapper: "mutation" },
  customMutation(rawMutation, {
    args: {},
    input: async (ctx, _args, extra: { permission: Permission }) => {
      const a = await resolveActor(ctx, extra.permission, { checkSession: true, now: Date.now() });
      const stats = newWriteStats();
      return { ctx: { ...fields(a), db: guardedDb(ctx.db, stats) }, args: {}, onSuccess: auditCheck(stats) };
    },
  }),
);

export const action = tagged(
  { wrapper: "action" },
  customAction(rawAction, {
    args: {},
    input: async (ctx, _args, extra: { permission: Permission }) => {
      const a: ActorContext = await ctx.runQuery(internal.access.resolveForAction, { permission: extra.permission });
      return { ctx: fields(a), args: {} };
    },
  }),
);

// ── internal builders ─────────────────────────────────────────────────────────────────────────────────
export const systemQuery = tagged(
  { wrapper: "systemQuery" },
  customQuery(rawInternalQuery, {
    args: {},
    input: async (_ctx, _args, extra: { job: SystemJob }) => ({ ctx: fields(systemContext(extra.job)), args: {} }),
  }),
);

export const systemMutation = tagged(
  { wrapper: "systemMutation" },
  customMutation(rawInternalMutation, {
    args: {},
    input: async (ctx, _args, extra: { job: SystemJob }) => {
      const stats = newWriteStats();
      return {
        ctx: { ...fields(systemContext(extra.job)), db: guardedDb(ctx.db, stats) },
        args: {},
        onSuccess: auditCheck(stats),
      };
    },
  }),
);

export const systemAction = tagged(
  { wrapper: "systemAction" },
  customAction(rawInternalAction, {
    args: {},
    input: async (_ctx, _args, extra: { job: SystemJob }) => ({ ctx: fields(systemContext(extra.job)), args: {} }),
  }),
);

/**
 * Internal mutation called by our own actions with the action's resolved ActorContext (attribution survives
 * the action → mutation hop). Internal functions are not callable by clients, so the context is trusted.
 */
export const actorMutation = tagged(
  { wrapper: "actorMutation" },
  customMutation(rawInternalMutation, {
    args: { actorContext: vActorContext },
    input: async (ctx, args, _extra: { permission: Permission; confirmArgs?: readonly string[] }) => {
      const stats = newWriteStats();
      const a = args.actorContext as ActorContext;
      return { ctx: { ...fields(a), db: guardedDb(ctx.db, stats) }, args: {}, onSuccess: auditCheck(stats) };
    },
  }),
);
