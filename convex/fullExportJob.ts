"use node";

import { createHash } from "node:crypto";
import { v } from "convex/values";
import { zipSync } from "fflate";
import { writeCsv } from "../src/domain/csv/csv";
import {
  base64ToHex,
  buildManifest,
  FULL_EXPORT_MAX_BYTES,
  fullExportReadme,
  type ManifestFile,
  ndjson,
  sha256Sums,
  storedFilePath,
} from "../src/domain/exports/full-export";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { systemAction } from "./functions";

/**
 * F09 EXP-023 worker (Node: 512 MB, node:crypto): tables → `tables/<table>.ndjson`, every stored file →
 * `files/<sha256>.<ext>` + `files/index.csv`, `manifest.json`, `SHA256SUMS.txt`, `README.txt`, one ZIP in storage.
 * SPEC-GAP EXP-023 (a) convex-snapshot.zip, (d) gdpdu/ (P3) and the optional `age` encryption are not produced —
 * see src/domain/exports/full-export.ts. Above FULL_EXPORT_MAX_BYTES the job fails instead of risking the memory
 * limit; the daily convex-export backup is the fallback.
 */

const PAGE = 200;
/** Keeps each page well below the query read and return limits (document snapshots are tens of KB each). */
const PAGE_BYTES = 4_000_000;
const enc = new TextEncoder();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const mb = (n: number) => `${(n / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`;

export const run = systemAction({
  job: "exports.run",
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }): Promise<boolean> => {
    try {
      const meta = await ctx.runQuery(internal.fullExport.meta, { jobId });
      if (!meta) return false;
      const zipFiles: Record<string, Uint8Array> = {};
      const files: ManifestFile[] = [];
      const counts: Record<string, number> = {};
      let total = 0;
      const tooLarge = () =>
        new Error(
          `Der Vollexport ist zu groß für die Erstellung in der Anwendung (über ${mb(FULL_EXPORT_MAX_BYTES)}). Bitte die tägliche Sicherung (convex-export) verwenden, siehe Runbook Wiederherstellung.`,
        );
      const add = (path: string, bytes: Uint8Array) => {
        total += bytes.length;
        if (total > FULL_EXPORT_MAX_BYTES) throw tooLarge();
        zipFiles[path] = bytes;
        files.push({ path, sha256: sha(bytes), bytes: bytes.length });
      };

      // Files first: their sizes are known up front, so an oversized export fails before any download.
      const skip = new Set(meta.jobResults);
      const stored: { id: string; sha256: string; size: number; contentType?: string }[] = [];
      for (let cursor: string | null = null; ; ) {
        const page: {
          files: { id: string; sha256: string; size: number; contentType?: string }[];
          isDone: boolean;
          continueCursor: string;
        } = await ctx.runQuery(internal.fullExport.storagePage, {
          paginationOpts: { cursor, numItems: PAGE, maximumBytesRead: PAGE_BYTES },
        });
        stored.push(...page.files.filter((f) => !skip.has(f.id)));
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      if (stored.reduce((s, f) => s + f.size, 0) > FULL_EXPORT_MAX_BYTES) throw tooLarge();

      let done = 0;
      for (const table of meta.tables) {
        if (!(await ctx.runMutation(internal.exports.jobStep, { jobId, done }))) return false;
        const rows: unknown[] = [];
        for (let cursor: string | null = null; ; ) {
          const page: { rows: unknown[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(
            internal.fullExport.tablePage,
            { table, paginationOpts: { cursor, numItems: PAGE, maximumBytesRead: PAGE_BYTES } },
          );
          rows.push(...page.rows);
          if (page.isDone) break;
          cursor = page.continueCursor;
        }
        counts[table] = rows.length;
        add(`tables/${table}.ndjson`, enc.encode(ndjson(rows)));
        done++;
      }

      if (!(await ctx.runMutation(internal.exports.jobStep, { jobId, done }))) return false;
      const index: string[][] = [];
      const seen = new Set<string>();
      for (const f of stored) {
        const hex = base64ToHex(f.sha256);
        const path = storedFilePath(hex, f.contentType);
        index.push([f.id, path, f.contentType ?? "", String(f.size)]);
        if (seen.has(path)) continue; // identical content is stored once
        const blob = await ctx.storage.get(f.id as Id<"_storage">);
        if (!blob) continue;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        seen.add(path);
        add(path, bytes);
      }
      add("files/index.csv", enc.encode(writeCsv(["Speicher-ID", "Datei", "Typ", "Bytes"], index)));

      const manifest = buildManifest({
        appVersion: meta.appVersion,
        schemaVersion: meta.schemaVersion,
        instanceName: meta.instanceName,
        exportedAt: new Date().toISOString(),
        auditHead: meta.auditHead,
        lastCheckpoint: meta.lastCheckpoint,
        tables: counts,
        files,
      });
      zipFiles["manifest.json"] = enc.encode(`${JSON.stringify(manifest, null, 2)}\n`);
      zipFiles["SHA256SUMS.txt"] = enc.encode(sha256Sums(manifest.files));
      zipFiles["README.txt"] = enc.encode(fullExportReadme(manifest));
      const zip = zipSync(zipFiles, { level: 6 });
      const storageId = await ctx.storage.store(
        new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
      );
      return await ctx.runMutation(internal.fullExport.done, {
        jobId,
        storageId,
        name: `vollexport-${meta.instanceName}-${manifest.exportedAt.slice(0, 10)}.zip`,
        sha256: sha(zip),
        bytes: zip.length,
      });
    } catch (e) {
      await ctx.runMutation(internal.exports.jobFailed, { jobId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },
});
