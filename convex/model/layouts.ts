import type { LayoutValues } from "../../src/domain/schemas/settings";
import type { Doc } from "../_generated/dataModel";
import { appendAudit, auditedInsert } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Layouts with immutable versions (03 §1, F01 SET-070/071, §4.4). Each save inserts `layoutVersions{n+1}` 🔒 and
 * moves `layouts.currentVersionId`; drafts render the current version, finalised documents keep theirs.
 */
const SALES_DOC_TYPES = [
  "quote",
  "order_confirmation",
  "delivery_note",
  "proforma",
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
  "cancellation",
  "correction",
  "reminder",
] as const;

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
