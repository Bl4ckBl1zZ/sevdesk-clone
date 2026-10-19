import { CAPTURE_MESSAGES, MAX_UPLOAD_BYTES, sniffMime } from "@/domain/vouchers/capture";

/**
 * Drag & drop of files and folders into the Posteingang (F06 INB-001/002): directory traversal over the
 * File-System-Entry API, then a client-side magic-byte pre-check so non-accepted files can be listed in the summary
 * toast without uploading them. The server sniffs again (INB-001) — this check is only a convenience.
 */

/** The subset of `FileSystemEntry` we use (fakes in tests). */
export interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
  file?: (ok: (f: File) => void, fail?: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: EntryLike[]) => void, fail?: (e: unknown) => void) => void };
}

export interface PickedFile {
  file: File;
  /** Relative path inside the dropped folder (or the file name). */
  path: string;
}

const pathOf = (e: EntryLike) => (e.fullPath ?? e.name).replace(/^\/+/, "");

async function readAll(dir: EntryLike): Promise<EntryLike[]> {
  const reader = dir.createReader?.();
  if (!reader) return [];
  const out: EntryLike[] = [];
  // readEntries returns batches (Chrome: ≤ 100) until an empty batch.
  for (;;) {
    const batch = await new Promise<EntryLike[]>((ok, fail) => reader.readEntries(ok, fail));
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

/** Every file below the given entries (one inbox item per file), sorted by path for a stable upload order. */
export async function collectEntryFiles(entries: readonly EntryLike[]): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const walk = async (e: EntryLike): Promise<void> => {
    if (e.isFile && e.file) {
      const f = await new Promise<File>((ok, fail) => e.file?.(ok, fail));
      out.push({ file: f, path: pathOf(e) });
    } else if (e.isDirectory) {
      for (const child of await readAll(e)) await walk(child);
    }
  };
  for (const e of entries) await walk(e);
  return out.sort((a, b) => a.path.localeCompare(b.path, "de"));
}

/** Files of a drop event: folders are traversed where the browser supports entries, else the plain file list. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<PickedFile[]> {
  const items = dt.items ? [...dt.items] : [];
  const entries = items
    .filter((i) => i.kind === "file")
    .map((i) => (i as unknown as { webkitGetAsEntry?: () => EntryLike | null }).webkitGetAsEntry?.() ?? null)
    .filter((e): e is EntryLike => e !== null);
  if (entries.length > 0) return collectEntryFiles(entries);
  return [...(dt.files ?? [])].map((f) => ({ file: f, path: f.name }));
}

export interface Precheck {
  accepted: PickedFile[];
  rejected: { name: string; message: string }[];
}

/** INB-001 magic-byte check of the first bytes plus the 20 MB limit (EC-INB-01/02). */
export async function precheckFiles(files: readonly PickedFile[], maxBytes = MAX_UPLOAD_BYTES): Promise<Precheck> {
  const out: Precheck = { accepted: [], rejected: [] };
  for (const p of files) {
    if (p.file.size > maxBytes) {
      out.rejected.push({ name: p.path, message: CAPTURE_MESSAGES.tooLarge(Math.round(maxBytes / 1024 / 1024)) });
      continue;
    }
    const head = new Uint8Array(await p.file.slice(0, 512).arrayBuffer());
    if (head.byteLength === 0 || !sniffMime(head)) {
      out.rejected.push({ name: p.path, message: CAPTURE_MESSAGES.unsupported });
      continue;
    }
    out.accepted.push(p);
  }
  return out;
}
