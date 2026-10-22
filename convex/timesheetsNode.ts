"use node";

import { v } from "convex/values";
import { buildTimesheet } from "../src/domain/projects/timesheet";
import { renderImportProtocol } from "../src/pdf/import-protocol";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { systemAction } from "./functions";

/**
 * F11 PRJ-014 Leistungsnachweis: renders the PDF/A-3b table of the billed (frozen) entries of a finalised invoice
 * with the generic section renderer and archives it as `documentArtifacts.kind = "timesheet_pdf"` (SHA-256, the
 * invoice's retention). Scheduled at finalisation when the invoice has „Leistungsnachweis anhängen“.
 *
 * LEGAL-OPEN: F11 §9 Q1 — embedding the timesheet in the XRechnung (BG-24) / ZUGFeRD attachment and attaching it to
 * the export bundle are not done (size limits and acceptance by the customer's systems are open; ⚠ legally
 * relevant). The artifact is archived and downloadable from the invoice.
 */
export const render = systemAction({
  job: "documents.pipeline",
  args: { documentId: v.id("salesDocuments") },
  handler: async (ctx, { documentId }): Promise<Id<"documentArtifacts"> | null> => {
    const input = await ctx.runQuery(internal.timeEntries.timesheetInput, { documentId });
    if (!input) return null;
    const model = buildTimesheet(input);
    const pdf = await renderImportProtocol(model);
    const digest = await crypto.subtle.digest("SHA-256", pdf as Uint8Array<ArrayBuffer>);
    const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    const storageId = await ctx.storage.store(new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
    return ctx.runMutation(internal.timeEntries.storeTimesheet, {
      documentId,
      storageId,
      sha256,
      bytes: pdf.length,
      name: model.fileName,
    });
  },
});
