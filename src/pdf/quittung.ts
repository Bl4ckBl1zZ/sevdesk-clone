/**
 * Quittung PDF (F05 PAY-063, F07 CSH-028): A5 landscape page with the standard Helvetica font, built with pdf-lib so
 * it runs in the default Convex runtime. Deterministic for the same content (PDF dates = the payment date), so the
 * archived original has a stable sha256; a reprint carries the „Kopie“ stamp (EC-PAY-51).
 */
import { degrees, PDFDocument, rgb, StandardFonts } from "@cantoo/pdf-lib";
import type { QuittungContent } from "../domain/payments/quittung";

const winAnsi = (s: string) =>
  s
    .replace(/−/g, "-")
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[^\t\n\r -ÿ€–—…•]/g, "?");

function wrap(text: string, width: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/)) {
    const next = line ? `${line} ${w}` : w;
    if (measure(next) > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export async function renderQuittung(content: QuittungContent, opts: { copy: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const dateRow = content.rows.find(([k]) => k === "Datum")?.[1] ?? "01.01.2000";
  const [dd, mm, yyyy] = dateRow.split(".").map(Number) as [number, number, number];
  const when = new Date(Date.UTC(yyyy, mm - 1, dd, 12));
  doc.setTitle(`${content.title}${opts.copy ? " (Kopie)" : ""}`);
  doc.setAuthor(winAnsi(content.company.name));
  doc.setCreator("Rechnungen");
  doc.setProducer("Rechnungen");
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  const page = doc.addPage([595.28, 419.53]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const left = 48;
  let y = 380;
  const text = (s: string, size: number, f = font, x = left) =>
    page.drawText(winAnsi(s), { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
  text(content.company.name, 11, bold);
  y -= 13;
  if (content.company.address) {
    text(content.company.address, 9);
    y -= 13;
  }
  const ids = [
    content.company.taxNumber ? `Steuernummer ${content.company.taxNumber}` : "",
    content.company.vatId ? `USt-IdNr. ${content.company.vatId}` : "",
  ].filter(Boolean);
  if (ids.length) {
    text(ids.join(" · "), 8);
    y -= 13;
  }
  y -= 18;
  text(content.title, 20, bold);
  y -= 30;
  for (const [label, value] of content.rows) {
    text(label, 10, bold);
    const lines = wrap(winAnsi(value), 340, (s) => font.widthOfTextAtSize(s, 10));
    for (const [i, l] of lines.entries()) {
      if (i > 0) y -= 13;
      text(l, 10, font, left + 140);
    }
    y -= 18;
  }
  y -= 6;
  text(content.statement, 10, bold);
  y -= 40;
  text(content.placeDate, 9);
  page.drawLine({ start: { x: left + 260, y }, end: { x: left + 480, y }, thickness: 0.5, color: rgb(0.3, 0.3, 0.3) });
  y -= 12;
  text("Unterschrift Zahlungsempfänger", 8, font, left + 260);
  y -= 22;
  for (const l of wrap(winAnsi(content.note), 490, (s) => font.widthOfTextAtSize(s, 7))) {
    text(l, 7);
    y -= 9;
  }
  if (opts.copy) {
    page.drawText("KOPIE", {
      x: 200,
      y: 160,
      size: 72,
      font: bold,
      color: rgb(0.8, 0.1, 0.1),
      opacity: 0.25,
      rotate: degrees(25),
    });
  }
  return doc.save({ useObjectStreams: false });
}
