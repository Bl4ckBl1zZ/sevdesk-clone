import {
  channelsFor,
  checkChannelChange,
  escalationDue,
  kindDef,
  NOTIFICATION_KINDS,
  type NotificationChannels,
  type NotificationKind,
  type NotificationSeverity,
  NTFY_FAILURES_BEFORE_WARNING,
  purgeDue,
} from "../../src/domain/notifications/catalog";
import { isEuRegion, nonEuWarning, regionOfEndpoint } from "../../src/domain/privacy/external-services";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { ntfyServerProblem } from "../lib/ntfy";
import { auditedDelete, auditedInsert, auditedPatch } from "./audit";
import { encryptSecret } from "./contactKeys";
import { getNotificationSettings } from "./notificationSettings";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Notifications (03 §10, F12 NTF-001…007). Created only by domain events and crons in the model layer (NTF-007), so
 * UI, REST and MCP triggered events notify alike. Delivery to e-mail/ntfy runs in a scheduled action and never
 * blocks the in-app record (NTF-003, E-NTF-01).
 */

export interface NotificationInput {
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  link?: string;
  entity?: { table: string; id: string };
  dedupeKey: string;
}

async function matrix(ctx: ReadCtx): Promise<Record<string, NotificationChannels>> {
  return (await getNotificationSettings(ctx))?.channelsByKind ?? {};
}

async function scheduleDelivery(ctx: ModelCtx, id: Id<"notifications">, n: NotificationInput, escalation: boolean) {
  const ch = channelsFor(n.kind, n.severity, await matrix(ctx));
  if (ch.email || ch.ntfy) {
    await ctx.scheduler.runAfter(0, internal.notifications.deliver, { id, escalation });
  }
}

/**
 * NTF-006: the same `dedupeKey` while the notification is open updates it (counter, latest title/body) instead of
 * creating a new one and is not delivered again; a resolved one is reopened and delivered.
 */
export async function notify(ctx: ModelCtx, n: NotificationInput): Promise<Id<"notifications">> {
  const existing = await ctx.db
    .query("notifications")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", n.dedupeKey))
    .first();
  const inApp = channelsFor(n.kind, n.severity, await matrix(ctx)).inApp;
  if (existing && existing.resolvedAt === undefined) {
    await auditedPatch(
      ctx,
      "notifications",
      existing._id,
      { count: existing.count + 1, title: n.title, ...(n.body !== undefined ? { body: n.body } : {}) },
      { action: "notification.update", label: n.title },
    );
    return existing._id;
  }
  if (existing) {
    await auditedPatch(
      ctx,
      "notifications",
      existing._id,
      {
        resolvedAt: undefined,
        readAt: inApp ? undefined : ctx.now(),
        escalatedAt: undefined,
        count: existing.count + 1,
        title: n.title,
        createdAt: ctx.now(),
      },
      { action: "notification.create", label: n.title },
    );
    await scheduleDelivery(ctx, existing._id, n, false);
    return existing._id;
  }
  const id = await auditedInsert(
    ctx,
    "notifications",
    { ...n, count: 1, createdAt: ctx.now(), ...(inApp ? {} : { readAt: ctx.now() }) },
    { action: "notification.create", label: n.title },
  );
  await scheduleDelivery(ctx, id, n, false);
  return id;
}

/** Convenience for catalog kinds: severity from the catalog, dedupe key kind + entity + Berlin day (NTF-001). */
export async function notifyKind(
  ctx: ModelCtx,
  kind: NotificationKind,
  n: { title: string; body?: string; link?: string; entity?: { table: string; id: string }; dedupeKey?: string },
): Promise<Id<"notifications">> {
  const day = berlinCalendarDate(ctx.now());
  const entityKey = n.entity ? `${n.entity.table}:${n.entity.id}` : "-";
  return notify(ctx, {
    kind,
    severity: NOTIFICATION_KINDS[kind].severity,
    title: n.title,
    ...(n.body !== undefined ? { body: n.body } : {}),
    ...(n.link !== undefined ? { link: n.link } : {}),
    ...(n.entity ? { entity: n.entity } : {}),
    dedupeKey: n.dedupeKey ?? `${kind}|${entityKey}|${day}`,
  });
}

// ── in-app list (NTF-001) ─────────────────────────────────────────────────────────────────────────────────

