import { POSTING_RULE_VERSION } from "../../src/domain/accounting/post";
import {
  buildVerfahrensdoku,
  outdatedMessage,
  releaseIssue,
  VD_CHAPTERS,
  type VdSources,
  verfahrensdokuMarkdown,
  watchDiff,
  watchSnapshot,
} from "../../src/domain/docs/verfahrensdoku";
import { lookupRoleMapping } from "../../src/domain/rules/accounting";
import { RECORD_RETENTION, RETENTION_RULE_VERSION, retentionUntilFor } from "../../src/domain/rules/retention";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { CalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc } from "../_generated/dataModel";
import { env } from "../lib/env";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import type { FileRefValue } from "./bankImport";
import { getCompanyProfile } from "./companyProfile";
import { notifyKind, resolveEntityNotifications } from "./notifications";
import { externalServices } from "./privacy";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Verfahrensdokumentation v1 (F12 AUD-024/025): sources from settings, owner inputs (`verfahrensdokuInputs`),
 * immutable released versions (`verfahrensdokuVersions` 🔒: Markdown file with SHA-256 in P1, PDF/A in P3) and the
 * watch list that marks the current version outdated (E-AUD-41, notification `verfahrensdoku.outdated`).
 */

const ROLE_DE: Record<string, string> = {
  processor: "Auftragsverarbeiter",
  controller: "eigener Verantwortlicher",
  public_authority: "Behörde",
};
const ENTITY = { table: "system", id: "verfahrensdoku" } as const;

const latest = <T extends { validFrom?: string; validFromFiscalYear?: number }>(rows: readonly T[] | undefined) =>
  rows?.at(-1);

export async function loadSources(ctx: ReadCtx, now: number, opts: { publicEdge?: boolean } = {}): Promise<VdSources> {
  const today = berlinCalendarDate(now);
  const p = await getCompanyProfile(ctx);
  const members = (await ctx.db.query("members").collect()).filter((m) => m.disabledAt === undefined);
  const keys = (await ctx.db.query("apiKeys").collect()).filter((k) => k.revokedAt === undefined);
  const ku = p?.kleinunternehmer.filter((k) => k.validFrom <= today).at(-1)?.isKU ?? false;
  const roleMapping = lookupRoleMapping(today as CalendarDate);
  const cp = await ctx.db.query("integrityCheckpoints").withIndex("by_at").order("desc").first();
  const drills = await ctx.db.query("restoreDrills").order("desc").take(3);
  const imports = (await ctx.db.query("imports").collect()).filter((i) => i.status === "done");
  const changes = (await ctx.db.query("auditLog").withIndex("by_seq").order("desc").take(400))
    .filter((a) => a.action.startsWith("settings.") || a.action.startsWith("member"))
    .slice(0, 50);
  const services = await externalServices(ctx, opts);
  const addr = p?.address;
  return {
    today,
    company: {
      name: p?.name ?? "Unternehmen",
      legalForm: p?.legalForm ?? "—",
      address: addr ? [addr.street, `${addr.postalCode} ${addr.city}`].filter(Boolean).join(", ") : "Anschrift fehlt",
      taxationMethod: latest(p?.taxationMethod)?.method ?? null,
      chart: latest(p?.chartOfAccounts)?.chart ?? null,
      kleinunternehmer: ku,
      profitMethod: latest(p?.profitMethod)?.method ?? null,
    },
    software: {
      appVersion: env("APP_VERSION") ?? "0.0.0",
      hosting: "eigener Server (Proxmox PVE) mit Dokploy, Datenbank Convex (selbst betrieben)",
      edge: opts.publicEdge
        ? "Cloudflare-Tunnel → Traefik → Caddy, Anmeldung und Rollenprüfung unverändert"
        : "nur im privaten Tailnet (Caddy, TLS)",
    },
    access: {
      members: members.map((m) => ({ role: m.role, expiresAt: m.expiresAt ?? null, totp: m.totpEnabled ?? false })),
      apiKeys: keys.map((k) => ({ name: k.name, scopes: k.scopes, kind: k.channel === "mcp" ? "mcp" : "api" })),
      tailnet: p?.accessConcept?.tailnetName ?? null,
    },
    numberRanges: (await ctx.db.query("numberRanges").collect()).map((r) => ({
      name: r.name,
      format: r.format,
      active: r.active,
    })),
    layoutsCount: (await ctx.db.query("layouts").collect()).length,
    bankAccounts: (await ctx.db.query("bankAccounts").collect())
      .filter((b) => b.archivedAt === undefined)
      .map((b) => ({ name: b.name, kind: b.kind, ledgerAccount: b.ledgerAccount })),
    hasCashTransfers: (await ctx.db.query("cashTransfers").first()) !== null,
    integrations: (await ctx.db.query("integrations").collect()).filter((i) => i.enabled).map((i) => i.kind),
    rules: {
      posting: POSTING_RULE_VERSION,
      roleMapping: roleMapping.ok ? roleMapping.value.value.version : null,
      retention: RETENTION_RULE_VERSION,
    },
    integrity: {
      checkpointKid: cp?.kid ?? null,
      lastCheckpoint: cp ? cp.date.split("-").reverse().join(".") : null,
      backupConfigured: Boolean(env("R2_BACKUP_BUCKET") && env("R2_BACKUP_READONLY_ACCESS_KEY_ID")),
    },
    restoreDrills: drills.map((d) => ({ date: d.date, kind: d.kind, integrityOk: d.integrityOk })),
    services: services.map((s) => ({
      name: s.name,
      role: ROLE_DE[s.role] ?? s.role,
      region: s.effectiveRegion,
      avvConfirmedAt: s.avvConfirmedAt,
    })),
    imports: imports.map((i) => ({
      source: i.source,
      at: i._creationTime,
      files: i.files.filter((x) => !x.ignored).map((x) => ({ name: x.name, sha256: x.sha256 })),
    })),
    changes: changes.map((a) => ({ at: a.at, action: a.action, label: a.entity.label ?? a.action })),
  };
}

