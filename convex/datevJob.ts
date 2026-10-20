import { v } from "convex/values";
import { zipSync } from "fflate";
import { sha256Hex } from "../src/domain/audit/chain";
import { runDatevExport } from "../src/domain/datev/run";
import { internal } from "./_generated/api";
import { systemAction } from "./functions";
import { loadDatevInput } from "./lib/datevLoad";

/**
 * F09 §4.1.3 worker: load → (EXP-006) assign missing personal accounts as the starting member → map/validate again
 * with the real numbers → blocking errors fail the job with the German messages, nothing is offered → ZIP (one
 * Buchungsstapel per fiscal year, master data, documents, document.xml, manifest.csv) → stored with the history row.
 * E-EXP-03 (nothing new) fails the job with the info instead of writing an empty file.
 */
export const run = systemAction({
  job: "exports.run",
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }): Promise<boolean> => {
    try {
      const params = await ctx.runQuery(internal.datev.job, { jobId });
      if (!params) return false;
      if (!(await ctx.runMutation(internal.datev.step, { jobId, done: 0 }))) return false;
      const now = Date.now();
      let { input } = await loadDatevInput(ctx, params, { withBytes: false, now });
      const first = await runDatevExport(input);
      let assigned = 0;
      if (!first.report.blocking && first.needsAccount.length > 0) {
        assigned = await ctx.runMutation(internal.datev.assign, { jobId, needs: first.needsAccount });
      }
      if (!(await ctx.runMutation(internal.datev.step, { jobId, done: 1 }))) return false;
      ({ input } = await loadDatevInput(ctx, params, { withBytes: true, now }));
      const r = await runDatevExport({ ...input, assignedCount: assigned });
      const errors = r.report.issues.filter((i) => i.level === "error").map((i) => i.message);
      if (r.report.blocking) throw new Error(errors.slice(0, 5).join(" "));
      if (r.report.needsConfirmation) throw new Error(r.report.needsConfirmation);
      if (r.report.nothingToExport) {
        throw new Error(r.report.issues.map((i) => i.message).join(" ") || "Keine Buchungen im Zeitraum.");
      }
      if (!(await ctx.runMutation(internal.datev.step, { jobId, done: 2 }))) return false;
      const zip = zipSync(r.files, { level: 6 });
      const storageId = await ctx.storage.store(
        new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
      );
      const suffix = r.report.doNotReimport
        ? "_Wiederholung_nicht_importieren"
        : r.report.accepted
          ? ""
          : "_Testexport";
      return await ctx.runMutation(internal.datev.done, {
        jobId,
        storageId,
        name: `DATEV_${params.from.replaceAll("-", "")}_${params.to.replaceAll("-", "")}${suffix}.zip`,
        sha256: await sha256Hex(zip),
        bytes: zip.length,
        files: r.fileHashes,
        lineIds: r.lineIds,
        rowCount: r.report.rowCount,
        sumUmsatzCents: r.report.sumUmsatzCents,
        festschreibung: r.report.festschreibung === 1,
        isRepeat: r.report.isRepeat,
        doNotReimport: r.report.doNotReimport,
        formatVersion: input.settings.formatVersion,
        report: { issues: r.report.issues.slice(0, 200), files: r.report.files },
      });
    } catch (e) {
      await ctx.runMutation(internal.datev.failed, { jobId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },
});