export interface NotificationFilter {
  severity?: NotificationSeverity;
  kind?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export async function listNotifications(ctx: ReadCtx, f: NotificationFilter = {}) {
  const rows = await ctx.db.query("notifications").order("desc").take(1000);
  return rows
    .filter(
      (n) =>
        (f.severity === undefined || n.severity === f.severity) &&
        (f.kind === undefined || n.kind === f.kind) &&
        (!f.unreadOnly || n.readAt === undefined),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.min(Math.max(f.limit ?? 200, 1), 500))
    .map((n) => ({
      id: n._id,
      kind: n.kind,
      kindLabel: kindDef(n.kind)?.label ?? null,
      severity: n.severity,
      title: n.title,
      body: n.body ?? null,
      link: n.link ?? null,
      count: n.count,
      createdAt: n.createdAt,
      readAt: n.readAt ?? null,
      resolvedAt: n.resolvedAt ?? null,
    }));
}

export async function unreadCount(ctx: ReadCtx): Promise<number> {
  let count = 0;
  for (const n of await ctx.db.query("notifications").take(2000)) if (n.readAt === undefined) count++;
  return count;
}

export async function markRead(ctx: ModelCtx, id: Id<"notifications">): Promise<void> {
  const n = await ctx.db.get(id);
  if (!n) throw appError("not_found");
  if (n.readAt !== undefined) return;
  await auditedPatch(ctx, "notifications", id, { readAt: ctx.now() }, { action: "notification.read", label: n.title });
}

export async function markAllRead(ctx: ModelCtx): Promise<number> {
  let marked = 0;
  for (const n of await ctx.db.query("notifications").take(2000)) {
    if (n.readAt !== undefined) continue;
    await auditedPatch(ctx, "notifications", n._id, { readAt: ctx.now() }, { action: "notification.read" });
    marked++;
  }
  return marked;
}

// ── maintenance cron (NTF-001 retention, NTF-006 escalation) ───────────────────────────────────────────────

export async function maintainNotifications(ctx: ModelCtx): Promise<{ escalated: number; purged: number }> {
  const now = ctx.now();
  let escalated = 0;
  let purged = 0;
  for (const n of await ctx.db.query("notifications").take(5000)) {
    if (escalationDue(n, now)) {
      await auditedPatch(
        ctx,
        "notifications",
        n._id,
        { escalatedAt: now },
        { action: "notification.escalate", label: n.title },
      );
      await scheduleDelivery(ctx, n._id, n, true);
      escalated++;
    } else if (purgeDue(n, now)) {
      await auditedDelete(ctx, "notifications", n._id, { action: "notification.purge" });
      purged++;
    }
  }
  return { escalated, purged };
}

// ── settings (NTF-002 matrix, NTF-004 ntfy) ────────────────────────────────────────────────────────────────

async function ensureSettings(ctx: ModelCtx): Promise<Doc<"notificationSettings">> {
  const existing = await getNotificationSettings(ctx);
  if (existing) return existing;
  const id = await auditedInsert(
    ctx,
    "notificationSettings",
    { channelsByKind: {} },
    { action: "settings.notifications.update" },
  );
  return (await ctx.db.get(id)) as Doc<"notificationSettings">;
}

export async function setKindChannels(ctx: ModelCtx, kind: string, channels: NotificationChannels): Promise<void> {
  const check = checkChannelChange(kind, channels);
  if (!check.ok) throw appError("invalid_input", check.error, { reason: "NTF_CRITICAL_LOCKED" });
  const s = await ensureSettings(ctx);
  await auditedPatch(
    ctx,
    "notificationSettings",
    s._id,
    { channelsByKind: { ...s.channelsByKind, [kind]: channels } },
    { action: "settings.notifications.update", label: kind },
  );
}

export async function saveNtfy(
  ctx: ModelCtx,
  input: { serverUrl: string; topic: string; token?: string; clearToken?: boolean; sendDetails: boolean } | null,
): Promise<{ warning: string | null }> {
  const s = await ensureSettings(ctx);
  if (input === null) {
    await auditedPatch(
      ctx,
      "notificationSettings",
      s._id,
      { ntfy: undefined },
      { action: "settings.notifications.update", label: "ntfy" },
    );
    return { warning: null };
  }
  const serverUrl = input.serverUrl.trim();
  const problem = ntfyServerProblem(serverUrl);
  if (problem) throw appError("invalid_input", problem);
  const topic = input.topic.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) {
    throw appError("invalid_input", "Das Thema darf nur Buchstaben, Ziffern, - und _ enthalten (max. 64 Zeichen).");
  }
  const token = input.token?.trim();
  const encryptedToken = token ? await encryptSecret(token) : input.clearToken ? undefined : s.ntfy?.encryptedToken;
  await auditedPatch(
    ctx,
    "notificationSettings",
    s._id,
    {
      ntfy: {
        serverUrl,
        topic,
        ...(encryptedToken ? { encryptedToken } : {}),
        sendDetails: input.sendDetails,
        failures: 0,
      },
    },
    { action: "settings.notifications.update", label: "ntfy" },
  );
  // SET-048: a non-EU (or unknown-region) endpoint warns on save; it never blocks.
  const host = new URL(serverUrl).hostname;
  return { warning: isEuRegion(regionOfEndpoint(serverUrl)) ? null : nonEuWarning(`ntfy (${host})`) };
}

