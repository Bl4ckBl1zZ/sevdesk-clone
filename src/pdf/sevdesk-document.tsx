/**
 * The template `sevdesk` (F01 SET-071, F04 App. F): the owner's sevdesk invoice design, measured from a sevdesk PDF.
 * Like `SalesDocument` it only lays out a `RenderModel`. The two stay separate because a finalised document keeps its
 * design on every Kopie re-render (SET-E20); this file is the design of layout versions with `template: "sevdesk"`.
 * Logo right on every page, info block with small capitals, shaded table head and every second position, totals as
 * shaded bands, four labelled footer columns, page x/y. Accent colour and logo position do not apply to this design.
 */
import { Document, Image, Page, StyleSheet, type Styles, Text, View } from "@react-pdf/renderer";
import type { FooterField } from "@/domain/company/footer";
import type { RenderColumn, RenderModel, RenderRow, RenderTotalRow } from "@/domain/documents/render-model";
import { EpcQr } from "./epc-qr";
import { fontStack } from "./fonts";
import type { PdfLogo } from "./sales-document";

const LEFT = 56.7;
const RIGHT = 53.8;
const BAND_OVERHANG = 5.7;
const SHADE = "#EDEDED";
const PAGE_BOTTOM = 96;
const FOOTER_BOTTOM = 20;
const FOOTER_LINE = 11.5;
/** Characters of one line in a footer column at 7 pt bold; only used to reserve room, so on the safe side. */
const FOOTER_LINE_CHARS = 26;

/** Bottom page margin: the fixed footer grows with the legal form, and page content must stop above it (DOC-31). */
export function footerReserve(columns: readonly (readonly FooterField[])[] | undefined): number {
  const lines = (f: FooterField) =>
    f.stacked ? 2 : Math.ceil(((f.label?.length ?? 0) * 1.4 + f.value.length) / FOOTER_LINE_CHARS);
  const height = Math.max(0, ...(columns ?? []).map((c) => c.reduce((sum, f) => sum + lines(f), 0))) * FOOTER_LINE;
  return Math.max(PAGE_BOTTOM, FOOTER_BOTTOM + height + 2 * FOOTER_LINE);
}

const COLUMN_WIDTH: Record<RenderColumn["key"], number | null> = {
  pos: 22.7,
  name: null,
  quantity: 60,
  unit: 0,
  unitPrice: 71,
  vat: 36,
  discount: 0,
  amount: 71.5,
};

const s = StyleSheet.create({
  // No lineHeight on the page: react-pdf 4.9 then drops dynamic `render` texts (page x/y) and inflates rows.
  page: { paddingTop: 136, paddingLeft: LEFT, paddingRight: RIGHT, fontSize: 9, color: "#000000" },
  logo: { position: "absolute", top: 34, right: 51, width: 68, height: 68, objectFit: "contain" },
  sellerName: { position: "absolute", top: 60, right: RIGHT, fontSize: 13, fontWeight: 700 },
  stamp: { position: "absolute", top: 110, right: RIGHT, fontSize: 10, fontWeight: 700, color: "#B42318" },
  addressRow: { flexDirection: "row", minHeight: 164 },
  infoBlock: { flex: 1, paddingTop: 3 },
  window: { width: 298.6, paddingLeft: 2.8 },
  senderLine: { fontSize: 7, fontWeight: 700, marginTop: 2, marginBottom: 16 },
  recipientLine: { marginBottom: 2 },
  infoRow: { flexDirection: "row", alignItems: "center", marginBottom: 3.15 },
  infoLabel: {
    width: 100,
    fontSize: 6,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: "#404040",
    marginBottom: 2.5,
  },
  infoValue: { flex: 1, fontSize: 7, fontWeight: 700, lineHeight: 1.6 },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 14, fontWeight: 700 },
  subject: { fontWeight: 700, marginTop: 4 },
  block: { marginTop: 9, lineHeight: 1.28 },
  table: { marginTop: 14 },
  band: {
    flexDirection: "row",
    backgroundColor: SHADE,
    borderRadius: 3,
    marginHorizontal: -BAND_OVERHANG,
    paddingHorizontal: BAND_OVERHANG,
  },
  headRow: { paddingVertical: 6.5, fontWeight: 700 },
  row: {
    flexDirection: "row",
    marginHorizontal: -BAND_OVERHANG,
    paddingHorizontal: BAND_OVERHANG,
    paddingTop: 6.5,
    paddingBottom: 6.8,
    borderRadius: 3,
  },
  muted: { color: "#666666" },
  description: { marginTop: 10.5, marginBottom: 10 },
  small: { fontSize: 7, color: "#404040", marginTop: 1.5 },
  discountNote: { fontSize: 7, textAlign: "right", paddingTop: 1 },
  heading: { fontWeight: 700, paddingTop: 8, paddingBottom: 2 },
  totals: {},
  totalRow: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 6.5 },
  noteRow: { paddingVertical: 6.5 },
  paymentRow: { flexDirection: "row", justifyContent: "space-between", gap: 16, marginTop: 20 },
  paymentLine: { lineHeight: 1.28, marginBottom: 6 },
  footer: {
    position: "absolute",
    bottom: FOOTER_BOTTOM,
    left: LEFT,
    right: 24,
    flexDirection: "row",
    alignItems: "flex-end",
  },
  footerColumn: { width: 121.9 },
  footerField: { fontSize: 7, fontWeight: 700, lineHeight: FOOTER_LINE / 7 },
  footerLabel: { fontSize: 6, fontWeight: 400, letterSpacing: 1, textTransform: "uppercase", color: "#404040" },
  pageNumber: { position: "absolute", bottom: 22, right: 20, fontSize: 8.5 },
  foldMark: { position: "absolute", left: 0, borderTopWidth: 1, borderTopColor: "#262626" },
  watermark: {
    position: "absolute",
    top: 380,
    left: 0,
    right: 0,
    textAlign: "center",
    fontSize: 72,
    fontWeight: 700,
    color: "#E4E4E4",
    transform: "rotate(-30deg)",
  },
});

