import { SALES_DOC_TYPES, setDefaultLayout } from "../../src/domain/documents/layout";
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
