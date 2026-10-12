import type { Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { appendAudit } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Files referenced by settings snapshots (F01 SET-023, GOBD-06/GOBD-20): logos, letterheads and layout versions are
 * never deleted while anything references them. Replacing a logo stores a new file and keeps the old one; the only
 * deletion path is `deleteUnreferencedFile`, which refuses referenced files. From P1 `documentSnapshots` and
 * `documentArtifacts` are added to the reference check (with their retention dates, PRV-001).
 */
export async function fileReferences(ctx: ReadCtx, storageId: Id<"_storage">): Promise<string[]> {
  const refs: string[] = [];
  const profile = await getCompanyProfile(ctx);
  if (profile?.logoStorageId === storageId) refs.push("companyProfile.logoStorageId");
  for (const v of await ctx.db.query("companyProfileVersions").collect()) {
    if (v.profile.includes(storageId)) refs.push(`companyProfileVersions v${v.version}`);
  }
  for (const v of await ctx.db.query("layoutVersions").collect()) {
    const c = v.config;
    if (c.letterheadStorageId === storageId || c.letterheadPage2StorageId === storageId) {
      refs.push(`layoutVersions ${String(v.layoutId)} v${v.version}`);
    }
  }
  return refs;
}

export async function deleteUnreferencedFile(ctx: ModelCtx, storageId: Id<"_storage">): Promise<void> {
  const refs = await fileReferences(ctx, storageId);
  if (refs.length > 0) {
    throw appError(
      "immutable_record",
      "Die Datei wird von gespeicherten Einstellungen oder Dokumenten verwendet und bleibt erhalten (GoBD).",
      { reason: "FILE_REFERENCED", references: refs },
    );
  }
  await appendAudit(ctx, { action: "settings.file.delete", entity: { table: "_storage", id: storageId } });
  await ctx.storage.delete(storageId);
}

/**
 * SET-020: drafts that pick up a company-profile change on their next render. Sales documents (and with them drafts)
 * arrive in P1; until then no draft can exist, so the count is 0. P1 replaces this with a `salesDocuments.by_status`
 * count.
 */
export async function countDraftsUsingCompanyData(_ctx: ReadCtx): Promise<number> {
  return 0;
}