type Style = Styles[string];

/** The longer labels of a regular invoice („Gesamtpreis netto“) need more than sevdesk's KU columns. */
const width = (c: RenderColumn) => {
  const w = COLUMN_WIDTH[c.key];
  if (w === null) return { flex: 1 };
  return { width: c.key !== "pos" && c.label.length > 12 ? 92 : w };
};

function PositionRow({ row, columns, shaded }: { row: RenderRow; columns: readonly RenderColumn[]; shaded: boolean }) {
  if (row.kind === "subtotal") {
    return (
      <View style={[s.band, s.totalRow, { fontWeight: 700 }]} wrap={false}>
        <Text>{row.text}</Text>
        <Text>{row.amount}</Text>
      </View>
    );
  }
  if (row.kind !== "item") return <Text style={row.kind === "heading" ? s.heading : s.block}>{row.text}</Text>;
  return (
    <View style={[s.row, shaded ? { backgroundColor: SHADE } : {}, row.optional ? s.muted : {}]} wrap={false}>
      {columns.map((c) => {
        if (c.key === "name") {
          return (
            <View key={c.key} style={[width(c), { paddingRight: 4 }]}>
              <Text>{row.name}</Text>
              {row.itemNumber ? <Text style={s.small}>{row.itemNumber}</Text> : null}
              {row.description ? <Text style={s.description}>{row.description}</Text> : null}
              {row.period ? <Text style={s.small}>{row.period}</Text> : null}
            </View>
          );
        }
        if (c.key === "amount") {
          return (
            <View key={c.key} style={width(c)}>
              <Text style={{ textAlign: "right" }}>{row.amount}</Text>
              {row.discountNote ? <Text style={s.discountNote}>{row.discountNote}</Text> : null}
            </View>
          );
        }
        return (
          <Text key={c.key} style={[width(c), { textAlign: c.align }]}>
            {row[c.key]}
          </Text>
        );
      })}
    </View>
  );
}

function TotalRows({ rows }: { rows: readonly RenderTotalRow[] }) {
  return (
    <>
      {rows.map((r) => {
        const key = `${r.label}|${r.value}`;
        if (r.emphasis === "note") {
          return (
            <Text key={key} style={s.noteRow}>
              {r.label}
            </Text>
          );
        }
        const band = r.emphasis === "band" || r.emphasis === "strong";
        return (
          <View
            key={key}
            style={[band ? s.band : { flexDirection: "row" }, s.totalRow, r.emphasis === "muted" ? s.muted : {}]}
          >
            <Text style={{ flex: 1 }}>{r.label}</Text>
            <Text style={r.emphasis === "strong" ? { fontWeight: 700 } : {}}>{r.value}</Text>
          </View>
        );
      })}
    </>
  );
}

function Lines({ lines, style }: { lines: readonly string[]; style?: Style }) {
  if (lines.length === 0) return null;
  return (
    <View style={[s.block, style ?? {}]}>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: note lines are positional and may repeat ("/ de" lines)
        <Text key={i}>{line}</Text>
      ))}
    </View>
  );
}

