import { parseAllowlist } from "../../src/domain/inbox/allowlist";
import { INBOX_MAIL_MESSAGES } from "../../src/domain/inbox/email";
import { OCR_MESSAGES } from "../../src/domain/inbox/ocr";
import {
  CLAUDE_DEFAULTS,
  type ClaudeRegion,
  type ClaudeSettings,
  checkClaudeSettings,
  nextUsage,
} from "../../src/domain/inbox/ocr-settings";
import { type PollOutcome, pollHealth } from "../../src/domain/inbox/r2-plan";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { Doc } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { encryptSecret } from "../lib/secrets";
import { auditedInsert, auditedPatch } from "./audit";
import { releaseOcrPending } from "./inbox";
import { getIntegration } from "./integrations";
import { upsertNotification } from "./salesDocuments";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Einstellungen › Posteingang (F01 SET-110, F06 INB-011/051/052) and › Belegerkennung (SET-111…113).
 *
 *  r2_inbox: non-secret config only — receiving address, allowlist, poll health. The R2 credentials live only in the
 *            Convex env (02 §4.5) and are reported as „konfiguriert / fehlt“. Enabling needs the Cloudflare AVV
 *            (`dpaConfirmedAt`, DSGVO-04).
 *  claude:   disabled by default; the API key is stored encrypted with APP_ENCRYPTION_KEY (`encryptedSecrets`, never
 *            returned); enabling needs the AVV checkbox; a non-EU region yields NON_EU_ENDPOINT (EC-INB-17).
 */

export interface InboxHealth {
  lastRunAt?: number;
  lastSuccessAt?: number;
  consecutiveFailures: number;
  pausedAt?: number;
  lastError?: string;
  objectsWaiting?: number;
  staleCount?: number;
  oldestStaleAt?: number;
}

export interface R2InboxConfig {
  receivingAddress?: string;
  allowlist: string[];
  health: InboxHealth;
}

