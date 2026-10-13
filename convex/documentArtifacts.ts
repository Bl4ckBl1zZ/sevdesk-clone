"use node";

import { v } from "convex/values";
import {
  checkArtifactsReady,
  checkOriginalReexport,
  type ExportEntry,
  exportFileName,
  exportFiles as exportFileSpecs,
  zipFileName,
} from "../src/domain/documents/dispatch";
import { DEFAULT_LAYOUT, type RenderLayout } from "../src/domain/documents/render-model";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import { exportRequestSchema } from "../src/domain/schemas/documents";
import { readEmbeddedFiles } from "../src/pdf/embedded-files";
import { renderArtifacts } from "../src/pdf/render-artifacts";
import type { PdfLogo } from "../src/pdf/sales-document";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, systemAction } from "./functions";
import { validatePdf, validateXml } from "./lib/einvoiceTools";
import { appError } from "./lib/errors";
import { parse } from "./lib/parse";

/**
 * Step 3 of the pipeline (02 §6, F04 DOC-28/INV-21) and the export (SND-05/16/22, DOC-32) — Node actions because
 * react-pdf and pdf-lib render the PDF/A-3b. Files go to Convex file storage; the archive rows (sha256) are written
 * by the mutations in convex/invoices.ts.
 */

const MIME = { pdf: "application/pdf", xml: "application/xml" } as const;

function layoutOf(config: unknown): RenderLayout {
  if (!config || typeof config !== "object") return DEFAULT_LAYOUT;
  const c = config as RenderLayout & { printOptions: Record<string, unknown> };
  const { portalQr: _p, ...printOptions } = c.printOptions as Record<string, unknown>;
  return {
    template: c.template,
    accentColor: c.accentColor,
    font: c.font,
    logoPosition: c.logoPosition,
    printOptions: { ...DEFAULT_LAYOUT.printOptions, ...(printOptions as Partial<RenderLayout["printOptions"]>) },
  };
}

async function loadLogo(ctx: ActionCtx, storageId: Id<"_storage"> | null): Promise<PdfLogo | null> {
  if (!storageId) return null;
  const blob = await ctx.storage.get(storageId);
  if (!blob) return null;
  const data = new Uint8Array(await blob.arrayBuffer());
  if (data[0] === 0x89 && data[1] === 0x50) return { data, format: "png" };
  if (data[0] === 0xff && data[1] === 0xd8) return { data, format: "jpg" };
  return null; // SVG logos are not supported by react-pdf (F01 SET-070)
}

