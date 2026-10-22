import { describe, expect, test } from "vitest";
import { captureImageQuality, IMAGE_QUALITY_MESSAGE, imageQuality, imageSize } from "./image-quality";

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const le24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const str = (s: string) => [...s].map((c) => c.charCodeAt(0));

const png = (w: number, h: number) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...str("IHDR"),
    ...be32(w),
    ...be32(h),
    8,
    2,
    0,
    0,
    0,
  ]);
/** SOI, APP0 JFIF (72 dpi — ignored), SOF0 with the size. */
const jpeg = (w: number, h: number) =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...be16(16),
    ...str("JFIF"),
    0,
    1,
    1,
    1,
    ...be16(72),
    ...be16(72),
    0,
    0,
    0xff,
    0xc0,
    ...be16(17),
    8,
    ...be16(h),
    ...be16(w),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
const webp = (w: number, h: number) =>
  new Uint8Array([
    ...str("RIFF"),
    0,
    0,
    0,
    0,
    ...str("WEBP"),
    ...str("VP8X"),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...le24(w - 1),
    ...le24(h - 1),
  ]);

describe("image quality check (VOU-124, GOBD-08)", () => {
  test("VOU-124 T06-138 the pixel size is read from PNG, JPEG and WebP headers; other types are not measured", () => {
    expect(imageSize(png(4032, 3024), "image/png")).toEqual({ width: 4032, height: 3024 });
    expect(imageSize(jpeg(800, 1200), "image/jpeg")).toEqual({ width: 800, height: 1200 });
    expect(imageSize(webp(1500, 2000), "image/webp")).toEqual({ width: 1500, height: 2000 });
    expect(imageSize(new Uint8Array([1, 2, 3]), "image/jpeg")).toBeNull();
    expect(captureImageQuality(new TextEncoder().encode("%PDF-1.4"), "application/pdf")).toBeUndefined();
  });

  test("VOU-124 T06-138 short side < 1000 px or estimated < 150 dpi (long side against A4) warns „Bildqualität niedrig“", () => {
    // A phone photo: fine (embedded 72 dpi tags are ignored).
    expect(captureImageQuality(jpeg(3024, 4032), "image/jpeg")?.low).toBe(false);
    // Short side below 1000 px.
    const small = imageQuality({ width: 800, height: 1200 });
    expect(small).toEqual({ width: 800, height: 1200, estimatedDpi: 103, low: true });
    // Short side ≥ 1000 px but only ~137 dpi on an A4 page.
    expect(imageQuality({ width: 1200, height: 1600 })).toMatchObject({ estimatedDpi: 137, low: true });
    // 1240 × 1754 px is exactly A4 at 150 dpi.
    expect(imageQuality({ width: 1240, height: 1754 })).toMatchObject({ estimatedDpi: 150, low: false });
    expect(IMAGE_QUALITY_MESSAGE(small)).toBe(
      "Bildqualität niedrig (800 × 1200 Pixel, ca. 103 dpi). Der Beleg ist möglicherweise nicht vollständig lesbar – bitte neu aufnehmen.",
    );
  });
});
