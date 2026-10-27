/**
 * The one react-pdf template for all sales documents (F04 App. F; invoice family, quote, order confirmation,
 * delivery note, pro forma, reminder). It only lays out a `RenderModel` (`src/domain/documents/render-model.ts`);
 * every printed string is decided there. Zones: H (logo/seller), S (sender line), W (window address, DIN 5008 B),
 * I (info block), T (title, subject, title notes), head text, P (positions, repeated header), ∑ (totals),
 * L (legal notes, payment, EPC-QR), F (foot text), Z (Geschäftsbrief footer, fixed), page x/y, fold marks.
 */
import { Document, Image, Page, StyleSheet, type Styles, Text, View } from "@react-pdf/renderer";
import type { RenderColumn, RenderModel, RenderRow, RenderTotalRow } from "@/domain/documents/render-model";
import { EpcQr } from "./epc-qr";
import { fontStack } from "./fonts";

export interface PdfLogo {
  readonly data: Uint8Array;
  readonly format: "png" | "jpg";
}

const COLUMN_WIDTH: Record<RenderColumn["key"], number | null> = {
  pos: 28,
  name: null,
  quantity: 48,
  unit: 46,
  unitPrice: 84,
  vat: 36,
  discount: 50,
  amount: 78,
};

const s = StyleSheet.create({
  // No lineHeight on the page: react-pdf 4.9 then drops dynamic `render` texts (page x/y) and inflates rows.
  page: { paddingTop: 40, paddingBottom: 112, paddingHorizontal: 56, fontSize: 9, color: "#111111" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", minHeight: 60 },
  sellerName: { fontSize: 13, fontWeight: 700 },
  logo: { maxWidth: 150, maxHeight: 60, objectFit: "contain" },
  stamp: { fontSize: 10, fontWeight: 700, color: "#B42318", textAlign: "right", marginBottom: 4 },
  addressRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 32 },
  window: { width: 240, minHeight: 120 },
  senderLine: { fontSize: 6.5, color: "#555555", textDecoration: "underline", marginBottom: 6 },
  info: { width: 210 },
  infoRow: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  infoLabel: { color: "#555555" },
  title: { fontSize: 16, fontWeight: 700, marginTop: 18 },
  subject: { fontWeight: 700, marginTop: 4 },
  block: { marginTop: 8 },
  table: { marginTop: 12 },
  headRow: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 1, fontWeight: 700 },
  row: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: "#DDDDDD" },
  muted: { color: "#666666" },
  small: { fontSize: 7.5, color: "#555555" },
  heading: { fontWeight: 700, paddingTop: 8, paddingBottom: 2 },
  totals: { alignSelf: "flex-end", width: 300, marginTop: 10 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 1.5 },
  strong: { fontWeight: 700, borderTopWidth: 0.75, paddingTop: 3, marginTop: 2 },
  paymentRow: { flexDirection: "row", justifyContent: "space-between", gap: 16, marginTop: 10 },
  footer: {
    position: "absolute",
    bottom: 30,
    left: 56,
    right: 56,
    flexDirection: "row",
    gap: 12,
    fontSize: 6.5,
    color: "#444444",
    borderTopWidth: 0.5,
    borderTopColor: "#BBBBBB",
    paddingTop: 5,
  },
  footerColumn: { flex: 1 },
  pageNumber: { position: "absolute", bottom: 14, right: 56, fontSize: 7, color: "#666666" },
  foldMark: { position: "absolute", left: 18, width: 10, borderTopWidth: 0.5, borderTopColor: "#999999" },
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

const width = (key: RenderColumn["key"]) => {
  const w = COLUMN_WIDTH[key];
  return w === null ? { flex: 1 } : { width: w };
};

function Cell({ column, children }: { column: RenderColumn; children: string }) {
  return <Text style={[width(column.key), { textAlign: column.align, paddingRight: 4 }]}>{children}</Text>;
}

function PositionRow({ row, columns }: { row: RenderRow; columns: readonly RenderColumn[] }) {
  if (row.kind === "subtotal") {
    return (
      <View style={[s.totalRow, { fontWeight: 700, paddingVertical: 4 }]} wrap={false}>
        <Text>{row.text}</Text>
        <Text>{row.amount}</Text>
      </View>
    );
  }
  if (row.kind !== "item") return <Text style={row.kind === "heading" ? s.heading : s.block}>{row.text}</Text>;
  return (
    <View style={[s.row, row.optional ? s.muted : {}]} wrap={false}>
      {columns.map((c) =>
        c.key === "name" ? (
          <View key={c.key} style={[width(c.key), { paddingRight: 4 }]}>
            <Text>{row.name}</Text>
            {row.itemNumber ? <Text style={s.small}>{row.itemNumber}</Text> : null}
            {row.description ? <Text style={s.small}>{row.description}</Text> : null}
            {row.period ? <Text style={s.small}>{row.period}</Text> : null}
          </View>
        ) : (
          <Cell key={c.key} column={c}>
            {row[c.key]}
          </Cell>
        ),
      )}
    </View>
  );
}

