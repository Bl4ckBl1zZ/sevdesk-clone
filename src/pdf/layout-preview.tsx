/**
 * Layout preview PDF (F01 SET-073): a sample Rechnung, Angebot, Mahnung or Lieferschein rendered with the chosen
 * layout, the real Geschäftsbrief footer (SET-013) and the current KU status. Nothing is stored; the number is marked
 * „(Muster)“. The P1 document renderer reuses the same building blocks (header, sender line, table, footer).
 *
 * Fonts: the PDF standard fonts (Helvetica/Times) until the font files are bundled with the P1 renderer.
 */
import { Document, Image, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import {
  type FooterAccount,
  type FooterCompany,
  type GeschaeftsbriefFooter,
  geschaeftsbriefFooter,
  labelledGeschaeftsbriefFooter,
} from "@/domain/company/footer";
import { footerItems } from "@/domain/company/legal-forms";
import { footerVisible, PREVIEW_SAMPLE_TYPES, type PreviewSampleType } from "@/domain/documents/layout";
import { DEFAULT_LAYOUT, type RenderModel } from "@/domain/documents/render-model";
import { type SampleDocument, sampleDocument } from "@/domain/documents/sample";
import { formatEuro, formatMicros, formatMilli } from "@/domain/money/format";
import { registerPdfFonts } from "./fonts";
import { applyLetterhead, type LetterheadFiles } from "./letterhead";
import { SevdeskDocument } from "./sevdesk-document";

export interface LayoutPreviewData {
  today: string;
  layout: {
    name: string;
    config: {
      template: string;
      accentColor: string;
      logoPosition?: string;
      printOptions?: {
        foldMarks?: boolean;
        pageNumbers?: boolean;
        senderLine?: boolean;
        allInvoiceAccountsInFooter?: boolean;
        footerInLetterhead?: { confirmedAt: number; items: string[] } | null;
      };
    } | null;
  } | null;
  company: FooterCompany | null;
  accounts: FooterAccount[];
  kleinunternehmer: boolean;
}

export interface LayoutPreviewOptions {
  type: PreviewSampleType;
  b2b: boolean;
  /** Overrides the current KU status (preview switch); default: the company's status today. */
  ku?: boolean;
}

export interface LayoutPreviewModel {
  sample: SampleDocument;
  senderLine: string | null;
  footer: GeschaeftsbriefFooter | null;
  accentColor: string;
  serif: boolean;
  foldMarks: boolean;
  pageNumbers: boolean;
  layoutName: string;
  /** Template `sevdesk`: the sample as a `RenderModel`, so the preview shows the real design. */
  sevdesk?: RenderModel;
}

const eur = (cents: number) => formatEuro(cents).replace("€", "EUR");

/** The sample document in the terms of `SevdeskDocument`; „(Muster)“ and the preview stamp stay visible. */
function sevdeskSample(model: Omit<LayoutPreviewModel, "sevdesk">, data: LayoutPreviewData): RenderModel {
  const { sample } = model;
  const company = data.company;
  const print = data.layout?.config?.printOptions ?? {};
  const ku = sample.notes.find((n) => n.includes("§ 19"));
  const net = sample.vatLines.length > 0;
  const seller = company?.name ?? "";
  return {
    language: "de",
    variant: "original",
    title: `${sample.title} Nr.`,
    number: sample.number,
    documentDate: sample.date,
    stamp: `Vorschau · Layout „${model.layoutName}“`,
    sellerName: seller,
    ...(model.senderLine ? { senderLine: model.senderLine.replaceAll(" · ", " → ") } : {}),
    recipient: sample.recipient.map((line) => line.replace("z. Hd. Herrn ", "")),
    info: [
      { label: "Nr.", value: sample.number },
      { label: "Datum", value: sample.date },
      ...(company?.contact.name
        ? [{ label: "Ihr Ansprechpartner", value: `${company.contact.name}\n${company.contact.email}` }]
        : []),
    ],
    titleNotes: [],
    headText: sample.intro,
    columns: [
      { key: "pos", label: "", align: "left" },
      { key: "name", label: "Beschreibung", align: "left" },
      { key: "quantity", label: "Menge", align: "right" },
      ...(sample.showPrices
        ? ([
            { key: "unitPrice", label: net ? "Einzelpreis netto" : "Einzelpreis", align: "right" },
            { key: "amount", label: net ? "Gesamtpreis netto" : "Gesamtpreis", align: "right" },
          ] as const)
        : []),
    ],
    rows: sample.lines.map((l, i) => ({
      kind: "item",
      pos: `${i + 1}.`,
      name: l.name,
      description: l.description,
      quantity: `${formatMicros(l.quantityMilli * 10)} ${l.unit}`,
      unit: l.unit,
      unitPrice: `${formatMicros(l.unitPriceMicros)} EUR`,
      vat: l.rateLabel,
      discount: "",
      amount: eur(l.netCents),
      optional: false,
    })),
    totals: sample.totals
      ? [
          { label: "Gesamtbetrag netto", value: eur(sample.totals.netCents), emphasis: "band" },
          ...sample.vatLines.map((v) => ({ label: `${v.label} auf ${eur(v.baseCents)}`, value: eur(v.vatCents) })),
          ...(ku ? [{ label: ku, value: "", emphasis: "note" as const }] : []),
          { label: "Gesamtbetrag brutto", value: eur(sample.totals.grossCents), emphasis: "strong" },
        ]
      : [],
    totalsNotes: [],
    legalNotes: [],
    payment: { lines: sample.notes.filter((n) => n !== ku), epcPayload: null },
    customFields: [],
    footer: model.footer?.columns ?? null,
    ...(company && model.footer
      ? {
          labelledFooter: labelledGeschaeftsbriefFooter(company, data.accounts, {
            allInvoiceAccounts: print.allInvoiceAccountsInFooter ?? false,
          }),
        }
      : {}),
    pageLabel: { page: "Seite", of: "von" },
    layout: {
      ...DEFAULT_LAYOUT,
      template: "sevdesk",
      printOptions: { ...DEFAULT_LAYOUT.printOptions, foldMarks: model.foldMarks, pageNumbers: model.pageNumbers },
    },
    meta: { title: `${sample.title} ${sample.number}`, author: "Layout-Vorschau", subject: sample.title, keywords: [] },
  };
}

/** Pure: everything the PDF shows, derived from the preview data (tested without rendering). */
export function buildLayoutPreview(data: LayoutPreviewData, opts: LayoutPreviewOptions): LayoutPreviewModel {
  const config = data.layout?.config ?? null;
  const print = config?.printOptions ?? {};
  const company = data.company;
  const sample = sampleDocument({
    type: opts.type,
    b2b: opts.b2b,
    ku: opts.ku ?? data.kleinunternehmer,
    today: data.today,
  });
  const required = company ? ["Firma", ...footerItems(company.legalForm)] : [];
  const showFooter = footerVisible({ footerInLetterhead: print.footerInLetterhead ?? null }, required);
  const model = {
    sample,
    senderLine:
      company && print.senderLine !== false
        ? [
            company.name,
            company.address.street || company.address.poBox,
            `${company.address.postalCode} ${company.address.city}`,
          ]
            .filter(Boolean)
            .join(" · ")
        : null,
    footer:
      company && showFooter
        ? geschaeftsbriefFooter(company, data.accounts, {
            allInvoiceAccounts: print.allInvoiceAccountsInFooter ?? false,
          })
        : null,
    accentColor: config?.accentColor ?? "#16a34a",
    serif: config?.template === "classic",
    foldMarks: print.foldMarks ?? true,
    pageNumbers: print.pageNumbers ?? true,
    layoutName: data.layout?.name ?? "Standard",
  };
  return config?.template === "sevdesk" ? { ...model, sevdesk: sevdeskSample(model, data) } : model;
}

const styles = StyleSheet.create({
  page: { paddingTop: 48, paddingBottom: 110, paddingHorizontal: 56, fontSize: 9.5, color: "#111" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 },
  logo: { maxWidth: 140, maxHeight: 56, objectFit: "contain" },
  senderLine: { fontSize: 7, color: "#555", marginTop: 70, marginBottom: 4, textDecoration: "underline" },
  recipient: { minHeight: 70, marginBottom: 24 },
  meta: { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
  title: { fontSize: 16, marginBottom: 4 },
  table: { marginTop: 8, marginBottom: 12 },
  row: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: "#ddd" },
  headRow: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 1 },
  cName: { flex: 1 },
  cQty: { width: 60, textAlign: "right" },
  cPrice: { width: 70, textAlign: "right" },
  cRate: { width: 40, textAlign: "right" },
  cTotal: { width: 75, textAlign: "right" },
  description: { fontSize: 8, color: "#555" },
  totals: { alignSelf: "flex-end", width: 220, marginBottom: 12 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  note: { marginBottom: 6 },
  footer: {
    position: "absolute",
    bottom: 28,
    left: 56,
    right: 56,
    flexDirection: "row",
    gap: 12,
    fontSize: 6.5,
    color: "#444",
    borderTopWidth: 0.5,
    borderTopColor: "#bbb",
    paddingTop: 6,
  },
  footerColumn: { flex: 1 },
  foldMark: { position: "absolute", left: 18, width: 10, borderTopWidth: 0.5, borderTopColor: "#999" },
  pageNumber: { position: "absolute", bottom: 14, right: 56, fontSize: 7, color: "#666" },
  watermark: { position: "absolute", top: 18, right: 56, fontSize: 7, color: "#999" },
});

export function LayoutPreviewDocument({
  model,
  logo,
}: {
  model: LayoutPreviewModel;
  logo?: { data: Buffer; format: "png" | "jpg" } | null;
}) {
  const { sample } = model;
  const font = model.serif ? "Times-Roman" : "Helvetica";
  const bold = model.serif ? "Times-Bold" : "Helvetica-Bold";
  return (
    <Document title={`${sample.title} ${sample.number}`} author="Layout-Vorschau" language="de-DE">
      <Page size="A4" style={[styles.page, { fontFamily: font }]}>
        {model.foldMarks ? (
          <>
            <View fixed style={[styles.foldMark, { top: 297.6 }]} />
            <View fixed style={[styles.foldMark, { top: 420.9 }]} />
            <View fixed style={[styles.foldMark, { top: 595.3 }]} />
          </>
        ) : null}
        <Text fixed style={styles.watermark}>
          Vorschau · Layout „{model.layoutName}“
        </Text>
        <View style={styles.header}>
          <View>{logo ? <Image src={logo} style={styles.logo} /> : null}</View>
        </View>
        {model.senderLine ? <Text style={styles.senderLine}>{model.senderLine}</Text> : null}
        <View style={styles.recipient}>
          {sample.recipient.map((line) => (
            <Text key={line}>{line}</Text>
          ))}
        </View>
        <View style={styles.meta}>
          <View>
            <Text style={[styles.title, { fontFamily: bold, color: model.accentColor }]}>{sample.title}</Text>
            <Text>Nr. {sample.number}</Text>
          </View>
          <Text>Datum: {sample.date}</Text>
        </View>
        <Text style={styles.note}>{sample.intro}</Text>
        <View style={styles.table}>
          <View style={[styles.headRow, { borderBottomColor: model.accentColor, fontFamily: bold }]}>
            <Text style={styles.cName}>Bezeichnung</Text>
            <Text style={styles.cQty}>Menge</Text>
            {sample.showPrices ? (
              <>
                <Text style={styles.cPrice}>Einzelpreis</Text>
                <Text style={styles.cRate}>USt</Text>
                <Text style={styles.cTotal}>Gesamt</Text>
              </>
            ) : null}
          </View>
          {sample.lines.map((l) => (
            <View key={l.name} style={styles.row} wrap={false}>
              <View style={styles.cName}>
                <Text>{l.name}</Text>
                <Text style={styles.description}>{l.description}</Text>
              </View>
              <Text style={styles.cQty}>
                {formatMilli(l.quantityMilli)} {l.unit}
              </Text>
              {sample.showPrices ? (
                <>
                  <Text style={styles.cPrice}>{formatMicros(l.unitPriceMicros)} €</Text>
                  <Text style={styles.cRate}>{l.rateLabel}</Text>
                  <Text style={styles.cTotal}>{formatEuro(l.netCents)}</Text>
                </>
              ) : null}
            </View>
          ))}
        </View>
        {sample.totals ? (
          <View style={styles.totals} wrap={false}>
            <View style={styles.totalRow}>
              <Text>Summe netto</Text>
              <Text>{formatEuro(sample.totals.netCents)}</Text>
            </View>
            {sample.vatLines.map((v) => (
              <View key={v.label} style={styles.totalRow}>
                <Text>
                  {v.label} auf {formatEuro(v.baseCents)}
                </Text>
                <Text>{formatEuro(v.vatCents)}</Text>
              </View>
            ))}
            <View style={[styles.totalRow, { fontFamily: bold, borderTopWidth: 1, borderTopColor: model.accentColor }]}>
              <Text>Gesamtbetrag</Text>
              <Text>{formatEuro(sample.totals.grossCents)}</Text>
            </View>
          </View>
        ) : null}
        {sample.notes.map((n) => (
          <Text key={n} style={styles.note}>
            {n}
          </Text>
        ))}
        {model.footer ? (
          <View fixed style={styles.footer}>
            {model.footer.columns.map((col, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the three footer columns are positional
              <View key={i} style={styles.footerColumn}>
                {col.map((line) => (
                  <Text key={line}>{line}</Text>
                ))}
              </View>
            ))}
          </View>
        ) : null}
        {model.pageNumbers ? (
          <Text
            fixed
            style={styles.pageNumber}
            render={({ pageNumber, totalPages }) => `Seite ${pageNumber} von ${totalPages}`}
          />
        ) : null}
      </Page>
    </Document>
  );
}

export async function renderLayoutPreview(
  model: LayoutPreviewModel,
  logo?: { data: Buffer; format: "png" | "jpg" } | null,
  letterhead?: LetterheadFiles | null,
): Promise<Buffer> {
  if (model.sevdesk) registerPdfFonts();
  const pdf = await renderToBuffer(
    model.sevdesk ? (
      <SevdeskDocument model={model.sevdesk} logo={logo ?? null} createdAt={new Date()} />
    ) : (
      <LayoutPreviewDocument model={model} logo={logo ?? null} />
    ),
  );
  // SET-072: the uploaded letterhead is the background of the preview as well
  return letterhead ? Buffer.from(await applyLetterhead(new Uint8Array(pdf), letterhead)) : pdf;
}

/** Query string of /einstellungen/layouts/vorschau: `?typ=invoice&kunde=b2b&ku=1&layout=<id>`; unknown values fall back. */
export function parsePreviewParams(params: URLSearchParams): LayoutPreviewOptions & { layoutId?: string } {
  const typ = params.get("typ");
  const ku = params.get("ku");
  const layoutId = params.get("layout");
  return {
    type: (PREVIEW_SAMPLE_TYPES as readonly string[]).includes(typ ?? "") ? (typ as PreviewSampleType) : "invoice",
    b2b: params.get("kunde") !== "b2c",
    ...(ku === "1" || ku === "0" ? { ku: ku === "1" } : {}),
    ...(layoutId && /^[a-z0-9]{10,64}$/.test(layoutId) ? { layoutId } : {}),
  };
}
