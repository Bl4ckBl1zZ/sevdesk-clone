/**
 * Import protocol PDF (F09 IMP-024): renders the section model of src/domain/import/sevdesk/protocol.ts as an A4
 * PDF/A-3b with the embedded Inter/Noto fonts (same conventions as the sales documents: registered fonts, no
 * hyphenation, fixed creation date → reproducible bytes, so the archived SHA-256 is stable). Runs in the Convex
 * Node action `importsNode.renderProtocol`.
 */
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ImportProtocol, ProtocolTable } from "@/domain/import/sevdesk/protocol";
import { fontStack, registerPdfFonts } from "./fonts";

const s = StyleSheet.create({
  // No lineHeight on the page: react-pdf 4.9 then drops dynamic `render` texts (page x/y), see sales-document.tsx.
  page: { paddingTop: 40, paddingBottom: 56, paddingHorizontal: 40, fontSize: 8, color: "#111111" },
  title: { fontSize: 15, fontWeight: 700 },
  subtitle: { fontSize: 8.5, color: "#444444", marginTop: 3, marginBottom: 10 },
  section: { marginTop: 12 },
  sectionTitle: { fontSize: 11, fontWeight: 700, marginBottom: 4 },
  paragraph: { marginBottom: 3 },
  table: { marginTop: 2, borderTopWidth: 0.5, borderTopColor: "#999999" },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#DDDDDD", paddingVertical: 2 },
  headRow: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#999999", paddingVertical: 2 },
  cell: { paddingRight: 4 },
  head: { fontWeight: 700 },
  mono: { fontSize: 6.5 },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, fontSize: 7, color: "#666666" },
  pageNumber: { position: "absolute", bottom: 24, right: 40, fontSize: 7, color: "#666666" },
});

function Table({ table }: { table: ProtocolTable }) {
  const width = (i: number) => `${table.widths[i] ?? 100 / table.headers.length}%`;
  return (
    <View style={s.table}>
      <View style={s.headRow} fixed>
        {table.headers.map((h, i) => (
          <Text key={h} style={[s.cell, s.head, { width: width(i) }]}>
            {h}
          </Text>
        ))}
      </View>
      {table.rows.map((row, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: protocol rows are positional and may repeat
        <View key={r} style={s.row} wrap={false}>
          {row.map((cell, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
            <Text key={i} style={[s.cell, { width: width(i) }, ...(table.mono?.includes(i) ? [s.mono] : [])]}>
              {cell}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

export function ImportProtocolDocument({ protocol }: { protocol: ImportProtocol }) {
  const createdAt = new Date(protocol.createdAt);
  return (
    <Document
      title={protocol.title}
      subject={protocol.subtitle}
      creator="sevdesk-clone"
      producer="sevdesk-clone"
      language="de-DE"
      conformance="PDF/A-3b"
      creationDate={createdAt}
      modificationDate={createdAt}
    >
      <Page size="A4" style={[s.page, { fontFamily: fontStack("inter") }]}>
        <Text style={s.title}>{protocol.title}</Text>
        <Text style={s.subtitle}>{protocol.subtitle}</Text>
        {protocol.sections.map((section) => (
          <View key={section.title} style={s.section}>
            <Text style={s.sectionTitle} minPresenceAhead={40}>
              {section.title}
            </Text>
            {(section.paragraphs ?? []).map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional
              <Text key={i} style={s.paragraph}>
                {p}
              </Text>
            ))}
            {section.table && section.table.rows.length > 0 ? <Table table={section.table} /> : null}
          </View>
        ))}
        <Text fixed style={s.footer}>
          {protocol.footer}
        </Text>
        <Text
          fixed
          style={s.pageNumber}
          render={({ pageNumber, totalPages }) => `Seite ${pageNumber} von ${totalPages}`}
        />
      </Page>
    </Document>
  );
}

export async function renderImportProtocol(protocol: ImportProtocol): Promise<Uint8Array> {
  registerPdfFonts();
  return new Uint8Array(await renderToBuffer(<ImportProtocolDocument protocol={protocol} />));
}
