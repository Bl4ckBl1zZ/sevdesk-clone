/**
 * ZIP reading for uploads (F09 IMP-016, E-IMP-29). Pure TS: the central directory is parsed here (fflate's
 * unzip API does not expose the encryption flag or the Unix mode, both needed to reject encrypted entries and
 * symlinks); fflate is used only to inflate method-8 entries, as a stream whose output is capped at the declared
 * size, so a lying header cannot expand beyond what the caller allowed. Sizes and offsets come from the central
 * directory (local headers of data-descriptor entries carry zeros). ZIP64 records are read; multi-disk archives
 * are refused. Also hosts the CRC-32 used by the ZIP writer in src/lib/zip.ts (one implementation).
 */
import { Inflate } from "fflate";
import { err, type Issue, ok, type Result } from "../result";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ZipErrorCode =
  | "zip_directory"
  | "zip_multi_disk"
  | "zip_header"
  | "zip_method"
  | "zip_size_mismatch"
  | "zip_crc"
  | "zip_corrupt";

export interface ZipCentralEntry {
  /** Name as stored (decoded: UTF-8 flag, unflagged UTF-8, else CP437); `\` is kept for the caller to judge. */
  readonly path: string;
  readonly flags: number;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc: number;
  readonly localOffset: number;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
  /** General-purpose bit 0 (traditional/AES) or bit 6 (strong encryption). */
  readonly encrypted: boolean;
}

const fail = (code: ZipErrorCode, message: string): { ok: false; error: Issue<ZipErrorCode> } => err({ code, message });

// CP437 upper half (IBM PC); the lower half is ASCII.
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

function decodeName(raw: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder("utf-8").decode(raw);
  if (raw.every((b) => b < 0x80)) return String.fromCharCode(...raw);
  try {
    // macOS Archive Utility writes UTF-8 names without setting bit 11; CP437 bytes are rarely valid UTF-8.
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return Array.from(raw, (b) => (b < 0x80 ? String.fromCharCode(b) : (CP437_HIGH[b - 0x80] as string))).join("");
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
function u64(view: DataView, at: number): number | null {
  const v = view.getBigUint64(at, true);
  return v > MAX_SAFE ? null : Number(v);
}

/** Lists the archive's central directory. Fails on anything that is not a single-disk, well-formed ZIP. */
export function readZipDirectory(bytes: Uint8Array): Result<ZipCentralEntry[], Issue<ZipErrorCode>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const missing = () => fail("zip_directory", "Das Inhaltsverzeichnis des Archivs fehlt oder ist beschädigt.");
  if (bytes.length < 22) return missing();
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return missing();
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
    return fail("zip_multi_disk", "Mehrteilige (geteilte) ZIP-Archive werden nicht unterstützt.");
  }
  let count = view.getUint16(eocd + 10, true);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || view.getUint32(loc, true) !== 0x07064b50) return missing();
    const recAt = u64(view, loc + 8);
    if (recAt === null || recAt + 56 > bytes.length || view.getUint32(recAt, true) !== 0x06064b50) return missing();
    const c = u64(view, recAt + 32);
    const s = u64(view, recAt + 40);
    const o = u64(view, recAt + 48);
    if (c === null || s === null || o === null) return missing();
    [count, cdSize, cdOffset] = [c, s, o];
  }
  if (cdOffset + cdSize > bytes.length) return missing();
  const out: ZipCentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) return missing();
    const madeBy = view.getUint16(p + 4, true) >>> 8;
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    let compressedSize = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const disk = view.getUint16(p + 34, true);
    const external = view.getUint32(p + 38, true);
    let localOffset = view.getUint32(p + 42, true);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > bytes.length) return missing();
    if (disk !== 0 && disk !== 0xffff) {
      return fail("zip_multi_disk", "Mehrteilige (geteilte) ZIP-Archive werden nicht unterstützt.");
    }
    const path = decodeName(bytes.subarray(p + 46, p + 46 + nameLen), (flags & 0x0800) !== 0);
    // ZIP64 extended information: only the fields whose 32-bit value is 0xFFFFFFFF are present, in this order.
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      let found = false;
      while (x + 4 <= xEnd) {
        const id = view.getUint16(x, true);
        const len = view.getUint16(x + 2, true);
        if (id === 0x0001) {
          let f = x + 4;
          const take = () => {
            const v = f + 8 <= x + 4 + len ? u64(view, f) : null;
            f += 8;
            return v;
          };
          if (size === 0xffffffff) size = take() ?? -1;
          if (compressedSize === 0xffffffff) compressedSize = take() ?? -1;
          if (localOffset === 0xffffffff) localOffset = take() ?? -1;
          found = true;
          break;
        }
        x += 4 + len;
      }
      if (!found || size < 0 || compressedSize < 0 || localOffset < 0) {
        return fail("zip_header", `Die ZIP64-Angaben zu „${path}“ fehlen oder sind ungültig.`);
      }
    }
    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    out.push({
      path,
      flags,
      method,
      compressedSize,
      size,
      crc,
      localOffset,
      isDirectory: path.endsWith("/") || path.endsWith("\\") || (unixMode & 0o170000) === 0o040000,
      isSymlink: (unixMode & 0o170000) === 0o120000,
      encrypted: (flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || method === 99,
    });
    p = end;
  }
  return ok(out);
}

