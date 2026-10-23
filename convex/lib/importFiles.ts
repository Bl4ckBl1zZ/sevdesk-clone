import { v } from "convex/values";
import { sha256Hex } from "../../src/domain/audit/chain";
import { inspectFile } from "../../src/domain/import/sevdesk/files";
import type { Id } from "../_generated/dataModel";

/**
 * F09 IMP-016: what an uploaded (or ZIP-contained) file contributes to `imports.files` — hash, detected kind,
 * CSV encoding/delimiter/headers and sample rows for the mapping grid. Shared by the upload action (default runtime)
 * and the ZIP unpacking Node action, so a contained file is classified exactly like a single upload.
 */
export const vNewImportFile = v.object({
  storageId: v.id("_storage"),
  sha256: v.string(),
  bytes: v.number(),
  mime: v.string(),
  name: v.string(),
  kind: v.string(),
  encoding: v.optional(v.string()),
  delimiter: v.optional(v.string()),
  headers: v.optional(v.array(v.string())),
  samples: v.optional(v.array(v.array(v.string()))),
  rows: v.optional(v.number()),
  readError: v.optional(v.string()),
  /** SHA-256 of the uploaded ZIP the file came from (the mutation maps it to that file's id). */
  containerSha256: v.optional(v.string()),
  unpacked: v.optional(v.object({ files: v.number(), ignored: v.array(v.string()) })),
});
export type NewImportFilePayload = typeof vNewImportFile.type;

const MIME_BY_KIND: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  xml: "application/xml",
  zip: "application/zip",
};

export async function describeImportFile(
  name: string,
  bytes: Uint8Array,
  storageId: Id<"_storage">,
  blobType = "",
): Promise<NewImportFilePayload> {
  const info = inspectFile(name, bytes);
  return {
    storageId,
    sha256: await sha256Hex(bytes),
    bytes: bytes.length,
    mime:
      blobType ||
      MIME_BY_KIND[info.kind] ||
      // IMP-025 voucher photos/scans
      (info.kind === "image" ? (bytes[0] === 0xff ? "image/jpeg" : "image/png") : undefined) ||
      (info.table ? "text/csv" : "application/octet-stream"),
    name: name.slice(0, 255),
    kind: info.kind,
    ...(info.encoding ? { encoding: info.encoding } : {}),
    ...(info.delimiter ? { delimiter: info.delimiter } : {}),
    ...(info.headers ? { headers: info.headers.slice(0, 200) } : {}),
    ...(info.table ? { samples: info.table.records.slice(0, 3).map((r) => r.cells.slice(0, 200)) } : {}),
    ...(info.table ? { rows: info.table.records.length } : {}),
    ...(info.readError ? { readError: info.readError } : {}),
  };
}
