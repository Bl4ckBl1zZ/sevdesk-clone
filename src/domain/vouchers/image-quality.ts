/**
 * Image quality check of captured receipts (F06 VOU-124, GOBD-08 „bildliche Übereinstimmung“ / lesbare Wiedergabe).
 *
 * The pixel dimensions are read from the file header (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X) — no decoding. A
 * capture is „Bildqualität niedrig“ when its short side is below 1000 px or its estimated resolution is below 150 dpi.
 * The resolution is **estimated** as if the long side covered an A4 page (297 mm): embedded density tags are not
 * trusted, because phone cameras write a fixed 72 dpi that says nothing about the receipt. HEIC/TIFF/PDF are not
 * measured (no warning). Technical quality thresholds, not tax law. Pure.
 */

export const MIN_SHORT_SIDE_PX = 1000;
export const MIN_ESTIMATED_DPI = 150;
/** A4 long side in inches (297 mm). */
const A4_LONG_INCH = 297 / 25.4;

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageQuality extends ImageSize {
  /** Estimated dpi (long side against A4), rounded. */
  estimatedDpi: number;
  low: boolean;
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u32be = (b: Uint8Array, i: number) => u16be(b, i) * 65_536 + u16be(b, i + 2);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

function jpegSize(b: Uint8Array): ImageSize | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers without a length
      continue;
    }
    const len = u16be(b, i + 2);
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  const chunk = ascii(b, 12, 16);
  if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (chunk === "VP8L" && b[20] === 0x2f) {
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  return null;
}

const u32le = (b: Uint8Array, i: number) => (u16le(b, i) | (u16le(b, i + 2) << 16)) >>> 0;

/** Pixel size from the header of a PNG, JPEG or WebP; null for other types or broken headers. */
export function imageSize(bytes: Uint8Array, mime: string): ImageSize | null {
  let s: ImageSize | null = null;
  if (mime === "image/png" && ascii(bytes, 12, 16) === "IHDR")
    s = { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  else if (mime === "image/jpeg") s = jpegSize(bytes);
  else if (mime === "image/webp") s = webpSize(bytes);
  return s && s.width > 0 && s.height > 0 ? s : null;
}

/** VOU-124 verdict for a measured image. */
export function imageQuality(size: ImageSize): ImageQuality {
  const short = Math.min(size.width, size.height);
  const long = Math.max(size.width, size.height);
  const estimatedDpi = Math.round(long / A4_LONG_INCH);
  return { ...size, estimatedDpi, low: short < MIN_SHORT_SIDE_PX || estimatedDpi < MIN_ESTIMATED_DPI };
}

/** The stored quality of a captured file, or undefined when the type is not measured. */
export function captureImageQuality(bytes: Uint8Array, mime: string): ImageQuality | undefined {
  const s = imageSize(bytes, mime);
  return s ? imageQuality(s) : undefined;
}

export const IMAGE_QUALITY_MESSAGE = (q: Pick<ImageQuality, "width" | "height" | "estimatedDpi">) =>
  `Bildqualität niedrig (${q.width} × ${q.height} Pixel, ca. ${q.estimatedDpi} dpi). Der Beleg ist möglicherweise nicht vollständig lesbar – bitte neu aufnehmen.`;

/** Spread helper for capture records: `{ image }` when the file is a measured image, else `{}`. */
export function withImageQuality(bytes: Uint8Array, mime: string): { image?: ImageQuality } {
  const image = captureImageQuality(bytes, mime);
  return image ? { image } : {};
}
