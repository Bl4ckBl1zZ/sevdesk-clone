"use node";

import { createHash } from "node:crypto";
import { v } from "convex/values";
import { zipSync } from "fflate";
import { kontoRow } from "../src/domain/gdpdu/adapters";
import type { GdpduRow } from "../src/domain/gdpdu/schema-v1";
import { buildGdpduPackage } from "../src/domain/gdpdu/write";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { systemAction } from "./functions";
import { SCHEMA_VERSION } from "./integrity";
import { env } from "./lib/env";
import { GDPDU_SOURCES, type GdpduFileRef, type GdpduPage } from "./model/gdpdu";

/**
 * F09 EXP-017 worker: pulls every source page, merges the rows per `gdpdu-v1` table, fills the running cash balance
 * and the accounts referenced by the journal, builds and validates the package (DTD, row counts — E-EXP-31/32) and
 * stores the ZIP. A validation error fails the job with the German message; nothing is offered.
 */

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export const run = systemAction({
  job: "exports.run",
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }): Promise<boolean> => {
    try {
      const meta = await ctx.runQuery(internal.gdpdu.meta, { jobId });
      if (!meta) return false;
      const rows: Record<string, GdpduRow[]> = {};
      const dbCounts: Record<string, number> = {};
      const files: GdpduFileRef[] = [];
      let done = 0;
      for (const source of GDPDU_SOURCES) {
        if (!(await ctx.runMutation(internal.gdpdu.step, { jobId, done }))) return false;
        for (let cursor: string | null = null; ; ) {
          const page: GdpduPage = await ctx.runQuery(internal.gdpdu.sourcePage, {
            source,
            year: meta.year,
            cursor,
            includeFiles: meta.includeFiles,
          });
          for (const [file, r] of Object.entries(page.rows)) rows[file] = [...(rows[file] ?? []), ...r];
          for (const [file, n] of Object.entries(page.db)) dbCounts[file] = (dbCounts[file] ?? 0) + n;
          files.push(...page.files);
          if (page.isDone) break;
          cursor = page.continueCursor;
        }
        done++;
      }

      // Running balance of the cash account over the whole year (kassenbewegungen.csv).
      let saldo = meta.cash.cents;
      const kasse = (rows["kassenbewegungen.csv"] ?? []).sort(
        (a, b) => Number(a.seq) - Number(b.seq) || Number(a.zeile) - Number(b.zeile),
      );
      rows["kassenbewegungen.csv"] = kasse.map((r) => {
        saldo += Number(r.betrag);
        return { ...r, saldo };
      });
      // Konten: chart + personal accounts, deduplicated; accounts used in the journal but missing are added so the
      // foreign key buchungszeilen.konto → Konten holds.
      const konten = new Map<string, GdpduRow>();
      for (const k of rows["konten.csv"] ?? [])
        if (!konten.has(String(k.kontonummer))) konten.set(String(k.kontonummer), k);
      for (const l of rows["buchungszeilen.csv"] ?? []) {
        const n = String(l.konto);
        if (!konten.has(n))
          konten.set(n, kontoRow({ number: n, name: "(nicht im Standardkontenrahmen)", type: "unknown" }));
      }
      rows["konten.csv"] = [...konten.values()].sort((a, b) =>
        String(a.kontonummer).localeCompare(String(b.kontonummer)),
      );

      const belege: Record<string, Uint8Array> = {};
      for (const f of files) {
        const blob = await ctx.storage.get(f.storageId as Id<"_storage">);
        if (blob) belege[f.path] = new Uint8Array(await blob.arrayBuffer());
      }
      const built = buildGdpduPackage({
        supplier: meta.supplier,
        app: { name: "Rechnungen", version: env("APP_VERSION") ?? "0.0.0" },
        year: meta.year,
        range: meta.range,
        encoding: meta.encoding,
        createdAt: new Date().toISOString(),
        rows,
        dbCounts,
        belege,
        internalSchemaVersions: [SCHEMA_VERSION],
        restrictedContacts: meta.restrictedContacts,
        purges: meta.purges,
      });
      if (!built.ok) throw new Error(built.errors.join(" "));
      const zip = zipSync(built.value.files, { level: 6 });
      const storageId = await ctx.storage.store(
        new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
      );
      return await ctx.runMutation(internal.gdpdu.done, {
        jobId,
        storageId,
        name: `gdpdu-${meta.year}${meta.encoding === "ansi" ? "-ansi" : ""}.zip`,
        sha256: sha(zip),
        bytes: zip.length,
        counts: built.value.counts,
      });
    } catch (e) {
      await ctx.runMutation(internal.gdpdu.failed, { jobId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },
});
