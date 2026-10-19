import { v } from "convex/values";
import { notificationMail, ntfyMessage } from "../src/domain/notifications/catalog";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { action, actorMutation, mutation, query, systemAction, systemMutation, systemQuery } from "./functions";
import { senderFromEnv } from "./lib/authMail";
import { isTest, siteUrl } from "./lib/env";
import { appError } from "./lib/errors";
import { isPublicNtfy, ntfySenderFromEnv } from "./lib/ntfy";
import { decryptSecret } from "./model/contactKeys";
import {
  channelMatrix,
  deliveryData,
  listNotifications,
  maintainNotifications,
  markAllRead as markAllReadModel,
  markRead as markReadModel,
  recordNtfyOutcome,
  saveNtfy as saveNtfyModel,
  setKindChannels,
  unreadCount as unreadCountModel,
} from "./model/notifications";

/**
 * Notifications (F12 NTF-001…007, 03 §10): bell + list, channel matrix and ntfy settings, delivery and maintenance.
 * Notifications themselves are created by the model layer (domain events and crons), never from here.
 */

const vSeverity = v.union(v.literal("info"), v.literal("warning"), v.literal("error"), v.literal("critical"));
const vChannels = v.object({ inApp: v.boolean(), email: v.boolean(), ntfy: v.boolean(), digest: v.boolean() });

export const list = query({
  permission: "notifications.read",
  args: {
    severity: v.optional(vSeverity),
    kind: v.optional(v.string()),
    unreadOnly: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => listNotifications(ctx, args),
});

export const unreadCount = query({
  permission: "notifications.read",
  args: {},
  handler: async (ctx) => unreadCountModel(ctx),
});

export const markRead = mutation({
  permission: "notifications.write",
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const nid = ctx.db.normalizeId("notifications", id);
    if (!nid) throw appError("not_found");
    await markReadModel(ctx, nid);
  },
});

export const markAllRead = mutation({
  permission: "notifications.write",
  args: {},
  handler: async (ctx) => markAllReadModel(ctx),
});

// ── settings (/einstellungen/benachrichtigungen) ────────────────────────────────────────────────────────────

export const settings = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) => {
    const m = await channelMatrix(ctx);
    return { ...m, ntfyIsPublic: m.ntfy ? isPublicNtfy(m.ntfy.serverUrl) : false };
  },
});

export const setChannels = mutation({
  permission: "settings.ownerOnly",
  args: { kind: v.string(), channels: vChannels },
  handler: async (ctx, { kind, channels }) => setKindChannels(ctx, kind, channels),
});

export const saveNtfy = mutation({
  permission: "settings.ownerOnly",
  args: {
    ntfy: v.union(
      v.null(),
      v.object({
        serverUrl: v.string(),
        topic: v.string(),
        token: v.optional(v.string()),
        clearToken: v.optional(v.boolean()),
        sendDetails: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, { ntfy }) => saveNtfyModel(ctx, ntfy),
});

// ── delivery (NTF-003/004) ────────────────────────────────────────────────────────────────────────────────

export const deliveryInput = systemQuery({
  job: "notifications.deliver",
  args: { id: v.id("notifications") },
  handler: async (ctx, { id }) => deliveryData(ctx, id),
});

export const recordNtfy = systemMutation({
  job: "notifications.deliver",
  args: { ok: v.boolean() },
  handler: async (ctx, { ok }) => recordNtfyOutcome(ctx, ok),
});

function devStore(ctx: Pick<ActionCtx, "runMutation">) {
  return async (mail: { to: string; subject: string; text: string; kind: string }) => {
    await ctx.runMutation(internal.signup.storeDevMail, {
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      kind: mail.kind,
    });
  };
}

type NtfyConfig = { serverUrl: string; topic: string; encryptedToken?: string; sendDetails: boolean };

async function publishNtfy(
  ctx: Pick<ActionCtx, "runMutation">,
  cfg: NtfyConfig,
  n: Parameters<typeof ntfyMessage>[0],
): Promise<{ ok: boolean; detail: string }> {
  const msg = ntfyMessage(n, { topic: cfg.topic, sendDetails: cfg.sendDetails, appUrl: siteUrl() });
  const token = cfg.encryptedToken ? await decryptSecret(cfg.encryptedToken) : undefined;
  const store = devStore(ctx);
  const sender = ntfySenderFromEnv(async (m) =>
    store({ to: `ntfy@${m.topic}`, subject: m.title, text: `${m.priority}\n${m.message}`, kind: "ntfy" }),
  );
  const r = await sender.publish(cfg.serverUrl, msg, token);
  return r.ok ? { ok: true, detail: "ok" } : { ok: false, detail: r.detail };
}

/** Scheduled by the model on create/reopen and by the escalation (NTF-006). In-app delivery already happened. */
export const deliver = systemAction({
  job: "notifications.deliver",
  args: { id: v.id("notifications"), escalation: v.boolean() },
  handler: async (ctx, { id }) => {
    const data = await ctx.runQuery(internal.notifications.deliveryInput, { id });
    if (!data) return { email: "skipped", ntfy: "skipped" } as const;
    let email: "sent" | "failed" | "skipped" = "skipped";
    let ntfy: "sent" | "failed" | "skipped" = "skipped";
    if (data.channels.email && data.email) {
      const mail = notificationMail(data.notification, {
        companyName: data.companyName,
        sendDetails: data.ntfy?.sendDetails ?? false,
        appUrl: siteUrl(),
      });
      const r = await senderFromEnv(devStore(ctx)).send({ to: data.email, kind: "notification", ...mail });
      email = r.ok ? "sent" : "failed";
    }
    if (data.channels.ntfy && data.ntfy) {
      const r = await publishNtfy(ctx, data.ntfy, data.notification);
      ntfy = r.ok ? "sent" : "failed";
      await ctx.runMutation(internal.notifications.recordNtfy, { ok: r.ok });
    }
    return { email, ntfy };
  },
});

export const ntfyConfig = systemQuery({
  job: "notifications.deliver",
  args: {},
  handler: async (ctx) => (await ctx.db.query("notificationSettings").first())?.ntfy ?? null,
});

export const recordNtfyTest = actorMutation({
  permission: "integrations.manage",
  args: { ok: v.boolean() },
  handler: async (ctx, { ok }) => recordNtfyOutcome(ctx, ok),
});

/** „Test senden" (F12 §6): one data-minimal test message to the configured topic. */
export const testNtfy = action({
  permission: "integrations.manage",
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; message: string }> => {
    const cfg = await ctx.runQuery(internal.notifications.ntfyConfig, {});
    if (!cfg) throw appError("invalid_input", "Bitte zuerst Server und Thema speichern.");
    const r = await publishNtfy(
      ctx,
      { ...cfg, sendDetails: true },
      {
        kind: "test",
        severity: "info",
        title: "Testnachricht – Benachrichtigungen funktionieren",
      },
    );
    await ctx.runMutation(internal.notifications.recordNtfyTest, { actorContext: ctx.actorContext, ok: r.ok });
    return r.ok
      ? { ok: true, message: "Testnachricht gesendet." }
      : { ok: false, message: `ntfy-Benachrichtigungen konnten nicht zugestellt werden. (${r.detail})` };
  },
});

// ── maintenance cron ─────────────────────────────────────────────────────────────────────────────────────

export const maintainCron = systemMutation({
  job: "cron.notifications.maintain",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return null; // 02 §7: crons skip with IS_TEST unless invoked explicitly
    return maintainNotifications(ctx);
  },
});
