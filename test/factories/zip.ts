/**
 * Synthetic ZIP archives for the F09 import tests (IMP-016, E-IMP-29/39/40). Writes local headers, central
 * directory and end record by hand so tests can produce what real tools produce (deflate, data descriptors,
 * CP437 names, ZIP64 records) and what attackers produce (encrypted flags, symlinks, path traversal, lying sizes).
 * No real data — every archive is built in the test.
 */
import { deflateSync } from "fflate";
import { crc32 } from "@/domain/archive/zip";

export interface CraftedEntry {
  readonly name: string | Uint8Array;
  readonly data?: Uint8Array | string;
  /** 0 = stored, 8 = deflate (default), anything else is written as-is with the raw data. */
  readonly method?: number;
  /** General-purpose flags; bit 11 (UTF-8) is added for string names unless `utf8: false`. */
  readonly flags?: number;
  readonly utf8?: boolean;
  /** Upper byte of „version made by“ (3 = Unix) and the external attributes (Unix mode in the high 16 bits). */
  readonly madeBy?: number;
  readonly externalAttrs?: number;
  /** Override the declared uncompressed size (zip-bomb / lying header tests). */
  readonly declaredSize?: number;
  readonly crc?: number;
  /** Write sizes and offset as 0xFFFFFFFF with a ZIP64 extended-information extra field. */
  readonly zip64?: boolean;
}

const enc = new TextEncoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

export function craftZip(entries: readonly CraftedEntry[], opts: { zip64Eocd?: boolean } = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = typeof e.name === "string" ? enc.encode(e.name) : e.name;
    const raw = typeof e.data === "string" ? enc.encode(e.data) : (e.data ?? new Uint8Array());
    const method = e.method ?? 8;
    const body = method === 8 ? deflateSync(raw) : raw;
    const flags = (e.flags ?? 0) | (typeof e.name === "string" && e.utf8 !== false ? 0x0800 : 0);
    const crc = e.crc ?? crc32(raw);
    const size = e.declaredSize ?? raw.length;
    const extra = e.zip64 ? new Uint8Array(28) : new Uint8Array();
    if (e.zip64) {
      const xv = new DataView(extra.buffer);
      xv.setUint16(0, 0x0001, true);
      xv.setUint16(2, 24, true);
      xv.setBigUint64(4, BigInt(size), true);
      xv.setBigUint64(12, BigInt(body.length), true);
      xv.setBigUint64(20, BigInt(offset), true);
    }
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length + extra.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, ((e.madeBy ?? 0) << 8) | 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.zip64 ? 0xffffffff : body.length, true);
    cv.setUint32(24, e.zip64 ? 0xffffffff : size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, extra.length, true);
    cv.setUint32(38, e.externalAttrs ?? 0, true);
    cv.setUint32(42, e.zip64 ? 0xffffffff : offset, true);
    central.set(name, 46);
    central.set(extra, 46 + name.length);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cd = concat(centrals);
  const tail: Uint8Array[] = [];
  if (opts.zip64Eocd) {
    const rec = new Uint8Array(56);
    const rv = new DataView(rec.buffer);
    rv.setUint32(0, 0x06064b50, true);
    rv.setBigUint64(4, 44n, true);
    rv.setUint16(12, 45, true);
    rv.setUint16(14, 45, true);
    rv.setBigUint64(24, BigInt(entries.length), true);
    rv.setBigUint64(32, BigInt(entries.length), true);
    rv.setBigUint64(40, BigInt(cd.length), true);
    rv.setBigUint64(48, BigInt(offset), true);
    const loc = new Uint8Array(20);
    const locv = new DataView(loc.buffer);
    locv.setUint32(0, 0x07064b50, true);
    locv.setBigUint64(8, BigInt(offset + cd.length), true);
    locv.setUint32(16, 1, true);
    tail.push(rec, loc);
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, opts.zip64Eocd ? 0xffff : entries.length, true);
  ev.setUint16(10, opts.zip64Eocd ? 0xffff : entries.length, true);
  ev.setUint32(12, opts.zip64Eocd ? 0xffffffff : cd.length, true);
  ev.setUint32(16, opts.zip64Eocd ? 0xffffffff : offset, true);
  return concat([...locals, cd, ...tail, end]);
}

/** A minimal one-page PDF whose bytes differ by `marker` (distinct SHA-256 per test file). */
export const tinyPdf = (marker: string): Uint8Array =>
  enc.encode(`%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