export function r2ConfigOf(row: Doc<"integrations"> | null): R2InboxConfig {
  const c = (row?.config ?? {}) as Partial<R2InboxConfig>;
  return {
    ...(c.receivingAddress ? { receivingAddress: c.receivingAddress } : {}),
    allowlist: Array.isArray(c.allowlist) ? c.allowlist : [],
    health: { consecutiveFailures: 0, ...(c.health ?? {}) },
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function saveInboxSettings(
  ctx: ModelCtx,
  args: { enabled: boolean; receivingAddress?: string; allowlist: string; dpaConfirmed: boolean },
): Promise<void> {
  const address = args.receivingAddress?.trim().toLowerCase();
  if (address && !EMAIL_RE.test(address)) throw appError("invalid_input", "Bitte eine gültige E-Mail-Adresse angeben.");
  if (args.enabled && !args.dpaConfirmed) {
    throw appError(
      "invalid_input",
      "Bitte bestätigen, dass ein Auftragsverarbeitungsvertrag (AVV) mit Cloudflare abgeschlossen ist (DSGVO).",
      { reason: "DPA_REQUIRED" },
    );
  }
  const row = await getIntegration(ctx, "r2_inbox");
  const current = r2ConfigOf(row);
  const config = {
    ...current,
    ...(address ? { receivingAddress: address } : { receivingAddress: undefined }),
    allowlist: parseAllowlist(args.allowlist),
  };
  const fields = {
    config: JSON.parse(JSON.stringify(config)) as Record<string, unknown>,
    enabled: args.enabled,
    ...(args.dpaConfirmed ? { dpaConfirmedAt: row?.dpaConfirmedAt ?? ctx.now() } : { dpaConfirmedAt: undefined }),
    region: "eu",
  };
  if (row) {
    await auditedPatch(ctx, "integrations", row._id, fields, {
      action: "settings.integrations.update",
      label: "r2_inbox",
    });
  } else {
    await auditedInsert(
      ctx,
      "integrations",
      { kind: "r2_inbox", ...fields },
      { action: "settings.integrations.update", label: "r2_inbox" },
    );
  }
}

/** Poll health after a run (INB-052, EC-INB-28/29): failures count up, 401/403 pauses, notifications deduped. */
export async function recordPollRun(
  ctx: ModelCtx,
  args: {
    outcome: PollOutcome;
    objectsWaiting?: number;
    staleCount?: number;
    oldestStaleAt?: number;
    error?: string;
    resume?: boolean;
  },
): Promise<{ paused: boolean }> {
  const row = await getIntegration(ctx, "r2_inbox");
  const config = r2ConfigOf(row);
  const h = pollHealth({ consecutiveFailures: config.health.consecutiveFailures }, args.outcome);
  const now = ctx.now();
  const health: InboxHealth = {
    ...config.health,
    lastRunAt: now,
    consecutiveFailures: h.consecutiveFailures,
    ...(args.outcome === "ok" ? { lastSuccessAt: now, lastError: undefined } : {}),
    ...(args.error ? { lastError: args.error.slice(0, 300) } : {}),
    ...(args.objectsWaiting !== undefined ? { objectsWaiting: args.objectsWaiting } : {}),
    ...(args.staleCount !== undefined ? { staleCount: args.staleCount, oldestStaleAt: args.oldestStaleAt } : {}),
  };
  if (h.pause) health.pausedAt = now;
  if (args.resume && args.outcome === "ok") health.pausedAt = undefined;
  const value = JSON.parse(JSON.stringify({ ...config, health })) as Record<string, unknown>;
  if (row) {
    await auditedPatch(ctx, "integrations", row._id, { config: value }, { action: "inbox.poll", label: "r2_inbox" });
  } else {
    await auditedInsert(
      ctx,
      "integrations",
      { kind: "r2_inbox", config: value, enabled: false },
      { action: "inbox.poll", label: "r2_inbox" },
    );
  }
  const link = "/einstellungen/posteingang";
  if (h.alert === "unauthorized") {
    await upsertNotification(ctx, {
      kind: "inbox_unreachable",
      severity: "error",
      title: INBOX_MAIL_MESSAGES.unreachable(args.error ?? "Zugriff verweigert"),
      link,
      dedupeKey: "inbox_unreachable",
    });
  } else if (h.alert === "failed_runs" || (args.staleCount ?? 0) > 0) {
    const n = Math.max(args.staleCount ?? 0, args.objectsWaiting ?? 0, 1);
    const since = new Intl.DateTimeFormat("de-DE", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "Europe/Berlin",
    }).format(args.oldestStaleAt ?? config.health.lastSuccessAt ?? now);
    await upsertNotification(ctx, {
      kind: "inbox_stale",
      severity: "warning",
      title: INBOX_MAIL_MESSAGES.staleObjects(n, since),
      link,
      dedupeKey: "inbox_stale",
    });
  }
  return { paused: health.pausedAt !== undefined };
}

// ── Claude OCR (SET-111…113) ─────────────────────────────────────────────────────────────────────────────

export interface ClaudeConfig extends ClaudeSettings {
  usage?: { month: string; calls: number };
}

export function claudeConfigOf(row: Doc<"integrations"> | null): ClaudeConfig {
  const c = (row?.config ?? {}) as Partial<ClaudeConfig>;
  return {
    model: c.model || CLAUDE_DEFAULTS.model,
    region: (c.region as ClaudeRegion) ?? CLAUDE_DEFAULTS.region,
    pageLimit: c.pageLimit ?? CLAUDE_DEFAULTS.pageLimit,
    ...(c.endpoint ? { endpoint: c.endpoint } : {}),
    ...(c.monthlyBudget ? { monthlyBudget: c.monthlyBudget } : {}),
    ...(c.usage ? { usage: c.usage } : {}),
  };
}

/** Is OCR usable right now (enabled, AVV confirmed, key stored)? EC-INB-16. */
export const ocrActive = (row: Doc<"integrations"> | null): boolean =>
  Boolean(row?.enabled && row.dpaConfirmedAt !== undefined && row.encryptedSecrets);

export async function saveClaudeSettings(
  ctx: ModelCtx,
  args: {
    enabled: boolean;
    dpaConfirmed: boolean;
    endpoint?: string;
    model?: string;
    region: ClaudeRegion;
    pageLimit?: number;
    monthlyBudget?: number;
    apiKey?: string;
  },
): Promise<{ warnings: { code: string; message: string }[]; released: number }> {
  const row = await getIntegration(ctx, "claude");
  const endpoint = args.endpoint?.trim() || undefined;
  const check = checkClaudeSettings({
    enabled: args.enabled,
    dpaConfirmed: args.dpaConfirmed,
    region: args.region,
    ...(endpoint ? { endpoint } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.pageLimit !== undefined ? { pageLimit: args.pageLimit } : {}),
    ...(args.monthlyBudget !== undefined ? { monthlyBudget: args.monthlyBudget } : {}),
  });
  const first = check.errors[0];
  if (first) throw appError("invalid_input", first.message, { reason: first.code });
  const apiKey = args.apiKey?.trim();
  if (args.enabled && !apiKey && !row?.encryptedSecrets) {
    throw appError("invalid_input", "Bitte einen API-Schlüssel hinterlegen.", { reason: "API_KEY_REQUIRED" });
  }
  const current = claudeConfigOf(row);
  const config: ClaudeConfig = {
    model: args.model?.trim() || CLAUDE_DEFAULTS.model,
    region: args.region,
    pageLimit: args.pageLimit ?? current.pageLimit,
    ...(endpoint ? { endpoint } : {}),
    ...(args.monthlyBudget ? { monthlyBudget: args.monthlyBudget } : {}),
    ...(current.usage ? { usage: current.usage } : {}),
  };
  const fields = {
    config: JSON.parse(JSON.stringify(config)) as Record<string, unknown>,
    enabled: args.enabled,
    region: args.region,
    ...(apiKey ? { encryptedSecrets: await encryptSecret(apiKey) } : {}),
    ...(args.dpaConfirmed ? { dpaConfirmedAt: row?.dpaConfirmedAt ?? ctx.now() } : { dpaConfirmedAt: undefined }),
  };
  if (row) {
    await auditedPatch(ctx, "integrations", row._id, fields, {
      action: "settings.integrations.update",
      label: "claude",
    });
  } else {
    await auditedInsert(
      ctx,
      "integrations",
      { kind: "claude", ...fields },
      { action: "settings.integrations.update", label: "claude" },
    );
  }
  // SET-113: switching off takes effect now — waiting items get their manual draft.
  const released = args.enabled ? 0 : await releaseOcrPending(ctx, OCR_MESSAGES.disabled);
  return { warnings: check.warnings, released };
}

/** INB-025 monthly budget: one more call in the current month (Europe/Berlin). */
export async function recordOcrCall(ctx: ModelCtx): Promise<void> {
  const row = await getIntegration(ctx, "claude");
  if (!row) return;
  const config = claudeConfigOf(row);
  const usage = nextUsage(config.usage, berlinCalendarDate(ctx.now()));
  await auditedPatch(
    ctx,
    "integrations",
    row._id,
    { config: JSON.parse(JSON.stringify({ ...config, usage })) as Record<string, unknown> },
    { action: "inbox.ocr_call", label: "claude" },
  );
}

export async function claudeRow(ctx: ReadCtx) {
  return getIntegration(ctx, "claude");
}