export function SevdeskDocument({
  model,
  logo,
  createdAt,
}: {
  model: RenderModel;
  logo?: PdfLogo | null;
  /** Fixed CreationDate/ModDate so the bytes are reproducible. */
  createdAt: Date;
}) {
  const { layout } = model;
  const print = layout.printOptions;
  let items = 0;
  return (
    <Document
      title={model.meta.title}
      author={model.meta.author}
      subject={model.meta.subject}
      keywords={model.meta.keywords.join(", ")}
      creator={model.meta.author}
      producer="sevdesk-clone"
      language={model.language === "en" ? "en-GB" : "de-DE"}
      conformance="PDF/A-3b"
      creationDate={createdAt}
      modificationDate={createdAt}
    >
      <Page
        size="A4"
        style={[s.page, { paddingBottom: footerReserve(model.labelledFooter), fontFamily: fontStack(layout.font) }]}
      >
        {print.foldMarks ? (
          <>
            <View fixed style={[s.foldMark, { top: 297.6, width: 11 }]} />
            <View fixed style={[s.foldMark, { top: 420.9, width: 19 }]} />
            <View fixed style={[s.foldMark, { top: 595.3, width: 11 }]} />
          </>
        ) : null}
        {model.watermark ? (
          <Text fixed style={s.watermark}>
            {model.watermark}
          </Text>
        ) : null}

        {/* H */}
        {logo ? (
          <Image fixed src={{ data: Buffer.from(logo.data), format: logo.format }} style={s.logo} />
        ) : (
          <Text fixed style={s.sellerName}>
            {model.sellerName}
          </Text>
        )}
        {model.stamp ? (
          <Text fixed style={s.stamp}>
            {model.stamp}
          </Text>
        ) : null}

        {/* S + W | I */}
        <View style={s.addressRow}>
          <View style={s.window}>
            {model.senderLine ? (
              <Text style={s.senderLine}>{model.senderLine.replaceAll(" → ", "    →    ")}</Text>
            ) : null}
            {model.recipient.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: address lines are positional
              <Text key={i} style={s.recipientLine}>
                {line}
              </Text>
            ))}
          </View>
          <View style={s.infoBlock}>
            {model.info.map((r) => (
              <View key={r.label} style={s.infoRow}>
                <Text style={s.infoLabel}>{r.label}</Text>
                <Text style={s.infoValue}>{r.value}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* T */}
        <View style={s.titleRow}>
          <Text style={s.title}>
            {model.title} {model.number}
          </Text>
          <Text>{model.documentDate}</Text>
        </View>
        {model.subject ? <Text style={s.subject}>{model.subject}</Text> : null}
        <Lines lines={model.titleNotes} />
        {model.headText ? <Text style={[s.block, { marginTop: 20 }]}>{model.headText}</Text> : null}

        {/* P */}
        {model.rows.length > 0 ? (
          <View style={s.table}>
            <View fixed style={[s.band, s.headRow]}>
              {model.columns
                .filter((c) => c.key !== "pos")
                .map((c) => (
                  <Text key={c.key} style={[width(c), { textAlign: c.align }]}>
                    {c.label}
                  </Text>
                ))}
            </View>
            {model.rows.map((row, i) => {
              if (row.kind === "item") items += 1;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
                <PositionRow key={i} row={row} columns={model.columns} shaded={items % 2 === 0} />
              );
            })}
          </View>
        ) : null}

        {/* ∑ */}
        {model.totals.length > 0 ? (
          <View style={s.totals} wrap={false}>
            <TotalRows rows={model.totals} />
          </View>
        ) : null}
        <Lines lines={model.totalsNotes} style={s.small} />

        {model.reminder ? (
          <View style={s.table} wrap={false}>
            <TotalRows rows={model.reminder.rows} />
            {model.reminder.interest && model.reminder.interestHeader ? (
              <View style={s.block}>
                <View style={[s.totalRow, { fontWeight: 700 }]}>
                  {model.reminder.interestHeader.map((h) => (
                    <Text key={h} style={{ flex: 1 }}>
                      {h}
                    </Text>
                  ))}
                </View>
                {model.reminder.interest.map((seg, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: interest segments are positional
                  <View key={i} style={s.totalRow}>
                    {seg.map((cell, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                      <Text key={j} style={{ flex: 1 }}>
                        {cell}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {/* L */}
        <Lines lines={model.legalNotes} style={{ fontWeight: 700 }} />
        <View style={s.paymentRow} wrap={false}>
          <View style={{ flex: 1 }}>
            {model.payment.lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: payment lines are positional
              <Text key={i} style={s.paymentLine}>
                {line}
              </Text>
            ))}
            {model.payment.bank ? (
              <View style={s.block}>
                {model.payment.bank.map((b) => (
                  <Text key={b.label}>
                    {b.label}: {b.value}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
          {model.payment.epcPayload ? <EpcQr payload={model.payment.epcPayload} size={84} /> : null}
        </View>

        {/* F */}
        {model.footText ? <Text style={s.block}>{model.footText}</Text> : null}
        {model.customFields.length > 0 ? (
          <View style={s.block}>
            {model.customFields.map((f) => (
              <Text key={f.label}>
                {f.label}: {f.value}
              </Text>
            ))}
          </View>
        ) : null}
        {model.einvoiceHint ? <Text style={[s.block, s.small]}>{model.einvoiceHint}</Text> : null}

        {/* Z */}
        {model.labelledFooter ? (
          <View fixed style={s.footer}>
            {model.labelledFooter.map((column, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the footer columns are positional
              <View key={i} style={s.footerColumn}>
                {column.map((f) => (
                  <Text key={`${f.label ?? ""}${f.value}`} style={s.footerField}>
                    {f.label ? (
                      <Text style={s.footerLabel}>
                        {f.label}
                        {f.stacked ? "\n" : " "}
                      </Text>
                    ) : null}
                    {f.value}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        ) : null}
        {print.pageNumbers ? (
          <Text fixed style={s.pageNumber} render={({ pageNumber, totalPages }) => `${pageNumber}/${totalPages}`} />
        ) : null}
      </Page>
    </Document>
  );
}
