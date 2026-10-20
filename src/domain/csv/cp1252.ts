/**
 * Windows-1252 ("ANSI") encoder for DATEV EXTF (DATEV-01, EXP-001) and the optional ANSI GDPdU encoding (EXP-018).
 * Bytes 0x00–0x7F and 0xA0–0xFF equal the Unicode code points; 0x80–0x9F carry the typographic characters below.
 * Characters outside Windows-1252 are transliterated first (`ANSI_TRANSLITERATION`), anything still unmappable becomes
 * "?" and is reported so the caller can warn (E-EXP-06).
 */

const HIGH: Readonly<Record<number, number>> = {
  8364: 0x80, // €
  8218: 0x82,
  402: 0x83,
  8222: 0x84, // „
  8230: 0x85, // …
  8224: 0x86,
  8225: 0x87,
  710: 0x88,
  8240: 0x89,
  352: 0x8a,
  8249: 0x8b,
  338: 0x8c,
  381: 0x8e,
  8216: 0x91,
  8217: 0x92,
  8220: 0x93, // “
  8221: 0x94,
  8226: 0x95,
  8211: 0x96, // –
  8212: 0x97,
  732: 0x98,
  8482: 0x99,
  353: 0x9a,
  8250: 0x9b,
  339: 0x9c,
  382: 0x9e,
  376: 0x9f,
};

/** Common characters outside Windows-1252 and their closest representation. */
export const ANSI_TRANSLITERATION: Readonly<Record<string, string>> = {
  "−": "-", // minus sign
  "‐": "-",
  "‑": "-",
  "­": "",
  "​": "",
  " ": " ",
  " ": " ",
  " ": " ",
  "′": "'",
  "″": '"',
  "→": "->",
  "←": "<-",
  "≤": "<=",
  "≥": ">=",
  Ł: "L",
  ł: "l",
  ć: "c",
  č: "c",
  Ć: "C",
  Č: "C",
  ę: "e",
  ě: "e",
  ń: "n",
  ň: "n",
  ř: "r",
  ś: "s",
  Ś: "S",
  ź: "z",
  ż: "z",
  ı: "i",
  ğ: "g",
  ş: "s",
  ă: "a",
  ą: "a",
  ș: "s",
  ț: "t",
  ẞ: "SS",
};

export interface AnsiResult {
  bytes: Uint8Array;
  /** Distinct characters that could not be represented (written as "?"). */
  unmappable: string[];
  /** Distinct characters written as a replacement: [original, replacement] (DATEV E-EXP-15 warning). */
  transliterated: [string, string][];
}

function byteOf(cp: number): number | undefined {
  if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return HIGH[cp];
}

/** Encodes `text` as Windows-1252 (NFC first, then transliteration, then "?" for the rest). */
export function encodeCp1252(text: string): AnsiResult {
  const out: number[] = [];
  const unmappable = new Set<string>();
  const replaced = new Map<string, string>();
  for (const ch of text.normalize("NFC")) {
    const cp = ch.codePointAt(0) as number;
    const direct = byteOf(cp);
    if (direct !== undefined) {
      out.push(direct);
      continue;
    }
    const alt = ANSI_TRANSLITERATION[ch];
    if (alt !== undefined) {
      for (const a of alt) out.push(byteOf(a.codePointAt(0) as number) ?? 0x3f);
      replaced.set(ch, alt);
      continue;
    }
    // Decomposed fallback: a base letter plus combining marks (e.g. "ș" → "s").
    const base = ch.normalize("NFD").replace(/\p{M}+/gu, "");
    const baseByte = base.length === 1 ? byteOf(base.codePointAt(0) as number) : undefined;
    if (baseByte !== undefined) {
      out.push(baseByte);
      replaced.set(ch, base);
      continue;
    }
    unmappable.add(ch);
    out.push(0x3f);
  }
  return { bytes: Uint8Array.from(out), unmappable: [...unmappable], transliterated: [...replaced] };
}

/** Decodes Windows-1252 bytes (tests, DATEV round trips). */
export function decodeCp1252(bytes: Uint8Array): string {
  return new TextDecoder("windows-1252").decode(bytes);
}
