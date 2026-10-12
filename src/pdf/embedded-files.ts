/**
 * Reads the embedded files of a PDF (INV-21 / T-INV-016: the XML extracted from the hybrid PDF must be byte-equal to
 * the archived XML). Walks the catalog `/Names /EmbeddedFiles` name tree and the document-level `/AF` array.
 */
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
} from "@cantoo/pdf-lib";

export interface EmbeddedFile {
  readonly name: string;
  readonly afRelationship: string | null;
  readonly subtype: string | null;
  readonly bytes: Uint8Array;
}

const text = (o: unknown): string | null =>
  o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o instanceof PDFName ? o.decodeText() : null;

export async function readEmbeddedFiles(pdf: Uint8Array): Promise<EmbeddedFile[]> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const tree = names?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
  const out: EmbeddedFile[] = [];
  const visit = (node: PDFDict) => {
    const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i++) visit(kids.lookup(i, PDFDict));
    const pairs = node.lookupMaybe(PDFName.of("Names"), PDFArray);
    if (!pairs) return;
    for (let i = 0; i + 1 < pairs.size(); i += 2) {
      const spec = pairs.lookup(i + 1, PDFDict);
      const ef = spec.lookup(PDFName.of("EF"), PDFDict);
      const stream = ef.lookup(PDFName.of("F"));
      if (!(stream instanceof PDFRawStream)) continue;
      out.push({
        name: text(spec.lookup(PDFName.of("UF"))) ?? text(spec.lookup(PDFName.of("F"))) ?? text(pairs.lookup(i)) ?? "",
        afRelationship: text(spec.lookup(PDFName.of("AFRelationship"))),
        subtype: text(stream.dict.lookup(PDFName.of("Subtype"))),
        bytes: decodePDFRawStream(stream).decode(),
      });
    }
  };
  if (tree) visit(tree);
  return out;
}