export async function getInputs(ctx: ReadCtx): Promise<Record<string, string>> {
  return (await ctx.db.query("verfahrensdokuInputs").first())?.values ?? {};
}

const FIELD_KEYS = new Set(VD_CHAPTERS.flatMap((c) => c.fields.map((x) => x.key)));

/** AUD-024: structured owner inputs (only the known fields, ≤ 5 000 characters each). */
export async function saveInputs(ctx: ModelCtx, values: Record<string, string>): Promise<void> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!FIELD_KEYS.has(k)) throw appError("invalid_input", `Unbekanntes Feld „${k}“.`);
    const t = v.trim();
    if (t.length > 5_000) throw appError("invalid_input", "Höchstens 5.000 Zeichen je Angabe.", { field: k });
    if (t) clean[k] = t;
  }
  const row = await ctx.db.query("verfahrensdokuInputs").first();
  const meta = { action: "verfahrensdoku.update_inputs", label: "Verfahrensdokumentation" };
  if (row) await auditedPatch(ctx, "verfahrensdokuInputs", row._id, { values: clean, updatedAt: ctx.now() }, meta);
  else await auditedInsert(ctx, "verfahrensdokuInputs", { values: clean, updatedAt: ctx.now() }, meta);
}

export async function latestVersion(ctx: ReadCtx): Promise<Doc<"verfahrensdokuVersions"> | null> {
  return ctx.db.query("verfahrensdokuVersions").withIndex("by_version").order("desc").first();
}

export async function view(ctx: ReadCtx, now: number, opts: { publicEdge?: boolean } = {}) {
  const sources = await loadSources(ctx, now, opts);
  const inputs = await getInputs(ctx);
  const doc = buildVerfahrensdoku(sources, inputs);
  const versions = await ctx.db.query("verfahrensdokuVersions").withIndex("by_version").order("desc").collect();
  const current = versions[0] ?? null;
  const diff = current ? watchDiff(current.watchSnapshot, watchSnapshot(sources)) : [];
  return {
    doc,
    releaseIssue: releaseIssue(doc),
    versions: versions.map((v) => ({
      version: v.version,
      validFrom: v.validFrom,
      releasedAt: v.releasedAt,
      releasedBy: v.releasedBy,
      sha256: v.file.sha256,
      supersededAt: v.supersededAt ?? null,
    })),
    outdated: diff.length ? { diff, message: outdatedMessage(diff) } : null,
  };
}

