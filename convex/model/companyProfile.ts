import { canonicalize } from "../../src/domain/audit/canonical";
import { changedFields } from "../../src/domain/audit/immutability";
import { newCompanyProfile } from "../../src/domain/settings/profile";
import type { Doc } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { appendAudit } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";
import { emitSettingsEvent } from "./webhooks";

/**
 * `companyProfile` singleton (03 §1, F01 SET-010, SET-140/141). Every change increments `version`, writes an
 * audit entry with the diff and appends the full state at the new version to `companyProfileVersions` 🔒.
 */
export type CompanyProfile = Doc<"companyProfile">;
type ProfileFields = Omit<CompanyProfile, "_id" | "_creationTime" | "version">;

export async function getCompanyProfile(ctx: ReadCtx): Promise<CompanyProfile | null> {
  return ctx.db.query("companyProfile").first();
}

export interface ProfileWrite {
  /** Audit action, e.g. `settings.company.update` (F12 §4.1 `settings.<section>.update`). */
  action: string;
  reason?: string;
  /** SET-141 optimistic concurrency: the version the client loaded. */
  expectedVersion?: number;
}

const strip = (doc: Record<string, unknown>) => {
  const { _id, _creationTime, ...rest } = doc;
  return rest;
};

/**
 * Applies `patch` to the singleton (creating it with neutral defaults on the first save, SET-003). `undefined`
 * values remove optional fields. A no-op patch writes nothing. Returns the new version.
 */
export async function patchCompanyProfile(
  ctx: ModelCtx,
  patch: Partial<ProfileFields>,
  write: ProfileWrite,
): Promise<number> {
  const existing = await getCompanyProfile(ctx);
  if (write.expectedVersion !== undefined && (existing?.version ?? 0) !== write.expectedVersion) {
    throw appError("version_conflict");
  }
  if (!existing) {
    const value = { ...newCompanyProfile(), ...patch, version: 1 } as ProfileFields & { version: number };
    const clean = JSON.parse(JSON.stringify(value)) as typeof value; // drop undefined members
    const id = await ctx.db.insert("companyProfile", clean);
    const entry = await appendAudit(ctx, {
      action: write.action,
      entity: { table: "companyProfile", id, label: clean.name || "Unternehmen" },
      diff: { after: clean },
      ...(write.reason ? { reason: write.reason } : {}),
    });
    await ctx.db.insert("companyProfileVersions", {
      version: 1,
      profile: canonicalize(clean),
      diff: { after: clean },
      validFrom: ctx.now(),
      actor: ctx.actor,
      ...(write.reason ? { reason: write.reason } : {}),
      auditSeq: entry.seq,
    });
    const created = SETTINGS_EVENT[write.action];
    if (created) await emitSettingsEvent(ctx, created, Object.keys(patch));
    return 1;
  }

  const before = existing as unknown as Record<string, unknown>;
  if (changedFields(before, { op: "patch", patch: patch as Record<string, unknown> }).size === 0) {
    return existing.version;
  }
  const version = existing.version + 1;
  // The audited diff includes the version bump so replaying the log reproduces the record (RI-15).
  const changed = changedFields(before, { op: "patch", patch: { ...patch, version } as Record<string, unknown> });
  await ctx.db.patch("companyProfile", existing._id, { ...patch, version } as never);
  const diff = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
  for (const [field, [from, to]] of changed) {
    diff.before[field] = from;
    diff.after[field] = to;
  }
  const entry = await appendAudit(ctx, {
    action: write.action,
    entity: { table: "companyProfile", id: existing._id, label: existing.name || "Unternehmen" },
    diff,
    ...(write.reason ? { reason: write.reason } : {}),
  });
  const after = (await ctx.db.get(existing._id)) as Record<string, unknown>;
  await ctx.db.insert("companyProfileVersions", {
    version,
    profile: canonicalize(strip(after)),
    diff,
    validFrom: ctx.now(),
    actor: ctx.actor,
    ...(write.reason ? { reason: write.reason } : {}),
    auditSeq: entry.seq,
  });
  // F01 §7.1: settings.company.updated / settings.tax.updated (field names only)
  const event = SETTINGS_EVENT[write.action];
  if (event) await emitSettingsEvent(ctx, event, Object.keys(diff.after));
  return version;
}

const SETTINGS_EVENT: Record<string, "settings.company.updated" | "settings.tax.updated"> = {
  "settings.company.update": "settings.company.updated",
  "settings.logo.update": "settings.company.updated",
  "settings.tax.update": "settings.tax.updated",
};