const CHUNK = 16 * 1024;

/**
 * Inflates one entry. The output is capped at the declared size: producing more (lying header, zip bomb) or less
 * fails, and the CRC-32 must match. Only „stored“ (0) and „deflate“ (8) are supported.
 */
export function extractZipEntry(bytes: Uint8Array, entry: ZipCentralEntry): Result<Uint8Array, Issue<ZipErrorCode>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (at + 30 > bytes.length || view.getUint32(at, true) !== 0x04034b50) {
    return fail("zip_header", `Der Eintrag „${entry.path}“ ist beschädigt.`);
  }
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  if (start + entry.compressedSize > bytes.length) {
    return fail("zip_header", `Der Eintrag „${entry.path}“ ist unvollständig.`);
  }
  const data = bytes.subarray(start, start + entry.compressedSize);
  let out: Uint8Array;
  if (entry.method === 0) {
    if (data.length !== entry.size) {
      return fail(
        "zip_size_mismatch",
        `Die Größe von „${entry.path}“ stimmt nicht mit dem Inhaltsverzeichnis überein.`,
      );
    }
    out = data.slice();
  } else if (entry.method === 8) {
    out = new Uint8Array(entry.size);
    let written = 0;
    let overflow = false;
    const inflater = new Inflate((chunk) => {
      if (written + chunk.length > entry.size) {
        overflow = true;
        throw new Error("overflow");
      }
      out.set(chunk, written);
      written += chunk.length;
    });
    try {
      for (let i = 0; i < data.length; i += CHUNK) {
        inflater.push(data.subarray(i, Math.min(i + CHUNK, data.length)), i + CHUNK >= data.length);
      }
      if (data.length === 0) inflater.push(new Uint8Array(), true);
    } catch {
      if (overflow) {
        return fail("zip_size_mismatch", `„${entry.path}“ ist entpackt größer als im Inhaltsverzeichnis angegeben.`);
      }
      return fail("zip_corrupt", `Der Eintrag „${entry.path}“ lässt sich nicht entpacken (beschädigt).`);
    }
    if (written !== entry.size) {
      return fail(
        "zip_size_mismatch",
        `Die Größe von „${entry.path}“ stimmt nicht mit dem Inhaltsverzeichnis überein.`,
      );
    }
  } else {
    return fail(
      "zip_method",
      `„${entry.path}“ verwendet ein nicht unterstütztes Komprimierungsverfahren (${entry.method}). Bitte das Archiv mit „Deflate“ (Standard-ZIP) erstellen.`,
    );
  }
  if (crc32(out) !== entry.crc) return fail("zip_crc", `Die Prüfsumme von „${entry.path}“ stimmt nicht (beschädigt).`);
  return ok(out);
}
