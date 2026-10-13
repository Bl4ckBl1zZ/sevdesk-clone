/**
 * Eigenbeleg PDF (F07 BNK-060, CSH-024/025). Plain A4 page with the standard Helvetica font (WinAnsi covers German
 * umlauts, ß and €), built with pdf-lib so it runs in the default Convex runtime. Deterministic: the PDF dates are
 * the passed `createdAt`, so the same input yields the same bytes and sha256.
 */
import { PDFDocument, rgb, StandardFonts } from "@cantoo/pdf-lib";
import type { EigenbelegContent } from "../domain/banking/eigenbeleg";

/** WinAnsi cannot encode U+2212 and a few typographic characters; replace them with their ASCII look-alikes. */
const winAnsi = (s: string) =>
  s
    .replace(/−/g, "-")
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[^\t\n\r -ÿ€–—…•]/g, "?");

function wrap(text: string, width: number, measure: (s: string) => number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (measure(next) > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export async function renderEigenbeleg(
  content: EigenbelegContent,
  company: { name: string; address?: string },
  createdAt: number,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const when = new Date(createdAt);
  doc.setTitle(`Eigenbeleg – ${content.title}`);
  doc.setAuthor(winAnsi(company.name));
  doc.setCreator("Rechnungen");
  doc.setProducer("Rechnungen");
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const left = 56;
  let y = 780;
  const text = (s: string, size: number, f = font, x = left) => {
    page.drawText(winAnsi(s), { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
  };
  text(company.name, 11, bold);
  y -= 14;
  if (company.address) {
    text(company.address, 9);
    y -= 14;
  }
  y -= 30;
  text("Eigenbeleg", 20, bold);
  y -= 24;
  text(content.title, 13);
  y -= 36;
  for (const [label, value] of content.rows) {
    text(label, 10, bold);
    const lines = wrap(winAnsi(value), 330, (s) => font.widthOfTextAtSize(s, 10));
    for (const [i, l] of lines.entries()) {
      if (i > 0) y -= 13;
      text(l, 10, font, left + 150);
    }
    y -= 20;
  }
  y -= 16;
  for (const l of wrap(winAnsi(content.statement), 480, (s) => font.widthOfTextAtSize(s, 9))) {
    text(l, 9);
    y -= 12;
  }
  y -= 50;
  page.drawLine({ start: { x: left, y }, end: { x: left + 220, y }, thickness: 0.5, color: rgb(0.3, 0.3, 0.3) });
  y -= 12;
  text("Unterschrift", 8);
  return doc.save({ useObjectStreams: false });
}
