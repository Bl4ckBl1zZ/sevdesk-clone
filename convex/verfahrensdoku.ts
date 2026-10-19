import { v } from "convex/values";
import { sha256Hex } from "../src/domain/audit/chain";
import { internal } from "./_generated/api";
import { action, actorMutation, mutation, query, systemMutation, systemQuery } from "./functions";
import { isTest } from "./lib/env";
import { appError } from "./lib/errors";
import {
  checkOutdated,
  commitRelease as commitReleaseModel,
  releaseInput as releaseInputModel,
  saveInputs as saveInputsModel,
  versionUrl as versionUrlModel,
  view as viewModel,
} from "./model/verfahrensdoku";
import { vFileRef } from "./validators";

/** `/einstellungen/verfahrensdokumentation` (F12 AUD-024/025, §4.6): chapters, owner inputs, release, versions. */

export const view = query({
  permission: "settings.read",
  args: { publicEdge: v.optional(v.boolean()) },
  handler: async (ctx, args) => viewModel(ctx, ctx.now(), args),
});

export const saveInputs = mutation({
  permission: "settings.ownerOnly",
  args: { values: v.record(v.string(), v.string()) },
  handler: async (ctx, { values }) => saveInputsModel(ctx, values),
});

export const releaseInput = systemQuery({
  job: "verfahrensdoku.release",
  args: { now: v.number(), publicEdge: v.optional(v.boolean()) },
  handler: async (ctx, { now, publicEdge }) => releaseInputModel(ctx, now, publicEdge ? { publicEdge } : {}),
});

export const commitRelease = actorMutation({
  permission: "settings.ownerOnly",
  args: {
    version: v.number(),
    validFrom: v.string(),
    sourceJson: v.string(),
    watch: v.record(v.string(), v.string()),
    file: vFileRef,
  },
  handler: async (ctx, r) => commitReleaseModel(ctx, r),
});

/** AUD-024/025 „Freigeben“ (owner): E-AUD-40 check, Markdown stored with SHA-256, immutable version row. */
export const release = action({
  permission: "settings.ownerOnly",
  args: { publicEdge: v.optional(v.boolean()) },
  handler: async (ctx, { publicEdge }): Promise<{ version: number; sha256: string }> => {
    const r = await ctx.runQuery(internal.verfahrensdoku.releaseInput, {
      now: Date.now(),
      ...(publicEdge ? { publicEdge } : {}),
    });
    if (r.issue) throw appError("invalid_input", r.issue, { reason: "VD_INCOMPLETE" });
    const bytes = new TextEncoder().encode(r.markdown);
    const sha256 = await sha256Hex(bytes);
    const storageId = await ctx.storage.store(new Blob([bytes], { type: "text/markdown;charset=utf-8" }));
    const version = await ctx.runMutation(internal.verfahrensdoku.commitRelease, {
      actorContext: ctx.actorContext,
      version: r.version,
      validFrom: r.validFrom,
      sourceJson: r.sourceJson,
      watch: r.watch,
      file: {
        storageId,
        sha256,
        bytes: bytes.length,
        mime: "text/markdown",
        name: `verfahrensdokumentation-v${r.version}-${r.validFrom}.md`,
      },
    });
    return { version, sha256 };
  },
});

/** E-AUD-42: an old version is delivered unchanged (file + hash). */
export const versionUrl = query({
  permission: "settings.read",
  args: { version: v.number() },
  handler: async (ctx, { version }) => versionUrlModel(ctx, version),
});

export const watchCron = systemMutation({
  job: "cron.verfahrensdoku.watch",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return null;
    return checkOutdated(ctx);
  },
});