/** Input of the release action: the Markdown to store plus the frozen sources (E-AUD-40 checked here and again). */
export async function releaseInput(ctx: ReadCtx, now: number, opts: { publicEdge?: boolean } = {}) {
  const sources = await loadSources(ctx, now, opts);
  const doc = buildVerfahrensdoku(sources, await getInputs(ctx));
  const issue = releaseIssue(doc);
  const version = ((await latestVersion(ctx))?.version ?? 0) + 1;
  const validFrom = berlinCalendarDate(now);
  return {
    issue,
    version,
    validFrom,
    markdown: verfahrensdokuMarkdown(doc, { company: sources.company.name, version, validFrom }),
    sourceJson: JSON.stringify({ sources, inputs: await getInputs(ctx) }),
    watch: watchSnapshot(sources),
  };
}

/** AUD-025: stores the released version (immutable) and supersedes the previous one (supersededAt + retention). */
export async function commitRelease(
  ctx: ModelCtx,
  r: { version: number; validFrom: string; sourceJson: string; watch: Record<string, string>; file: FileRefValue },
): Promise<number> {
  const prev = await latestVersion(ctx);
  if ((prev?.version ?? 0) + 1 !== r.version) {
    throw appError("version_conflict", "Es wurde zwischenzeitlich eine andere Version freigegeben.");
  }
  const doc = buildVerfahrensdoku((JSON.parse(r.sourceJson) as { sources: VdSources }).sources, await getInputs(ctx));
  const issue = releaseIssue(doc);
  if (issue) throw appError("invalid_input", issue, { reason: "VD_INCOMPLETE" });
  const today = berlinCalendarDate(ctx.now());
  if (prev) {
    const until = retentionUntilFor(RECORD_RETENTION.verfahrensdokuVersions ?? "books10", today);
    await auditedPatch(
      ctx,
      "verfahrensdokuVersions",
      prev._id,
      { supersededAt: ctx.now(), ...(until ? { retentionUntil: until } : {}) },
      { action: "verfahrensdoku.supersede", label: `Version ${prev.version}` },
    );
  }
  await auditedInsert(
    ctx,
    "verfahrensdokuVersions",
    {
      version: r.version,
      validFrom: r.validFrom,
      releasedAt: ctx.now(),
      releasedBy: ctx.actor,
      sourceJson: r.sourceJson,
      file: r.file,
      watchSnapshot: r.watch,
    },
    { action: "verfahrensdoku.release", label: `Version ${r.version}` },
  );
  await resolveEntityNotifications(ctx, ENTITY, "verfahrensdoku.outdated");
  return r.version;
}

/** E-AUD-41 (daily): a released version whose watch items changed → `verfahrensdoku.outdated`. */
export async function checkOutdated(ctx: ModelCtx): Promise<string | null> {
  const current = await latestVersion(ctx);
  if (!current) return null;
  const diff = watchDiff(current.watchSnapshot, watchSnapshot(await loadSources(ctx, ctx.now())));
  if (!diff.length) return null;
  const message = outdatedMessage(diff);
  await notifyKind(ctx, "verfahrensdoku.outdated", {
    title: message,
    link: "/einstellungen/verfahrensdokumentation",
    entity: ENTITY,
  });
  return message;
}

export async function versionUrl(
  ctx: ReadCtx & { storage: { getUrl: (id: never) => Promise<string | null> } },
  version: number,
) {
  const v = await ctx.db
    .query("verfahrensdokuVersions")
    .withIndex("by_version", (q) => q.eq("version", version))
    .first();
  if (!v) throw appError("not_found", "Diese Version gibt es nicht.");
  return { url: await ctx.storage.getUrl(v.file.storageId as never), name: v.file.name, sha256: v.file.sha256 };
}
