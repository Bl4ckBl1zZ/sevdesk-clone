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
  // F07: archived statement files and Eigenbelege are Buchungsbelege (GOBD-20, retention vouchers8).
  for (const s of await ctx.db.query("bankStatements").collect()) {
    const files = [s.pdf, s.camt, ...(s.other ?? [])];
    if (files.some((f) => f?.storageId === storageId)) refs.push(`bankStatements ${String(s._id)}`);
  }
  for (const i of await ctx.db.query("bankImports").collect()) {
    if (i.fileStorageId === storageId) refs.push(`bankImports ${String(i._id)}`);
  }
  for (const c of await ctx.db.query("cashTransfers").collect()) {
    if (c.eigenbelegFile?.storageId === storageId) refs.push(`cashTransfers ${String(c._id)}`);
  }
  // F04 DOC-18 / INV-30: document attachments and proofs are part of the (retained) document.
  for (const d of await ctx.db.query("salesDocuments").collect()) {
    const files = [...(d.attachments ?? []).map((a) => a.file), ...(d.evidence ?? []).map((e) => e.file)];
    if (files.some((f) => f.storageId === storageId)) refs.push(`salesDocuments ${d.number ?? String(d._id)}`);
  }
  for (const e of await ctx.db.query("journalEntries").collect()) {
    if (e.attachments?.some((f) => f.storageId === storageId)) refs.push(`journalEntries ${e.seq}`);
  }
  // F09 IMP-003/IMP-024: archived original PDFs and the source files of a committed import (migration evidence).
  for (const a of await ctx.db.query("documentArtifacts").collect()) {
    if (a.storageId === storageId) refs.push(`documentArtifacts ${String(a._id)}`);
  }
  for (const i of await ctx.db.query("imports").collect()) {
    if (i.status !== "discarded" && i.files.some((f) => f.storageId === storageId))
      refs.push(`imports ${String(i._id)}`);
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

/** SET-020: drafts that pick up a company-profile change on their next render (all sales-document drafts). */
export async function countDraftsUsingCompanyData(ctx: ReadCtx): Promise<number> {
  return (await ctx.db.query("salesDocuments").collect()).filter((d) => d.status === "draft").length;
}
