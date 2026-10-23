/**
 * Receivables letters (F05 PAY-005, PAY-048, DUN-028, DUN-044) as A4 PDF: DIN 5008-like layout (sender line and
 * address window, info block, subject, text, table or fact list, closing) with the three-column Geschäftsbrief footer
 * on every page (MAIL-03). Built with pdf-lib and the standard Helvetica font so it runs in the default Convex
 * runtime (like the Quittung, `quittung.ts`). Deterministic for the same content (PDF dates = the letter date), so
 * the archived original has a stable sha256. Content comes from `src/domain/receivables/letter.ts`.
 */
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "@cantoo/pdf-lib";
import type { LetterContent } from "../domain/receivables/letter";

const A4: [number, number] = [595.28, 841.89];
const MM = 72 / 25.4;
const LEFT = 25 * MM;
const RIGHT = A4[0] - 20 * MM;
const WIDTH = RIGHT - LEFT;
const FOOTER_TOP = 32 * MM;
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.35, 0.35, 0.35);

/** WinAnsi-safe text for the standard fonts (NBSP and typographic quotes kept where WinAnsi has them). */
export const winAnsi = (s: string) =>
  s
    .replace(/[−–]/g, "–")
    .replace(/[  ]/g, " ")
    .replace(/[^\t\n\r -ÿ€–—…•‚„“”‘’]/g, "?");

function wrap(text: string, width: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const w of para.split(/ +/)) {
      const next = line ? `${line} ${w}` : w;
      if (measure(next) > width && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  y: number;
  content: LetterContent;
}

function drawFooter(c: Ctx, page: PDFPage) {
  const colWidth = WIDTH / 3;
  page.drawLine({
    start: { x: LEFT, y: FOOTER_TOP },
    end: { x: RIGHT, y: FOOTER_TOP },
    thickness: 0.4,
    color: MUTED,
  });
  c.content.footer.forEach((col, i) => {
    let y = FOOTER_TOP - 10;
    for (const line of col) {
      for (const l of wrap(winAnsi(line), colWidth - 6, (s) => c.font.widthOfTextAtSize(s, 6.5))) {
        page.drawText(l, { x: LEFT + i * colWidth, y, size: 6.5, font: c.font, color: MUTED });
        y -= 8;
      }
    }
  });
}

function newPage(c: Ctx) {
  c.page = c.doc.addPage(A4);
  drawFooter(c, c.page);
  c.y = A4[1] - 20 * MM;
}

function ensure(c: Ctx, height: number) {
  if (c.y - height < FOOTER_TOP + 12) newPage(c);
}

function text(c: Ctx, s: string, opts: { size?: number; bold?: boolean; x?: number; color?: typeof INK } = {}) {
  c.page.drawText(winAnsi(s), {
    x: opts.x ?? LEFT,
    y: c.y,
    size: opts.size ?? 10,
    font: opts.bold ? c.bold : c.font,
    color: opts.color ?? INK,
  });
}

function paragraph(c: Ctx, s: string, size = 10) {
  for (const l of wrap(winAnsi(s), WIDTH, (x) => c.font.widthOfTextAtSize(x, size))) {
    ensure(c, size + 4);
    text(c, l, { size });
    c.y -= size + 4;
  }
  c.y -= 6;
}

function table(c: Ctx, t: NonNullable<LetterContent["table"]>) {
  const total = t.columns.reduce((s, col) => s + col.width, 0);
  const widths = t.columns.map((col) => (col.width / total) * WIDTH);
  const xs = widths.map((_, i) => LEFT + widths.slice(0, i).reduce((s, w) => s + w, 0));
  const size = 8.5;
  const cell = (value: string, i: number, f: PDFFont) => {
    const col = t.columns[i];
    const w = widths[i] ?? 0;
    let v = winAnsi(value);
    while (v.length > 1 && f.widthOfTextAtSize(v, size) > w - 4) v = `${v.slice(0, -2)}…`;
    const x = col?.align === "right" ? (xs[i] ?? 0) + w - 2 - f.widthOfTextAtSize(v, size) : (xs[i] ?? 0);
    c.page.drawText(v, { x, y: c.y, size, font: f, color: INK });
  };
  const header = () => {
    ensure(c, 30);
    t.columns.forEach((col, i) => {
      cell(col.label, i, c.bold);
    });
    c.y -= 4;
    c.page.drawLine({ start: { x: LEFT, y: c.y }, end: { x: RIGHT, y: c.y }, thickness: 0.4, color: MUTED });
    c.y -= size + 4;
  };
  header();
  t.rows.forEach((row, r) => {
    if (c.y - (size + 4) < FOOTER_TOP + 12) {
      newPage(c);
      header();
    }
    const f = t.bold?.includes(r) ? c.bold : c.font;
    row.forEach((v, i) => {
      cell(v, i, f);
    });
    c.y -= size + 4;
  });
  c.y -= 8;
}

export async function renderLetter(content: LetterContent): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const [yyyy, mm, dd] = content.date.split("-").map(Number) as [number, number, number];
  const when = new Date(Date.UTC(yyyy, mm - 1, dd, 12));
  doc.setTitle(winAnsi(content.title));
  doc.setSubject(winAnsi(content.subject));
  doc.setAuthor(winAnsi(content.footer[0][0] ?? ""));
  doc.setCreator("Rechnungen");
  doc.setProducer("Rechnungen");
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const c: Ctx = { doc, page: doc.addPage(A4), font, bold, y: 0, content };
  drawFooter(c, c.page);
  // address window (DIN 5008 form B: 45 mm from the top, 20 mm from the left edge of the window)
  c.y = A4[1] - 50 * MM;
  text(c, content.senderLine, { size: 7, color: MUTED });
  c.y -= 14;
  for (const l of content.recipient) {
    text(c, l, { size: 10 });
    c.y -= 12;
  }
  // info block right of the window
  let infoY = A4[1] - 50 * MM;
  for (const [label, value] of content.meta) {
    c.page.drawText(winAnsi(label), { x: LEFT + 110 * MM, y: infoY, size: 8, font, color: MUTED });
    c.page.drawText(winAnsi(value), { x: LEFT + 135 * MM, y: infoY, size: 8, font, color: INK });
    infoY -= 11;
  }
  c.y = A4[1] - 103 * MM;
  for (const l of wrap(winAnsi(content.subject), WIDTH, (s) => bold.widthOfTextAtSize(s, 11))) {
    text(c, l, { size: 11, bold: true });
    c.y -= 15;
  }
  c.y -= 8;
  for (const p of content.paragraphs) paragraph(c, p);
  if (content.table) table(c, content.table);
  if (content.facts) {
    for (const [label, value] of content.facts) {
      const lines = wrap(winAnsi(value), WIDTH - 55 * MM, (s) => font.widthOfTextAtSize(s, 9.5));
      ensure(c, lines.length * 13 + 4);
      text(c, label, { size: 9.5, bold: true });
      lines.forEach((l, i) => {
        if (i > 0) c.y -= 13;
        text(c, l, { size: 9.5, x: LEFT + 55 * MM });
      });
      c.y -= 16;
    }
    c.y -= 4;
  }
  for (const p of content.closing) paragraph(c, p);
  return doc.save({ useObjectStreams: false });
}
