import { SALES_DOC_TYPES, setDefaultLayout } from "../../src/domain/documents/layout";
import { layoutDiffSummary, sameLayoutConfig } from "../../src/domain/documents/layout-history";
import type { LayoutValues } from "../../src/domain/schemas/settings";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { appendAudit, auditedInsert, auditedPatch } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Layouts with immutable versions (03 §1, F01 SET-070/071, §4.4). Each save inserts `layoutVersions{n+1}` 🔒 and
 * moves `layouts.currentVersionId`; drafts render the current version, finalised documents keep theirs.
 */
type LayoutConfig = Doc<"layoutVersions">["config"];

const DEFAULT_CONFIG: LayoutConfig = {
  template: "classic",
  accentColor: "#16a34a",
  font: "inter",
  logoPosition: "left",
  printOptions: {
    foldMarks: true,
    pageNumbers: true,
    senderLine: true,
    vatPerLine: false,
    productNumbers: false,
    epcQr: true,
    portalQr: false,
    lineDescriptions: true,
    grossLineTotals: false,
    allInvoiceAccountsInFooter: false,
    footerInLetterhead: null,
  },
};

export async function defaultLayout(
  ctx: ReadCtx,
): Promise<{ layout: Doc<"layouts">; version: Doc<"layoutVersions"> | null } | null> {
  const layout = (await ctx.db.query("layouts").collect()).find((l) => l.isDefaultFor.includes("invoice"));
  if (!layout) return null;
  const version = layout.currentVersionId ? await ctx.db.get(layout.currentVersionId) : null;
  return { layout, version };
}

/**
 * DOC-54 / SET-074: the layout a document renders with — the draft's own choice, else the default layout of its type,
 * else the invoice default. Its current version is frozen in the snapshot (`layoutVersionId`).
 */
export async function layoutForDocument(
  ctx: ReadCtx,
  doc: { type: string; layoutId?: Id<"layouts"> },
): Promise<{ layout: Doc<"layouts">; version: Doc<"layoutVersions"> | null } | null> {
  const layouts = await ctx.db.query("layouts").collect();
  const layout =
    (doc.layoutId ? layouts.find((l) => l._id === doc.layoutId) : undefined) ??
    layouts.find((l) => l.isDefaultFor.includes(doc.type as Doc<"layouts">["isDefaultFor"][number])) ??
    layouts.find((l) => l.isDefaultFor.includes("invoice"));
  if (!layout) return null;
  return { layout, version: layout.currentVersionId ? await ctx.db.get(layout.currentVersionId) : null };
}

export async function countLayouts(ctx: ReadCtx): Promise<number> {
  return (await ctx.db.query("layouts").collect()).length;
}

/** Saves template and accent colour of the default layout as a new version. */
export async function saveDefaultLayout(ctx: ModelCtx, values: LayoutValues): Promise<void> {
  const current = await defaultLayout(ctx);
  const previous = current?.version?.config ?? DEFAULT_CONFIG;
  const config: LayoutConfig = { ...previous, template: values.template, accentColor: values.accentColor };
  if (current?.version && previous.template === values.template && previous.accentColor === values.accentColor) {
    return; // unchanged: no new version
  }
  const layoutId =
    current?.layout._id ??
    (await auditedInsert(
      ctx,
      "layouts",
      { name: "Standard", isDefaultFor: [...SALES_DOC_TYPES] },
      { action: "settings.layout.create", label: "Standard" },
    ));
  const version = (current?.version?.version ?? 0) + 1;
  const versionId = await auditedInsert(
    ctx,
    "layoutVersions",
    { layoutId, version, config, createdAt: ctx.now() },
    { action: "settings.layout.update", label: `Standard v${version}` },
  );
  const before = current?.layout.currentVersionId;
  await ctx.db.patch("layouts", layoutId, { currentVersionId: versionId });
  await appendAudit(ctx, {
    action: "settings.layout.update",
    entity: { table: "layouts", id: layoutId, label: "Standard" },
    diff: { before: { currentVersionId: before }, after: { currentVersionId: versionId } },
  });
}

/**
 * F01 SET-071/072: sets or removes the letterhead of a layout (`first` = page 1 / both pages, `follow` = a separate
 * file for the later pages) as a new immutable version; old versions keep their files (SET-023, files.ts).
 */
export async function setLetterhead(
  ctx: ModelCtx,
  layoutId: Id<"layouts">,
  slot: "first" | "follow",
  storageId: Id<"_storage"> | null,
): Promise<Id<"layoutVersions">> {
  const layout = await ctx.db.get(layoutId);
  if (!layout) throw appError("not_found", "Layout nicht gefunden.");
  const current = layout.currentVersionId ? await ctx.db.get(layout.currentVersionId) : null;
  const previous = current?.config ?? DEFAULT_CONFIG;
  const key = slot === "first" ? "letterheadStorageId" : "letterheadPage2StorageId";
  if (slot === "follow" && storageId && !previous.letterheadStorageId) {
    throw appError("invalid_input", "Bitte zuerst das Briefpapier für die erste Seite hochladen.");
  }
  const { [key]: _old, ...rest } = previous;
  // Removing page 1 removes the follow-page file too (it is only a variant of the same letterhead).
  const { letterheadPage2StorageId: _follow, ...withoutFollow } = rest as LayoutConfig;
  const base = slot === "first" && !storageId ? withoutFollow : (rest as LayoutConfig);
  const config: LayoutConfig = { ...base, ...(storageId ? { [key]: storageId } : {}) };
  const version = (current?.version ?? 0) + 1;
  const versionId = await auditedInsert(
    ctx,
    "layoutVersions",
    { layoutId, version, config, createdAt: ctx.now() },
    { action: "settings.layout.update", label: `${layout.name} v${version}` },
  );
  await auditedPatch(
    ctx,
    "layouts",
    layoutId,
    { currentVersionId: versionId },
    {
      action: storageId ? "settings.letterhead.update" : "settings.letterhead.remove",
      label: layout.name,
    },
  );
  return versionId;
}

