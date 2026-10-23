import { type Issue, issue } from "../result";

/**
 * F01 SET-077 (MISC-10): the layout accent colour is used for headings and lines on a white page. WCAG 2.x requires
 * ≥ 3:1 for large text and graphical objects; below that the settings show a warning — never blocking.
 */
export const ACCENT_MIN_CONTRAST = 3;

const HEX = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/;

function luminance(hex: string): number | null {
  const m = HEX.exec(hex);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = Number.parseInt(h as string, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1…21) of two `#RRGGBB` colours; NaN for an invalid colour. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return Number.NaN;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function accentContrastWarning(accentColor: string): Issue<"accent_contrast_low"> | null {
  const ratio = contrastRatio(accentColor, "#FFFFFF");
  if (Number.isNaN(ratio) || ratio >= ACCENT_MIN_CONTRAST) return null;
  const shown = (Math.floor(ratio * 10) / 10).toFixed(1).replace(".", ",");
  return issue(
    "accent_contrast_low",
    `Die Akzentfarbe hat auf Weiß nur einen Kontrast von ${shown}:1 (empfohlen mindestens 3:1) – Überschriften und Linien sind schlecht lesbar.`,
    { ratio: shown },
  );
}
