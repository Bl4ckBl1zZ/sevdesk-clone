/**
 * Audit viewer and export rules (F12 AUD-006…009). Pure: `now` passed in.
 *
 * - Filters: period, actor type, specific actor, channel, action (exact or group prefix), entity table/ID, text.
 * - Presets (AUD-006) map to filters; „Was hat Claude heute geändert?" = actor type mcp since 00:00 Europe/Berlin.
 * - Actor badges: „Du" (the viewer), name + role, „API „{key}"", „Claude (MCP)", „Prüfer", „System".
 * - Export (AUD-008): CSV/JSON including seq, prevHash and hash, so a third party can re-verify the segment against a
 *   checkpoint with the chain rule in ./chain (sha256(prevHash + canonical(entry without hash))).
 */
import { ROLE_LABEL_DE } from "../access/permissions";
import { writeCsv } from "../csv/csv";
import type { MemberRole } from "../schemas/actor";
import { berlinCalendarDate, berlinStartOfDay } from "../time/berlin";

export const ACTOR_KINDS = ["user", "api-key", "mcp", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface AuditFilter {
  from?: number | undefined;
  to?: number | undefined;
  actorKind?: ActorKind | undefined;
  actor?: string | undefined;
  /** "user" members with role auditor (preset „Prüferzugriffe"). */
  actorRole?: MemberRole | undefined;
  channel?: string | undefined;
  /** Exact actions or group prefixes ending with "." (e.g. "settings."). */
  actions?: readonly string[] | undefined;
  entityTable?: string | undefined;
  entityId?: string | undefined;
  text?: string | undefined;
}

export const AUDIT_PRESETS = [
  "claude_today",
  "api_key",
  "settings",
  "locks",
  "exports_imports",
  "deleted_drafts",
  "auditor_access",
  "integrity",
] as const;
export type AuditPreset = (typeof AUDIT_PRESETS)[number];

export const PRESET_LABEL_DE: Readonly<Record<AuditPreset, string>> = {
  claude_today: "Was hat Claude heute geändert?",
  api_key: "API-Schlüssel",
  settings: "Einstellungsänderungen",
  locks: "Festschreibungen",
  exports_imports: "Exporte & Importe",
  deleted_drafts: "Gelöschte Entwürfe",
  auditor_access: "Prüferzugriffe",
  integrity: "Integrität",
};

/** AUD-006 presets → filter. `apiKeyActor` selects the key for „API-Schlüssel {name}". */
export function presetFilter(preset: AuditPreset, now: number, apiKeyActor?: string): AuditFilter {
  switch (preset) {
    case "claude_today":
      return { actorKind: "mcp", from: berlinStartOfDay(berlinCalendarDate(now)), to: now };
    case "api_key":
      return apiKeyActor ? { actor: apiKeyActor } : { actorKind: "api-key" };
    case "settings":
      return { actions: ["settings.", "rule_override.", "webhook.", "api_key.", "member.", "invite."] };
    case "locks":
      return { actions: ["period.lock", "tax_filing.submit", "export.datev"] };
    case "exports_imports":
      return { actions: ["export.", "import.commit", "import.finish", "document.export"] };
    case "deleted_drafts":
      return { actions: ["document.delete_draft"] };
    case "auditor_access":
      return { actions: ["auditor.access"] };
    case "integrity":
      return { actions: ["integrity.", "system.startup", "system.restore", "security."] };
  }
}

export interface AuditRow {
  seq: number;
  at: number;
  actor: string;
  actorRole?: string | undefined;
  actorLabel?: string | undefined;
  channel: string;
  requestId?: string | undefined;
  action: string;
  entity: { table: string; id: string; label?: string | undefined };
  reason?: string | undefined;
}

export const actorKindOf = (actor: string): string => actor.slice(0, Math.max(0, actor.indexOf(":")));

const matchesAction = (action: string, patterns: readonly string[]) =>
  patterns.some((p) => (p.endsWith(".") ? action.startsWith(p) : action === p));

export function matchesFilter(row: AuditRow, f: AuditFilter): boolean {
  if (f.from !== undefined && row.at < f.from) return false;
  if (f.to !== undefined && row.at > f.to) return false;
  if (f.actorKind && actorKindOf(row.actor) !== f.actorKind) return false;
  if (f.actor && row.actor !== f.actor) return false;
  if (f.actorRole && row.actorRole !== f.actorRole) return false;
  if (f.channel && row.channel !== f.channel) return false;
  if (f.actions && f.actions.length > 0 && !matchesAction(row.action, f.actions)) return false;
  if (f.entityTable && row.entity.table !== f.entityTable) return false;
  if (f.entityId && row.entity.id !== f.entityId) return false;
  if (f.text) {
    const q = f.text.trim().toLocaleLowerCase("de-DE");
    const hay = [row.action, row.entity.label, row.entity.id, row.reason, row.actorLabel]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("de-DE");
    if (q && !hay.includes(q)) return false;
  }
  return true;
}

/** Merges a preset with explicit filter fields (explicit fields win). */
export function combineFilters(base: AuditFilter, extra: AuditFilter): AuditFilter {
  const out: AuditFilter = { ...base };
  for (const [k, v] of Object.entries(extra) as [keyof AuditFilter, unknown][]) {
    if (v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * AUD-006 actor badge. `viewerActor` is the signed-in member (shown as „Du"); `keyName` is the API/MCP key name
 * resolved by the caller.
 */
export function actorBadge(
  row: { actor: string; actorRole?: string | undefined; actorLabel?: string | undefined },
  opts: { viewerActor?: string | undefined; keyName?: string | undefined } = {},
): { kind: string; label: string } {
  const kind = actorKindOf(row.actor);
  if (kind === "user") {
    if (row.actor === opts.viewerActor) return { kind, label: "Du" };
    if (row.actorRole === "auditor") return { kind: "auditor", label: "Prüfer" };
    const role = row.actorRole && row.actorRole in ROLE_LABEL_DE ? ROLE_LABEL_DE[row.actorRole as MemberRole] : "";
    const name = row.actorLabel ?? "Benutzer";
    return { kind, label: role ? `${name} (${role})` : name };
  }
  if (kind === "api-key") return { kind, label: `API „${opts.keyName ?? row.actorLabel ?? row.actor.slice(8)}“` };
  if (kind === "mcp") return { kind, label: "Claude (MCP)" };
  return { kind: "system", label: "System" };
}

/** „verifiziert bis seq {n} am {datum}" — the chain status shown per entry (AUD-006). */
export function chainStatus(
  seq: number,
  lastRun: { lastVerifiedSeq: number; at: number; ok: boolean } | null,
): { verified: boolean; text: string } {
  if (!lastRun) return { verified: false, text: "Noch nicht geprüft" };
  const date = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "Europe/Berlin" }).format(lastRun.at);
  const text = `verifiziert bis seq ${lastRun.lastVerifiedSeq} am ${date}`;
  return {
    verified: seq <= lastRun.lastVerifiedSeq,
    text: seq <= lastRun.lastVerifiedSeq ? text : `Noch nicht geprüft (${text})`,
  };
}

/** AUD-008 export columns; `diff` and `client` are serialised as canonical JSON in the CSV. */
export const AUDIT_EXPORT_COLUMNS = [
  "seq",
  "at",
  "actor",
  "actorRole",
  "actorLabel",
  "channel",
  "requestId",
  "action",
  "entityTable",
  "entityId",
  "entityLabel",
  "reason",
  "diff",
  "prevHash",
  "hash",
] as const;

export interface ExportEntry extends AuditRow {
  prevHash: string;
  hash: string;
  diff?: unknown;
  [field: string]: unknown;
}

export function auditCsv(entries: readonly ExportEntry[]): string {
  return writeCsv(
    AUDIT_EXPORT_COLUMNS,
    entries.map((e) => [
      e.seq,
      new Date(e.at).toISOString(),
      e.actor,
      e.actorRole,
      e.actorLabel,
      e.channel,
      e.requestId,
      e.action,
      e.entity.table,
      e.entity.id,
      e.entity.label,
      e.reason,
      e.diff === undefined ? "" : JSON.stringify(e.diff),
      e.prevHash,
      e.hash,
    ]),
  );
}

/**
 * AUD-008 JSON export: the stored entries exactly as hashed (without Convex system fields), so
 * `verifyChainPage(entries, { nextSeq: first.seq, prevHash: first.prevHash })` re-verifies the segment and the last
 * hash can be compared with a checkpoint's `lastHash`.
 */
export function auditJson(
  entries: readonly Record<string, unknown>[],
  meta: { instance: string; exportedAt: number; filter: AuditFilter },
): string {
  const clean = entries.map(({ _id, _creationTime, ...rest }) => rest);
  return JSON.stringify(
    {
      format: "rechnungen-audit-export/1",
      instance: meta.instance,
      exportedAt: new Date(meta.exportedAt).toISOString(),
      filter: meta.filter,
      hashRule: "sha256(prevHash + canonicalJson(entry without hash))",
      entries: clean,
    },
    null,
    2,
  );
}
