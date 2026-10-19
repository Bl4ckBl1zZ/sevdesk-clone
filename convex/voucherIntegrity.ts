import { v } from "convex/values";
import type { IntegrityFinding } from "../src/domain/audit/chain";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { systemQuery } from "./functions";

/**
 * F06 VOU-126 (SEC-04 scope extension, GOBD-06, ER-13): the nightly integrity job re-hashes every voucher original
 * (all versions, incl. replaced ones), the approved Eigenbeleg/Bewirtungsbeleg PDFs and the E-Rechnung XML and compares
 * them with the SHA-256 recorded at capture. A missing or altered file is an `error` finding.
 */

const PAGE = 100;

export const voucherFilesPage = systemQuery({
  job: "cron.integrity.verify",
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("vouchers").paginate({ cursor, numItems: PAGE });
    return {
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      files: page.page.flatMap((voucher) => {
        const out: { voucherId: Id<"vouchers">; label: string; storageId: Id<"_storage">; sha256: string }[] = [];
        const label = voucher.internalNumber ?? voucher.documentNumber ?? voucher._id;
        for (const [i, f] of voucher.originalFiles.entries()) {
          out.push({
            voucherId: voucher._id,
            label: `${label} Datei ${i + 1}`,
            storageId: f.storageId,
            sha256: f.sha256,
          });
        }
        if (voucher.eigenbeleg?.file) {
          const f = voucher.eigenbeleg.file;
          out.push({ voucherId: voucher._id, label: `${label} Eigenbeleg`, storageId: f.storageId, sha256: f.sha256 });
        }
        for (const f of [
          voucher.bewirtung?.eigenbelegFile,
          ...(voucher.bewirtung?.versions ?? []).map((x) => x.eigenbelegFile),
        ]) {
          if (f)
            out.push({
              voucherId: voucher._id,
              label: `${label} Bewirtungsbeleg`,
              storageId: f.storageId,
              sha256: f.sha256,
            });
        }
        if (voucher.einvoice) {
          out.push({
            voucherId: voucher._id,
            label: `${label} E-Rechnung`,
            storageId: voucher.einvoice.xmlStorageId,
            sha256: voucher.einvoice.xmlSha256,
          });
        }
        return out;
      }),
    };
  },
});

const hex = async (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );

/** Re-hashes all voucher files; returns the findings (called by `runVerify` in integrity.ts). */
export async function rehashVoucherFiles(
  ctx: Pick<ActionCtx, "runQuery" | "storage">,
): Promise<{ checked: number; findings: IntegrityFinding[] }> {
  const findings: IntegrityFinding[] = [];
  let cursor: string | null = null;
  let checked = 0;
  for (;;) {
    const page: {
      isDone: boolean;
      continueCursor: string;
      files: { voucherId: Id<"vouchers">; label: string; storageId: Id<"_storage">; sha256: string }[];
    } = await ctx.runQuery(internal.voucherIntegrity.voucherFilesPage, { cursor });
    for (const f of page.files) {
      checked++;
      const blob = await ctx.storage.get(f.storageId);
      const entity = { table: "vouchers", id: f.voucherId };
      if (!blob) {
        findings.push({
          kind: "file_hash_mismatch",
          severity: "error",
          detail: `${f.label}: Datei fehlt im Speicher.`,
          entity,
        });
        continue;
      }
      const actual = await hex(await blob.arrayBuffer());
      if (actual !== f.sha256) {
        findings.push({
          kind: "file_hash_mismatch",
          severity: "error",
          detail: `${f.label}: SHA-256 weicht ab (erwartet ${f.sha256.slice(0, 12)}…, gefunden ${actual.slice(0, 12)}…).`,
          entity,
        });
      }
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return { checked, findings };
}