async function store(ctx: ActionCtx, bytes: Uint8Array, mime: string): Promise<Id<"_storage">> {
  return ctx.storage.store(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
}

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** renderArtifacts: PDF/A-3b, final XML, embed/separate, validate, archive with sha256 → `ready` (or retry). */
export const render = systemAction({
  job: "documents.pipeline",
  args: { id: v.id("salesDocuments") },
  handler: async (ctx, { id }) => {
    const input = await ctx.runQuery(internal.invoices.renderInput, { id });
    if (input.status === "draft" || !input.snapshotJson || input.artifactStatus !== "pending" || input.hasArtifacts)
      return;
    try {
      const snapshot = JSON.parse(input.snapshotJson) as DocumentSnapshot;
      const createdAt = new Date(input.finalizedAt ?? Date.now());
      const r = await renderArtifacts(snapshot, layoutOf(input.layoutConfig), "original", {
        logo: await loadLogo(ctx, input.logoStorageId),
        createdAt,
      });
      const files: {
        kind: "pdf" | "zugferd_pdf" | "xrechnung_xml" | "validation_report_kosit" | "validation_report_mustang";
        variant?: "original" | "reading";
        bytes: Uint8Array;
        sha256: string;
        mime: string;
        name: string;
        tool?: { name: string; version: string };
      }[] = [];
      if (r.kind === "zugferd_pdf" && r.xml && r.xmlSha256) {
        // INV-21: the XML extracted from the hybrid PDF must be byte-equal to the archived XML.
        const embedded = (await readEmbeddedFiles(r.pdf)).find((f) => f.name === r.einvoice?.embeddedFileName);
        if (!embedded || !equalBytes(embedded.bytes, r.xml)) throw new Error("INV-21: eingebettete XML weicht ab");
        files.push({
          kind: "zugferd_pdf",
          variant: "original",
          bytes: r.pdf,
          sha256: r.pdfSha256,
          mime: MIME.pdf,
          name: r.fileNames.pdf,
        });
        files.push({
          kind: "xrechnung_xml",
          bytes: r.xml,
          sha256: r.xmlSha256,
          mime: MIME.xml,
          name: r.fileNames.xml ?? "",
        });
      } else if (r.kind === "xrechnung_xml" && r.xml && r.xmlSha256) {
        files.push({
          kind: "xrechnung_xml",
          bytes: r.xml,
          sha256: r.xmlSha256,
          mime: MIME.xml,
          name: r.fileNames.xml ?? "",
        });
        files.push({
          kind: "pdf",
          variant: "reading",
          bytes: r.pdf,
          sha256: r.pdfSha256,
          mime: MIME.pdf,
          name: r.fileNames.pdf,
        });
      } else {
        files.push({
          kind: "pdf",
          variant: "original",
          bytes: r.pdf,
          sha256: r.pdfSha256,
          mime: MIME.pdf,
          name: r.fileNames.pdf,
        });
      }
      // ER-12: the final XML and the hybrid PDF are validated again after the commit; reports are archived.
      if (r.xml) {
        const xmlCheck = await validateXml(new TextDecoder().decode(r.xml));
        if (xmlCheck.kind === "failed")
          throw new Error(`KoSIT: ${xmlCheck.errors[0]?.ruleId ?? "?"} ${xmlCheck.errors[0]?.text ?? ""}`);
        if (xmlCheck.kind === "unavailable") throw new Error(`KoSIT nicht erreichbar: ${xmlCheck.detail}`);
        if (xmlCheck.kind === "passed") {
          const bytes = new TextEncoder().encode(xmlCheck.report);
          files.push({
            kind: "validation_report_kosit",
            bytes,
            sha256: await sha256Hex(bytes),
            mime: "application/json",
            name: "kosit-report.json",
            tool: xmlCheck.tool,
          });
        }
      }
      if (r.kind === "zugferd_pdf") {
        const pdfCheck = await validatePdf(r.pdf);
        if (pdfCheck.kind === "failed")
          throw new Error(`Mustang: ${pdfCheck.errors[0]?.ruleId ?? "?"} ${pdfCheck.errors[0]?.text ?? ""}`);
        if (pdfCheck.kind === "unavailable") throw new Error(`Mustang nicht erreichbar: ${pdfCheck.detail}`);
        if (pdfCheck.kind === "passed") {
          const bytes = new TextEncoder().encode(pdfCheck.report);
          files.push({
            kind: "validation_report_mustang",
            bytes,
            sha256: await sha256Hex(bytes),
            mime: "application/json",
            name: "mustang-report.json",
            tool: pdfCheck.tool,
          });
        }
      }
      const artifacts = [];
      for (const f of files) {
        artifacts.push({
          kind: f.kind,
          ...(f.variant ? { variant: f.variant } : {}),
          storageId: await store(ctx, f.bytes, f.mime),
          sha256: f.sha256,
          bytes: f.bytes.length,
          mime: f.mime,
          name: f.name,
          ...(f.tool ? { tool: f.tool } : {}),
        });
      }
      await ctx.runMutation(internal.invoices.storeArtifacts, { id, artifacts });
    } catch (e) {
      await ctx.runMutation(internal.invoices.artifactFailure, {
        id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ExportedFile {
  artifactId: Id<"documentArtifacts">;
  name: string;
  url: string;
  sha256: string;
  mime: string;
}

/**
 * „Exportieren“ (SND-16): serves archived bytes — originals while unmarked, the archived "Kopie" once marked
 * (rendered and archived on first use, DOC-32); „Original erneut exportieren“ needs a reason (SND-05, EC-099).
 * Writes the `document.export` audit entry (SND-22). The ZIP with SHA256SUMS.txt is assembled by the client from
 * exactly these files.
 */
export const exportFiles = action({
  permission: "documents.export",
  args: { id: v.id("salesDocuments"), request: v.any() },
  handler: async (ctx, { id, request }): Promise<{ files: ExportedFile[]; zipName: string | null }> => {
    const req = parse(exportRequestSchema, request);
    const input = await ctx.runQuery(internal.invoices.exportInput, { id });
    if (input.status === "draft" || !input.number)
      throw appError("document_not_draft", "Entwürfe können nicht exportiert werden.");
    const ready = checkArtifactsReady(input.artifactStatus ?? undefined);
    if (ready) throw appError(ready.code as "artifacts_not_ready" | "artifacts_blocked");
    const original = req.original === true;
    const reasonIssue = checkOriginalReexport(input.marked, original, req.reason);
    if (reasonIssue) throw appError("resend_original_reason");
    const copy = input.marked && !original;
    const specs = exportFileSpecs(input.format, req.entry as ExportEntry, copy);
    const files: ExportedFile[] = [];
    for (const spec of specs) {
      let a = input.artifacts.find((x) => x.kind === spec.kind && x.variant === spec.variant);
      if (!a && spec.variant === "copy") {
        const r = await ctx.runQuery(internal.invoices.renderInput, { id });
        if (!r.snapshotJson) throw appError("artifacts_not_ready");
        const rendered = await renderArtifacts(
          JSON.parse(r.snapshotJson) as DocumentSnapshot,
          layoutOf(r.layoutConfig),
          "copy",
          {
            logo: await loadLogo(ctx, r.logoStorageId),
            createdAt: new Date(r.finalizedAt ?? Date.now()),
          },
        );
        const name = exportFileName(input.number, spec);
        const storageId = await store(ctx, rendered.pdf, MIME.pdf);
        const artifactId = await ctx.runMutation(internal.invoices.storeVariant, {
          actorContext: ctx.actorContext,
          id,
          artifact: {
            kind: spec.kind,
            variant: "copy",
            storageId,
            sha256: rendered.pdfSha256,
            bytes: rendered.pdf.length,
            mime: MIME.pdf,
            name,
          },
        });
        if (!artifactId) throw appError("artifacts_not_ready");
        a = {
          _id: artifactId,
          kind: spec.kind,
          variant: "copy",
          name,
          sha256: rendered.pdfSha256,
          mime: MIME.pdf,
          storageId,
        };
      }
      if (!a) throw appError("artifacts_not_ready");
      const url = await ctx.storage.getUrl(a.storageId);
      if (!url) throw appError("artifacts_not_ready");
      files.push({ artifactId: a._id, name: exportFileName(input.number, spec), url, sha256: a.sha256, mime: a.mime });
    }
    await ctx.runMutation(internal.invoices.recordExportEntry, {
      actorContext: ctx.actorContext,
      id,
      artifactIds: files.map((f) => f.artifactId),
      entry: req.entry,
      original,
      ...(req.reason ? { reason: req.reason } : {}),
    });
    return { files, zipName: req.entry === "zip" ? zipFileName(input.number) : null };
  },
});
