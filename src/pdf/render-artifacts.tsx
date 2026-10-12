/**
 * renderArtifacts (F04 §4.5 step 3, §4.10.2, ER-03, DOC-30/32): snapshot + layout → archived bytes.
 *
 *   zugferd_en16931 / zugferd_xrechnung → hybrid PDF/A-3b with the CII embedded as Factur-X (`factur-x.xml` /
 *     `xrechnung.xml`, AFRelationship Alternative, fx: XMP) — kind `zugferd_pdf`; the identical XML is returned for
 *     the optional separate download.
 *   xrechnung_ubl / xrechnung_cii      → XML is the invoice (kind `xrechnung_xml`); the PDF is the "Lesefassung".
 *   none (KU default, non-invoice types, drafts) → plain PDF/A-3b, kind `pdf`.
 *
 * Deterministic: the same snapshot, layout, variant, logo and `createdAt` give byte-identical output (sha256 is the
 * archive hash, GOBD). `createdAt` defaults to the document date (00:00 UTC); the invoice slice passes the
 * finalisation time.
 */
import { AFRelationship, embedFacturX, PDFDocument } from "@cantoo/pdf-lib";
import { renderToBuffer } from "@react-pdf/renderer";
import {
  buildRenderModel,
  DEFAULT_LAYOUT,
  type RenderLayout,
  type RenderVariant,
} from "@/domain/documents/render-model";
import type { DocumentSnapshot } from "@/domain/documents/snapshot";
import { artifactKindFor } from "@/domain/einvoice/format";
import { type SerializedEinvoice, serializeEinvoice } from "@/domain/einvoice/serialize";
import { registerPdfFonts } from "./fonts";
import { type PdfLogo, SalesDocument } from "./sales-document";

export type ArtifactKind = "zugferd_pdf" | "xrechnung_xml" | "pdf";

export interface RenderArtifactsOptions {
  readonly logo?: PdfLogo | null;
  /** PDF CreationDate/ModDate and attachment dates; default `documentDate`T00:00:00Z. */
  readonly createdAt?: Date;
}

export interface RenderedArtifacts {
  /** Primary artifact kind (03 `documentArtifacts.kind`). */
  readonly kind: ArtifactKind;
  /** Hybrid PDF (zugferd_pdf), plain PDF (pdf) or the Lesefassung (xrechnung_xml). */
  readonly pdf: Uint8Array;
  /** `documentArtifacts.variant` of the PDF. */
  readonly pdfVariant: "original" | "copy" | "reading";
  /** E-invoice XML (embedded one for ZUGFeRD; the invoice itself for XRechnung). */
  readonly xml?: Uint8Array;
  /** sha256 (hex) of the primary artifact: the XML for XRechnung, else the PDF. */
  readonly sha256: string;
  readonly pdfSha256: string;
  readonly xmlSha256?: string;
  /** Export file names per §4.10.2 (`/` → `-`). */
  readonly fileNames: { readonly pdf: string; readonly xml?: string };
  readonly einvoice?: Pick<SerializedEinvoice, "format" | "syntax" | "profile" | "embeddedFileName">;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Renders the PDF/A-3b document for the model (no e-invoice). */
export async function renderPdf(
  snapshot: DocumentSnapshot,
  layout: RenderLayout,
  variant: RenderVariant,
  options: RenderArtifactsOptions = {},
): Promise<Uint8Array> {
  registerPdfFonts();
  const createdAt = options.createdAt ?? new Date(`${snapshot.documentDate}T00:00:00Z`);
  const model = buildRenderModel(snapshot, layout, variant);
  const buffer = await renderToBuffer(
    <SalesDocument model={model} logo={options.logo ?? null} createdAt={createdAt} />,
  );
  return new Uint8Array(buffer);
}

/** Embeds the CII into the PDF/A-3b as Factur-X/ZUGFeRD (fx: XMP, AFRelationship Alternative). */
export async function embedEinvoice(
  pdf: Uint8Array,
  einvoice: SerializedEinvoice,
  createdAt: Date,
): Promise<Uint8Array> {
  if (einvoice.syntax !== "CII" || !einvoice.embeddedFileName) throw new Error("only CII can be embedded (Factur-X)");
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  await embedFacturX(doc, new TextEncoder().encode(einvoice.xml), {
    fileName: einvoice.embeddedFileName,
    conformanceLevel: einvoice.profile === "xrechnung" ? "XRECHNUNG" : "EN 16931",
    afRelationship: AFRelationship.Alternative,
    description: einvoice.profile === "xrechnung" ? "XRechnung (CII)" : "Factur-X/ZUGFeRD EN 16931 invoice",
    creationDate: createdAt,
    modificationDate: createdAt,
  });
  doc.setCreationDate(createdAt);
  doc.setModificationDate(createdAt);
  return doc.save();
}

const fileStem = (number: string) => number.replaceAll("/", "-");

export async function renderArtifacts(
  snapshot: DocumentSnapshot,
  layout: RenderLayout = DEFAULT_LAYOUT,
  variant: RenderVariant = "original",
  options: RenderArtifactsOptions = {},
): Promise<RenderedArtifacts> {
  const createdAt = options.createdAt ?? new Date(`${snapshot.documentDate}T00:00:00Z`);
  const format = variant === "draft" ? "none" : snapshot.einvoice.format;
  const kind = artifactKindFor(format);
  const stem = fileStem(snapshot.number);

  if (format === "none") {
    const pdf = await renderPdf(snapshot, layout, variant, { ...options, createdAt });
    const pdfSha256 = await sha256Hex(pdf);
    return {
      kind,
      pdf,
      pdfVariant: variant === "copy" ? "copy" : "original",
      sha256: pdfSha256,
      pdfSha256,
      fileNames: { pdf: `${stem}.pdf` },
    };
  }

  const einvoice = serializeEinvoice(snapshot, format);
  const xml = new TextEncoder().encode(einvoice.xml);
  const xmlSha256 = await sha256Hex(xml);
  const meta = {
    format: einvoice.format,
    syntax: einvoice.syntax,
    profile: einvoice.profile,
    embeddedFileName: einvoice.embeddedFileName,
  };

  if (kind === "xrechnung_xml") {
    const pdfVariant = variant === "copy" ? "copy" : "reading";
    const pdf = await renderPdf(snapshot, layout, pdfVariant, { ...options, createdAt });
    return {
      kind,
      pdf,
      pdfVariant,
      xml,
      sha256: xmlSha256,
      pdfSha256: await sha256Hex(pdf),
      xmlSha256,
      fileNames: { pdf: `${stem}_Lesefassung.pdf`, xml: `${stem}.xml` },
      einvoice: meta,
    };
  }

  const plain = await renderPdf(snapshot, layout, variant, { ...options, createdAt });
  const pdf = await embedEinvoice(plain, einvoice, createdAt);
  const pdfSha256 = await sha256Hex(pdf);
  return {
    kind,
    pdf,
    pdfVariant: variant === "copy" ? "copy" : "original",
    xml,
    sha256: pdfSha256,
    pdfSha256,
    xmlSha256,
    fileNames: { pdf: `${stem}.pdf`, xml: `${stem}.xml` },
    einvoice: meta,
  };
}
