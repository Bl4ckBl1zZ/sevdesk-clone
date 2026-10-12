/**
 * Embedded fonts for PDF/A-3b (ADR-006: "registered TTF fonts — Inter; Noto Sans fallback"; F01 SET-071 font
 * choice inter / noto / source-serif). Registered once per process from the generated base64 module, so rendering
 * needs no file-system access. Hyphenation is disabled: German compound words must not be split by the English
 * default hyphenator.
 */
import { Font } from "@react-pdf/renderer";
import type { RenderLayout } from "@/domain/documents/render-model";
import { FONT_DATA } from "./fonts/data.generated";

type FontFile = keyof typeof FONT_DATA;

const src = (file: FontFile) => `data:font/ttf;base64,${FONT_DATA[file].base64}`;

let registered = false;

export function registerPdfFonts(): void {
  if (registered) return;
  Font.register({
    family: "Inter",
    fonts: [
      { src: src("Inter-Regular.ttf"), fontWeight: 400 },
      { src: src("Inter-Bold.ttf"), fontWeight: 700 },
      { src: src("Inter-Italic.ttf"), fontWeight: 400, fontStyle: "italic" },
    ],
  });
  Font.register({
    family: "NotoSans",
    fonts: [
      { src: src("NotoSans-Regular.ttf"), fontWeight: 400 },
      { src: src("NotoSans-Bold.ttf"), fontWeight: 700 },
    ],
  });
  Font.register({
    family: "SourceSerif",
    fonts: [
      { src: src("SourceSerif4-Regular.ttf"), fontWeight: 400 },
      { src: src("SourceSerif4-Bold.ttf"), fontWeight: 700 },
    ],
  });
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

/** Font stack per layout font; Noto Sans is the glyph fallback (EC-DOC-80: still missing glyphs print as "□"). */
export function fontStack(font: RenderLayout["font"]): string[] {
  if (font === "noto") return ["NotoSans", "Inter"];
  if (font === "source-serif") return ["SourceSerif", "NotoSans"];
  return ["Inter", "NotoSans"];
}
