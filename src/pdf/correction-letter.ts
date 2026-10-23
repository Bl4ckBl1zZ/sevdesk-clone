/**
 * „Bitte um Rechnungskorrektur“ as PDF (F06 INB-046): the letter text from src/domain/inbox/correction-request.ts on
 * A4 (DIN 5008-like margins), Helvetica, pdf-lib (runs in the Convex runtime). Archived once with SHA-256 as
 * `documentArtifacts` kind `supplier_correction_letter` (retention `letters6`). Deterministic for text + `createdAt`.
 */
import { PDFDocument, rgb, StandardFonts } from "@cantoo/pdf-lib";
import { winAnsi, wrap } from "./mail-rendition";

const MAX_PAGES = 5;

export async function renderCorrectionLetter(
  letter: { subject: string; text: string },
  createdAt: number,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const when = new Date(createdAt);
  doc.setTitle(winAnsi(letter.subject));
  doc.setCreator("Rechnungen");
  doc.setProducer("Rechnungen");
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const left = 70;
  const width = 455;
  let page = doc.addPage([595.28, 841.89]);
  let y = 780;
  for (const raw of letter.text.split("\n")) {
    const isSubject = raw === letter.subject;
    const f = isSubject ? bold : font;
    for (const l of wrap(winAnsi(raw), width, (s) => f.widthOfTextAtSize(s, 10.5))) {
      if (y < 70) {
        if (doc.getPageCount() >= MAX_PAGES) return doc.save({ useObjectStreams: false });
        page = doc.addPage([595.28, 841.89]);
        y = 780;
      }
      if (l) page.drawText(l, { x: left, y, size: 10.5, font: f, color: rgb(0.1, 0.1, 0.1) });
      y -= 14;
    }
  }
  return doc.save({ useObjectStreams: false });
}
