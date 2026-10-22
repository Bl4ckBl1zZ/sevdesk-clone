/**
 * Rendition of an e-mail without attachment (F06 INB-007, EC-INB-21; GOBD-07/08): the raw `.eml` stays the original,
 * this PDF only makes the message readable in the viewer. It shows From/To/Subject/Date and the plain-text body (the
 * HTML part converted to text by `parseInboundEmail` — no HTML engine, no remote content, links stay visible as text)
 * and is stamped „Darstellung der E-Mail – nicht das Original“. Built with pdf-lib and the standard Helvetica font
 * (runs in the Convex runtime); deterministic for the same input and `createdAt`.
 */
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "@cantoo/pdf-lib";

export const MAIL_RENDITION_STAMP = "Darstellung der E-Mail – nicht das Original";
const MAX_PAGES = 20;

export interface MailRenditionInput {
  from?: string;
  to?: string;
  subject?: string;
  /** ISO 8601. */
  date?: string;
  text: string;
}

/** WinAnsi cannot encode every character; replace the common typographic ones, drop the rest to "?". */
const winAnsi = (s: string) =>
  s
    .replace(/−/g, "-")
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/\t/g, "  ")
    .replace(/[^\n\r -ÿ€–—…•]/g, "?");

/** Word wrap; words wider than the line are broken hard (long URLs). */
function wrap(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/ +/)) {
      let w = word;
      while (measure(w) > width) {
        let cut = w.length - 1;
        while (cut > 1 && measure(w.slice(0, cut)) > width) cut--;
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const next = line ? `${line} ${w}` : w;
      if (measure(next) > width && line) {
        out.push(line);
        line = w;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

const germanDateTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" }).format(
        d,
      );
};

export async function renderMailRendition(mail: MailRenditionInput, createdAt: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const when = new Date(createdAt);
  doc.setTitle(winAnsi(`E-Mail: ${mail.subject ?? "(ohne Betreff)"}`));
  doc.setCreator("Rechnungen");
  doc.setProducer("Rechnungen");
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const left = 56;
  const width = 483;
  let page: PDFPage = doc.addPage([595.28, 841.89]);
  let y = 790;
  const draw = (s: string, size: number, f: PDFFont = font, color = rgb(0.1, 0.1, 0.1)) => {
    page.drawText(s, { x: left, y, size, font: f, color });
  };
  const stamp = () => {
    draw(MAIL_RENDITION_STAMP, 9, bold, rgb(0.6, 0.1, 0.1));
    y -= 22;
  };
  stamp();
  const header: [string, string | undefined][] = [
    ["Von", mail.from],
    ["An", mail.to],
    ["Betreff", mail.subject],
    ["Datum", mail.date ? germanDateTime(mail.date) : undefined],
  ];
  for (const [label, value] of header) {
    if (!value) continue;
    for (const l of wrap(winAnsi(`${label}: ${value}`), width, (s) => bold.widthOfTextAtSize(s, 10))) {
      draw(l, 10, bold);
      y -= 14;
    }
  }
  y -= 10;
  page.drawLine({ start: { x: left, y }, end: { x: left + width, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  y -= 18;
  const body = mail.text.trim() ? mail.text : "(Die E-Mail enthält keinen Text.)";
  for (const l of wrap(winAnsi(body), width, (s) => font.widthOfTextAtSize(s, 9))) {
    if (y < 56) {
      if (doc.getPageCount() >= MAX_PAGES) {
        draw("… (gekürzt – vollständiger Inhalt im Original, der .eml-Datei)", 9, bold);
        break;
      }
      page = doc.addPage([595.28, 841.89]);
      y = 790;
      stamp();
    }
    if (l) draw(l, 9);
    y -= 12;
  }
  return doc.save({ useObjectStreams: false });
}