/** E-NTF-01: consecutive ntfy failures; the third raises an in-app/e-mail warning, a success resets the counter. */
export async function recordNtfyOutcome(ctx: ModelCtx, ok: boolean): Promise<void> {
  const s = await getNotificationSettings(ctx);
  if (!s?.ntfy) return;
  const failures = ok ? 0 : (s.ntfy.failures ?? 0) + 1;
  if (failures === (s.ntfy.failures ?? 0)) return;
  await auditedPatch(
    ctx,
    "notificationSettings",
    s._id,
    { ntfy: { ...s.ntfy, failures } },
    { action: "notification.deliver", label: ok ? "ntfy ok" : `ntfy Fehler ${failures}` },
  );
  if (failures === NTFY_FAILURES_BEFORE_WARNING) {
    await notifyKind(ctx, "ntfy.failed", {
      title: "ntfy-Benachrichtigungen konnten nicht zugestellt werden.",
      link: "/einstellungen/benachrichtigungen",
    });
  }
}

/** Everything the delivery action needs, read in one query. */
export async function deliveryData(ctx: ReadCtx, id: Id<"notifications">) {
  const n = await ctx.db.get(id);
  if (!n) return null;
  const s = await getNotificationSettings(ctx);
  const company = await ctx.db.query("companyProfile").first();
  const channels = channelsFor(n.kind, n.severity, s?.channelsByKind ?? {});
  return {
    notification: { kind: n.kind, severity: n.severity, title: n.title, body: n.body, link: n.link },
    channels,
    companyName: company?.name ?? "Rechnungen",
    email: s?.email?.address ?? null,
    ntfy: s?.ntfy ?? null,
  };
}

/** Matrix rows for the settings page: catalog kinds with defaults and effective channels. */
export async function channelMatrix(ctx: ReadCtx) {
  const s = await getNotificationSettings(ctx);
  const m = s?.channelsByKind ?? {};
  return {
    rows: (Object.keys(NOTIFICATION_KINDS) as NotificationKind[]).map((kind) => {
      const d = NOTIFICATION_KINDS[kind];
      return {
        kind,
        label: d.label,
        severity: d.severity,
        locked: d.severity === "critical",
        defaults: d.channels,
        channels: channelsFor(kind, d.severity, m),
      };
    }),
    email: s?.email?.address ?? null,
    ntfy: s?.ntfy
      ? {
          serverUrl: s.ntfy.serverUrl,
          topic: s.ntfy.topic,
          hasToken: s.ntfy.encryptedToken !== undefined,
          sendDetails: s.ntfy.sendDetails,
          failures: s.ntfy.failures ?? 0,
        }
      : null,
  };
}

/** Resolves the open notifications of one (pseudo) entity, e.g. {table: "system", id: "clock"}. */
export async function resolveEntityNotifications(
  ctx: ModelCtx,
  entity: { table: string; id: string },
  kind?: string,
): Promise<number> {
  let n = 0;
  for (const row of await ctx.db
    .query("notifications")
    .withIndex("by_entity", (q) => q.eq("entity.table", entity.table).eq("entity.id", entity.id))
    .collect()) {
    if (row.resolvedAt !== undefined || (kind && row.kind !== kind)) continue;
    await auditedPatch(ctx, "notifications", row._id, { resolvedAt: ctx.now() }, { action: "notification.resolve" });
    n++;
  }
  return n;
}