export async function listLayouts(ctx: ReadCtx): Promise<Doc<"layouts">[]> {
  return ctx.db.query("layouts").collect();
}

export async function currentVersion(ctx: ReadCtx, layout: Doc<"layouts">): Promise<Doc<"layoutVersions"> | null> {
  return layout.currentVersionId ? ctx.db.get(layout.currentVersionId) : null;
}

/** SET-070/074: a further layout (first version copied from the default layout's current config). */
export async function createLayout(ctx: ModelCtx, name: string): Promise<Id<"layouts">> {
  const base = (await defaultLayout(ctx))?.version?.config ?? DEFAULT_CONFIG;
  const layoutId = await auditedInsert(
    ctx,
    "layouts",
    { name, isDefaultFor: [] },
    { action: "settings.layout.create", label: name },
  );
  const versionId = await auditedInsert(
    ctx,
    "layoutVersions",
    { layoutId, version: 1, config: base, createdAt: ctx.now() },
    { action: "settings.layout.update", label: `${name} v1` },
  );
  await auditedPatch(
    ctx,
    "layouts",
    layoutId,
    { currentVersionId: versionId },
    { action: "settings.layout.update", label: name },
  );
  return layoutId;
}

/**
 * SET-074: `layoutId` becomes the default layout for `docTypes`; the types move away from every other layout so each
 * type keeps exactly one default. A draft may still choose another layout (`salesDocuments.layoutId`, P1).
 */
export async function setLayoutDefaults(ctx: ModelCtx, layoutId: Id<"layouts">, docTypes: string[]): Promise<void> {
  const layouts = await listLayouts(ctx);
  if (!layouts.some((l) => l._id === layoutId)) throw appError("not_found");
  const unknown = docTypes.find((t) => !(SALES_DOC_TYPES as readonly string[]).includes(t));
  if (unknown) throw appError("invalid_input", `Unbekannte Dokumentart ${unknown}.`);
  const next = setDefaultLayout(
    layouts.map((l) => ({ id: l._id as string, isDefaultFor: l.isDefaultFor })),
    layoutId,
    docTypes,
  );
  for (const l of layouts) {
    const updated = next.find((n) => n.id === l._id)?.isDefaultFor ?? l.isDefaultFor;
    if (updated.join() === l.isDefaultFor.join()) continue;
    await auditedPatch(
      ctx,
      "layouts",
      l._id,
      { isDefaultFor: updated as Doc<"layouts">["isDefaultFor"] },
      { action: "settings.layout.update", label: l.name },
    );
  }
}

// ── SET-076 version history ─────────────────────────────────────────────────────────────────────────────────────

/** All versions of a layout (newest first) with the diff summary and how many finalised documents use them. */
export async function layoutHistory(ctx: ReadCtx, layoutId: Id<"layouts">) {
  const layout = await ctx.db.get(layoutId);
  if (!layout) throw appError("not_found", "Layout nicht gefunden.");
  const versions = (
    await ctx.db
      .query("layoutVersions")
      .withIndex("by_layout_version", (q) => q.eq("layoutId", layoutId))
      .collect()
  ).sort((a, b) => a.version - b.version);
  const used = new Map<string, number>();
  for (const s of await ctx.db.query("documentSnapshots").collect()) {
    used.set(s.layoutVersionId, (used.get(s.layoutVersionId) ?? 0) + 1);
  }
  return {
    name: layout.name,
    versions: versions
      .map((v, i) => ({
        versionId: v._id,
        version: v.version,
        createdAt: v.createdAt,
        current: v._id === layout.currentVersionId,
        summary: layoutDiffSummary(i > 0 ? (versions[i - 1]?.config ?? null) : null, v.config),
        usedBy: used.get(v._id) ?? 0,
      }))
      .reverse(),
  };
}

/**
 * SET-076 „Diese Version wiederherstellen“: appends a new version with the old config and makes it current. Old
 * versions are never changed or deleted (GOBD-06).
 */
export async function restoreLayoutVersion(
  ctx: ModelCtx,
  layoutId: Id<"layouts">,
  versionId: Id<"layoutVersions">,
): Promise<{ version: number }> {
  const layout = await ctx.db.get(layoutId);
  const old = await ctx.db.get(versionId);
  if (!layout || old?.layoutId !== layoutId) throw appError("not_found", "Version nicht gefunden.");
  const current = await currentVersion(ctx, layout);
  if (current && sameLayoutConfig(current.config, old.config)) {
    throw appError("invalid_input", "Diese Version entspricht bereits der aktuellen Version.", {
      reason: "LAYOUT_VERSION_CURRENT",
    });
  }
  const latest = (
    await ctx.db
      .query("layoutVersions")
      .withIndex("by_layout_version", (q) => q.eq("layoutId", layoutId))
      .collect()
  ).reduce((m, v) => Math.max(m, v.version), 0);
  const version = latest + 1;
  const reason = `Wiederhergestellt aus Version ${old.version}`;
  const newId = await auditedInsert(
    ctx,
    "layoutVersions",
    { layoutId, version, config: old.config, createdAt: ctx.now() },
    { action: "settings.layout.update", label: `${layout.name} v${version}`, reason },
  );
  await auditedPatch(
    ctx,
    "layouts",
    layoutId,
    { currentVersionId: newId },
    { action: "settings.layout.update", label: layout.name, reason },
  );
  return { version };
}
