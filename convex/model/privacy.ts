import { type Art30Record, art30Record } from "../../src/domain/privacy/art30";
import {
  type ConfiguredService,
  configuredServices,
  EXTERNAL_SERVICES,
  regionOfEndpoint,
  type ServiceRegion,
} from "../../src/domain/privacy/external-services";
import {
  RECORD_RETENTION,
  RETENTION_CLASS_LABEL_DE,
  RETENTION_RULE_VERSION,
  retentionYears,
} from "../../src/domain/rules/retention";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { type CalendarDate, formatGermanDate } from "../../src/domain/time/calendar-date";
import { configuredTransport } from "../lib/authMail";
import { env } from "../lib/env";
import { appError } from "../lib/errors";
import { auditedDelete, auditedInsert } from "./audit";
import { getNotificationSettings } from "./notificationSettings";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * External services page and Art. 30 record (F12 PRV-015/016, F01 SET-048/109/114, 01 DSGVO-01/04). Which services
 * are in use is derived from the Convex env (mail transport, R2 endpoint) and the settings (integrations, ntfy);
 * `publicEdge` comes from the web server (EDGE_MODE, 08 §12) and only adds the Cloudflare tunnel to the list.
 */

export async function serviceUsage(ctx: ReadCtx, opts: { publicEdge?: boolean } = {}) {
  const inUse: { id: string; region?: ServiceRegion; detail?: string }[] = [];
  if (configuredTransport() === "cloudflare") inUse.push({ id: "cloudflare_email" });
  const r2 = env("R2_ACCOUNT_ENDPOINT");
  if (r2 || env("R2_CHECKPOINT_BUCKET")) {
    inUse.push({
      id: "cloudflare_r2",
      region: regionOfEndpoint(r2 ?? ""),
      ...(r2 ? { detail: new URL(r2).hostname } : {}),
    });
  }
  const integrations = await ctx.db.query("integrations").collect();
  const enabled = (kind: string) => integrations.find((i) => i.kind === kind && i.enabled);
  const inbox = enabled("r2_inbox");
  if (inbox)
    inUse.push({ id: "cloudflare_r2_inbox", ...(inbox.region ? { region: regionOfEndpoint("", inbox.region) } : {}) });
  if (enabled("claude")) inUse.push({ id: "claude" });
  if (opts.publicEdge) inUse.push({ id: "cloudflare_edge" });
  inUse.push({ id: "tailscale" }, { id: "lets_encrypt" });
  const ntfy = (await getNotificationSettings(ctx))?.ntfy;
  if (ntfy)
    inUse.push({ id: "ntfy", region: regionOfEndpoint(ntfy.serverUrl), detail: new URL(ntfy.serverUrl).hostname });
  inUse.push({ id: "evatr" }, { id: "vies" });
  const avv: Record<string, number> = {};
  for (const c of await ctx.db.query("serviceConfirmations").collect()) avv[c.serviceId] = c.confirmedAt;
  return { inUse, avv };
}

export async function externalServices(
  ctx: ReadCtx,
  opts: { publicEdge?: boolean } = {},
): Promise<ConfiguredService[]> {
  return configuredServices(await serviceUsage(ctx, opts));
}

/** SET-109/114: the owner confirms (or withdraws) the AVV of a processor; audited, never blocking. */
export async function setAvvConfirmation(ctx: ModelCtx, serviceId: string, confirmed: boolean, note?: string) {
  const def = EXTERNAL_SERVICES.find((s) => s.id === serviceId);
  if (!def) throw appError("invalid_input", "Unbekannter Dienst.");
  if (def.role !== "processor")
    throw appError("invalid_input", "Für diesen Dienst ist kein Auftragsverarbeitungsvertrag nötig.");
  const existing = await ctx.db
    .query("serviceConfirmations")
    .withIndex("by_service", (q) => q.eq("serviceId", serviceId))
    .first();
  if (existing && !confirmed) {
    await auditedDelete(ctx, "serviceConfirmations", existing._id, {
      action: "settings.privacy.update",
      label: def.name,
    });
    return;
  }
  if (!confirmed || existing) return;
  await auditedInsert(
    ctx,
    "serviceConfirmations",
    {
      serviceId,
      confirmedAt: ctx.now(),
      confirmedBy: ctx.actor,
      ...(note?.trim() ? { note: note.trim().slice(0, 500) } : {}),
    },
    { action: "settings.privacy.update", label: def.name },
  );
}

export async function art30(
  ctx: ReadCtx & { now: () => number },
  opts: { publicEdge?: boolean } = {},
): Promise<Art30Record> {
  const profile = await ctx.db.query("companyProfile").first();
  const addr = profile?.address;
  const address = addr
    ? [addr.street, `${addr.postalCode} ${addr.city}`].filter(Boolean).join(", ")
    : "Anschrift fehlt";
  return art30Record({
    controller: {
      name: profile?.name ?? "Unternehmen",
      address,
      ...(profile?.contact.email ? { email: profile.contact.email } : {}),
      ...(profile?.contact.name ? { representative: profile.contact.name } : {}),
    },
    services: await externalServices(ctx, opts),
    today: formatGermanDate(berlinCalendarDate(ctx.now()) as CalendarDate),
  });
}

/** PRV-001: retention classes for the „Aufbewahrung" tab (rule table version, years as of today). */
export function retentionOverview(today: string) {
  const byClass = new Map<string, string[]>();
  for (const [table, cls] of Object.entries(RECORD_RETENTION)) {
    const list = byClass.get(cls) ?? [];
    list.push(table);
    byClass.set(cls, list);
  }
  return {
    version: RETENTION_RULE_VERSION,
    classes: (["books10", "vouchers8", "letters6", "none"] as const).map((cls) => ({
      cls,
      label: RETENTION_CLASS_LABEL_DE[cls],
      years: cls === "none" ? null : retentionYears(cls, today as CalendarDate),
      tables: byClass.get(cls) ?? [],
    })),
  };
}
