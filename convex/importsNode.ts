"use node";

import { v } from "convex/values";
import { sha256Hex } from "../src/domain/audit/chain";
import { unpackImportZip } from "../src/domain/import/sevdesk/archive";
import { buildImportProtocol } from "../src/domain/import/sevdesk/protocol";
import { renderImportProtocol } from "../src/pdf/import-protocol";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { systemAction } from "./functions";
import { describeImportFile, type NewImportFilePayload } from "./lib/importFiles";

/**
 * Node actions of the F09 sevdesk import (§4.3.4: unzip and rendering run in Node for memory and react-pdf). They
 * only compute and write file storage — never the database — and are called by the user's own actions in
 * convex/imports.ts, whose mutations record (and audit) the result with the user as actor.
 */

/**
 * IMP-016: unpacks an uploaded ZIP entry by entry (archive + one entry in memory), stores every contained file and
 * classifies it like a single upload. A rejected archive (E-IMP-29/39/40) leaves no stored entry behind.
 */
export const unpackZip = systemAction({
  job: "imports.files",
  args: { storageId: v.id("_storage"), name: v.string(), usedBytes: v.number() },
  handler: async (
    ctx,
    { storageId, name, usedBytes },
  ): Promise<
    | { ok: true; sha256: string; entries: NewImportFilePayload[]; ignored: string[]; files: number }
    | { ok: false; code: string; message: string }
  > => {
    const blob = await ctx.storage.get(storageId);
    if (!blob) return { ok: false, code: "not_found", message: `Die Datei ${name} wurde nicht gefunden.` };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const stored: Id<"_storage">[] = [];
    const entries: NewImportFilePayload[] = [];
    try {
      const r = await unpackImportZip(
        name,
        bytes,
        async (entry) => {
          const id = await ctx.storage.store(new Blob([entry.bytes as Uint8Array<ArrayBuffer>]));
          stored.push(id);
          entries.push(await describeImportFile(entry.path, entry.bytes, id));
        },
        { usedBytes },
      );
      if (!r.ok) {
        for (const id of stored) await ctx.storage.delete(id);
        return { ok: false, code: r.error.code, message: r.error.message };
      }
      return { ok: true, sha256: await sha256Hex(bytes), entries, ignored: r.value.ignored, files: r.value.files };
    } catch (e) {
      for (const id of stored) await ctx.storage.delete(id);
      throw e;
    }
  },
});

/** IMP-024: renders the import protocol of a committed import from its frozen row and stores the PDF. */
export const renderProtocol = systemAction({
  job: "imports.protocol",
  args: { importId: v.id("imports") },
  handler: async (
    ctx,
    { importId },
  ): Promise<{ storageId: Id<"_storage">; sha256: string; bytes: number; mime: string; name: string }> => {
    const input = await ctx.runQuery(internal.imports.protocolInput, { importId });
    const protocol = buildImportProtocol(input);
    const pdf = await renderImportProtocol(protocol);
    const storageId = await ctx.storage.store(new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
    return {
      storageId,
      sha256: await sha256Hex(pdf),
      bytes: pdf.length,
      mime: "application/pdf",
      name: protocol.fileName,
    };
  },
});
