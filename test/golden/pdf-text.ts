/**
 * PDF text for the golden files (07 §4 `expected.pdf.txt`): pdfjs text items grouped into visual lines (top to
 * bottom, left to right), items of one line joined by " | " when separated by a gap (columns), glued when split by kerning. The PDF carries no clock
 * values in its text, so no further normalisation is needed.
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

interface Item {
  readonly str: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

export async function pdfText(bytes: Uint8Array): Promise<string> {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const items: Item[] = [];
    for (const it of content.items) {
      if (!("str" in it) || it.str.trim() === "") continue;
      items.push({
        str: it.str.trim(),
        x: it.transform[4] as number,
        y: Math.round(it.transform[5] as number),
        width: it.width,
      });
    }
    const lines = new Map<number, Item[]>();
    for (const it of items) {
      const key = [...lines.keys()].find((y) => Math.abs(y - it.y) <= 2) ?? it.y;
      lines.set(key, [...(lines.get(key) ?? []), it]);
    }
    const text = [...lines.entries()]
      .sort(([a], [b]) => b - a)
      .map(([, line]) =>
        line
          .sort((a, b) => a.x - b.x)
          .reduce((acc, it, i, all) => {
            const prev = all[i - 1];
            // Runs split by kerning continue the word; real gaps separate columns.
            if (!prev) return it.str;
            return acc + (it.x - (prev.x + prev.width) < 1.5 ? "" : " | ") + it.str;
          }, ""),
      );
    pages.push(`--- page ${p} ---\n${text.join("\n")}`);
  }
  await task.destroy();
  return `${pages.join("\n")}\n`;
}