function TotalRows({ rows, accent }: { rows: readonly RenderTotalRow[]; accent: string }) {
  return (
    <>
      {rows.map((r, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: totals are positional (labels may repeat per rate)
          key={i}
          style={[
            s.totalRow,
            r.emphasis === "strong" ? [s.strong, { borderTopColor: accent }] : {},
            r.emphasis === "muted" ? s.muted : {},
          ]}
        >
          <Text style={{ flex: 1 }}>{r.label}</Text>
          <Text>{r.value}</Text>
        </View>
      ))}
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

export function SalesDocument({
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
  const accent = layout.accentColor;
  const print = layout.printOptions;
  const logoNode = logo ? <Image src={{ data: Buffer.from(logo.data), format: logo.format }} style={s.logo} /> : null;
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
      <Page size="A4" style={[s.page, { fontFamily: fontStack(layout.font) }]}>
        {print.foldMarks ? (
          <>
            <View fixed style={[s.foldMark, { top: 297.6 }]} />
            <View fixed style={[s.foldMark, { top: 420.9 }]} />
            <View fixed style={[s.foldMark, { top: 595.3 }]} />
          </>
        ) : null}
        {model.watermark ? (
          <Text fixed style={s.watermark}>
            {model.watermark}
          </Text>
        ) : null}

        {/* H */}
        <View style={s.header}>
          {layout.logoPosition === "left" ? (logoNode ?? <Text style={s.sellerName}>{model.sellerName}</Text>) : null}
          <View style={{ flex: 1, paddingHorizontal: 12 }}>
            {model.stamp ? <Text style={s.stamp}>{model.stamp}</Text> : null}
          </View>
          {layout.logoPosition === "right" ? (logoNode ?? <Text style={s.sellerName}>{model.sellerName}</Text>) : null}
        </View>

        {/* S + W | I */}
        <View style={s.addressRow}>
          <View style={s.window}>
            {model.senderLine ? <Text style={s.senderLine}>{model.senderLine}</Text> : null}
            {model.recipient.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: address lines are positional
              <Text key={i}>{line}</Text>
            ))}
          </View>
          <View style={s.info}>
            {model.info.map((r) => (
              <View key={r.label} style={s.infoRow}>
                <Text style={s.infoLabel}>{r.label}</Text>
                <Text style={{ textAlign: "right", flexShrink: 1 }}>{r.value}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* T */}
        <Text style={[s.title, { color: accent }]}>
          {model.title} {model.number}
        </Text>
        {model.subject ? <Text style={s.subject}>{model.subject}</Text> : null}
        <Lines lines={model.titleNotes} />
        {model.headText ? <Text style={s.block}>{model.headText}</Text> : null}

        {/* P */}
        {model.rows.length > 0 ? (
          <View style={s.table}>
            <View fixed style={[s.headRow, { borderBottomColor: accent }]}>
              {model.columns.map((c) => (
                <Cell key={c.key} column={c}>
                  {c.label}
                </Cell>
              ))}
            </View>
            {model.rows.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
              <PositionRow key={i} row={row} columns={model.columns} />
            ))}
          </View>
        ) : null}

        {/* ∑ */}
        {model.totals.length > 0 ? (
          <View style={s.totals} wrap={false}>
            <TotalRows rows={model.totals} accent={accent} />
          </View>
        ) : null}
        <Lines lines={model.totalsNotes} style={s.small} />

        {model.reminder ? (
          <View style={[s.totals, { width: "100%" }]} wrap={false}>
            <TotalRows rows={model.reminder.rows} accent={accent} />
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
              <Text key={i}>{line}</Text>
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
        {model.footer ? (
          <View fixed style={s.footer}>
            {model.footer.map((col, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the footer columns are positional
              <View key={i} style={s.footerColumn}>
                {col.map((line) => (
                  <Text key={line}>{line}</Text>
                ))}
              </View>
            ))}
          </View>
        ) : null}
        {print.pageNumbers ? (
          <Text
            fixed
            style={s.pageNumber}
            render={({ pageNumber, totalPages }) =>
              `${model.pageLabel.page} ${pageNumber} ${model.pageLabel.of} ${totalPages}`
            }
          />
        ) : null}
      </Page>
    </Document>
  );
}
