/**
 * F09 EXP-014 / EXP-015 / DATEV-03: the document part of the DATEV ZIP — one file per exported document named after
 * Belegfeld 1, a `document.xml` index and `manifest.csv`. Pure (hashes are supplied by the caller).
 *
 * ⚠ (F09 §4.1 open item, research 01 DATEV-03): `document.xml` follows the structure of DATEV „XML-Schnittstelle
 * online" (document schema v05.0, one `<document guid>` per Beleg with its files as `<extension xsi:type="File">`);
 * the Beleglink column references the document GUID as `BEDI "<GUID>"`. To be confirmed by the first Steuerberater
 * import (EXP-016) — until then every DATEV download is a „Testexport".
 */

export interface DatevDocFile {
  /** File extension without dot (pdf, xml, jpg, …). */
  ext: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface DatevDocInput {
  /** Belegfeld 1 of the bookings (document number / internal voucher number). */
  belegfeld1: string;
  /** Stable id of the source record (document or voucher id) — the GUID is derived from it. */
  sourceId: string;
  files: readonly DatevDocFile[];
  /** Vouchers with several original files: `<nr>_1.pdf`, `<nr>_2.jpg`; sales: `<nr>.pdf` + `<nr>.xml`. */
  numbered?: boolean;
}

export interface DatevDocPackage {
  files: Record<string, Uint8Array>;
  /** Belegfeld 1 → document GUID (for the Beleglink column). */
  guids: Map<string, string>;
  manifestCsv: string;
  documentXml: string;
}

const SAFE = /[^A-Za-z0-9$%&*+\-/]/g;
/** File name base: Belegfeld 1 with characters outside the DATEV set (and "/") replaced by "_". */
export const datevFileBase = (belegfeld1: string) => belegfeld1.replace(SAFE, "_").replaceAll("/", "_") || "Beleg";

function fnv1a64(s: string, seed: bigint): bigint {
  let h = seed;
  for (const ch of new TextEncoder().encode(s)) {
    h ^= BigInt(ch);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

/** Deterministic RFC 4122-shaped GUID (version nibble 8 = custom) from a seed — same input, same GUID. */
export function deterministicGuid(seed: string): string {
  const a = fnv1a64(seed, 0xcbf29ce484222325n);
  const b = fnv1a64(`${seed}#`, 0x84222325cbf29ce4n);
  const hex = (a.toString(16).padStart(16, "0") + b.toString(16).padStart(16, "0")).split("");
  hex[12] = "8";
  hex[16] = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function datevDocumentPackage(
  docs: readonly DatevDocInput[],
  opts: { createdAt: string; description: string },
): DatevDocPackage {
  const files: Record<string, Uint8Array> = {};
  const guids = new Map<string, string>();
  const used = new Set<string>();
  const manifest: string[] = ["Datei;Belegfeld 1;SHA-256;GUID"];
  const xmlDocs: string[] = [];
  const unique = (name: string) => {
    if (!used.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf(".");
    for (let i = 2; ; i++) {
      const cand = `${name.slice(0, dot)}_${i}${name.slice(dot)}`;
      if (!used.has(cand.toLowerCase())) return cand;
    }
  };
  for (const d of [...docs].sort(
    (a, b) => a.belegfeld1.localeCompare(b.belegfeld1) || a.sourceId.localeCompare(b.sourceId),
  )) {
    if (d.files.length === 0) continue;
    const guid = deterministicGuid(d.sourceId);
    guids.set(d.belegfeld1, guid);
    const base = datevFileBase(d.belegfeld1);
    const names: string[] = [];
    for (const [i, f] of d.files.entries()) {
      const name = unique(d.numbered && d.files.length > 1 ? `${base}_${i + 1}.${f.ext}` : `${base}.${f.ext}`);
      used.add(name.toLowerCase());
      files[name] = f.bytes;
      names.push(name);
      manifest.push(`"${name}";"${d.belegfeld1.replace(/"/g, '""')}";${f.sha256};${guid}`);
    }
    xmlDocs.push(
      [
        `    <document guid="${guid}" processID="1">`,
        `      <description>${esc(d.belegfeld1)}</description>`,
        ...names.map((n) => `      <extension xsi:type="File" name="${esc(n)}"/>`),
        "    </document>",
      ].join("\r\n"),
    );
  }
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<archive xmlns="http://xml.datev.de/bedi/tps/document/v05.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://xml.datev.de/bedi/tps/document/v05.0 Document_v050.xsd" version="5.0" generatingSystem="Rechnungen">',
    `  <header><date>${esc(opts.createdAt)}</date><description>${esc(opts.description)}</description></header>`,
    "  <content>",
    ...xmlDocs,
    "  </content>",
    "</archive>",
    "",
  ].join("\r\n");
  return { files, guids, manifestCsv: `${manifest.join("\r\n")}\r\n`, documentXml };
}
