import type { DatevJournalEntry } from "../../src/domain/datev/mapping";
import type { DatevContactData, DatevDocData, DatevRunInput, DatevScope } from "../../src/domain/datev/run";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { DatevContext, DatevEntriesPage } from "../model/datev";

/**
 * F09 §4.1.3: loads everything the pure DATEV flow (src/domain/datev/run.ts) needs, page by page — used by the dry
 * run („Prüfen") and the export job. File bytes are only read for the real export.
 */
export interface DatevLoadArgs {
  from: string;
  to: string;
  scope: DatevScope[];
  mode: "new" | "full";
  festschreibung?: boolean | undefined;
  confirmReplace?: boolean | undefined;
}

export async function loadDatevInput(
  ctx: Pick<ActionCtx, "runQuery" | "storage">,
  args: DatevLoadArgs,
  opts: { withBytes: boolean; now: number },
): Promise<{ input: DatevRunInput; running: boolean }> {
  const c: DatevContext = await ctx.runQuery(internal.datev.context, { from: args.from, to: args.to });
  const entries: DatevJournalEntry[] = [];
  const belege: DatevRunInput["belege"] = {};
  const contacts = new Map<string, DatevContactData>(c.contacts.map((x) => [x.id, x]));
  const docs: DatevDocData[] = [];
  const bookingScope = args.scope.filter((s) => s !== "master_data" && s !== "documents");
  const withDocs = args.scope.includes("documents");
  if (bookingScope.length > 0 && c.years.length > 0) {
    for (let cursor: string | null = null; ; ) {
      const page: DatevEntriesPage = await ctx.runQuery(internal.datev.entriesPage, {
        from: args.from,
        to: args.to,
        scope: bookingScope,
        cursor,
        documents: withDocs,
      });
      entries.push(...page.entries);
      Object.assign(belege, page.belege);
      for (const x of page.contacts) if (!contacts.has(x.id)) contacts.set(x.id, x);
      for (const d of page.docs) {
        const files: DatevDocData["files"][number][] = [];
        for (const f of d.files) {
          let bytes: Uint8Array | undefined;
          if (opts.withBytes) {
            const blob = await ctx.storage.get(f.storageId as Id<"_storage">);
            bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
            if (!bytes) continue;
          }
          files.push({ ext: f.ext, sha256: f.sha256, ...(bytes ? { bytes } : {}) });
        }
        docs.push({ sourceId: d.sourceId, belegfeld1: d.belegfeld1, numbered: d.numbered, files });
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }
  entries.sort((a, b) => a.seq - b.seq);
  return {
    running: c.running,
    input: {
      from: args.from,
      to: args.to,
      mode: args.mode,
      scope: args.scope,
      festschreibung: args.festschreibung,
      confirmReplace: args.confirmReplace,
      settings: c.settings,
      years: c.years,
      lockedMonths: c.lockedMonths,
      previous: c.previous,
      entries,
      belege,
      contacts: [...contacts.values()],
      docs,
      usedAccounts: c.usedAccounts,
      accepted: c.accepted,
      createdAt: opts.now,
    },
  };
}
