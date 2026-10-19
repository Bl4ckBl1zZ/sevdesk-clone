/**
 * Downloadable rendition of a received E-Rechnung (F06 INB-040, VOU-121): an A4 PDF rendered from the parsed EN 16931
 * model, every page stamped „Visualisierung – nicht das Original“. It is a rendition with its own record — the
 * archived original stays the received XML/hybrid PDF (ER-13). Fixed creation date (BT-2) → reproducible bytes.
 * Runs in a Convex "use node" action.
 */
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReceivedInvoice } from "@/domain/einvoice/received";
import { fontStack, registerPdfFonts } from "./fonts";

export const VISUALISATION_STAMP = "Visualisierung – nicht das Original";

const s = StyleSheet.create({
  page: { paddingTop: 56, paddingBottom: 56, paddingHorizontal: 40, fontSize: 8.5, color: "#111111" },
  stamp: {
    position: "absolute",
    top: 18,
    left: 40,
    right: 40,
    fontSize: 9,
    fontWeight: 700,
    color: "#B42318",
    textAlign: "center",
    borderWidth: 1,
    borderColor: "#B42318",
    paddingVertical: 3,
  },
  title: { fontSize: 15, fontWeight: 700, marginBottom: 2 },
  muted: { color: "#555555" },
  row: { flexDirection: "row", gap: 16, marginTop: 10 },
  col: { flexGrow: 1, flexBasis: 0 },
  h: { fontSize: 10, fontWeight: 700, marginTop: 12, marginBottom: 3 },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#DDDDDD", paddingVertical: 2 },
  th: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#999999",
    paddingVertical: 2,
    fontWeight: 700,
  },
  right: { textAlign: "right" },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, fontSize: 7, color: "#666666" },
});

const money = (cents: number, currency: string) =>
  `${(cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const rate = (bp: number) => `${(bp / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 })} %`;
const qty = (milli: number) => (milli / 1000).toLocaleString("de-DE", { maximumFractionDigits: 3 });
const date = (iso: string | undefined) => (iso ? iso.split("-").reverse().join(".") : "–");

function Address({ title, lines }: { title: string; lines: (string | undefined)[] }) {
  return (
    <View style={s.col}>
      <Text style={s.h}>{title}</Text>
      {lines
        .filter((l): l is string => !!l)
        .map((l) => (
          <Text key={l}>{l}</Text>
        ))}
    </View>
  );
}

export function EinvoiceVisualisationDocument({ invoice: inv }: { invoice: ReceivedInvoice }) {
  const created = new Date(`${inv.issueDate}T00:00:00Z`);
  const cur = inv.currency;
  const sa = inv.seller.address;
  const ba = inv.buyer.address;
  const widths = ["8%", "40%", "12%", "14%", "10%", "16%"];
  return (
    <Document
      title={`Visualisierung ${inv.number}`}
      subject={VISUALISATION_STAMP}
      creator="sevdesk-clone"
      producer="sevdesk-clone"
      language="de-DE"
      creationDate={created}
      modificationDate={created}
    >
      <Page size="A4" style={[s.page, { fontFamily: fontStack("inter") }]}>
        <Text fixed style={s.stamp}>
          {VISUALISATION_STAMP}
        </Text>
        <Text style={s.title}>
          {inv.typeCode === "381" ? "Gutschrift" : "Rechnung"} {inv.number}
        </Text>
        <Text style={s.muted}>
          {`Rechnungsdatum ${date(inv.issueDate)} · Fällig ${date(inv.dueDate)} · Profil ${inv.profile}${inv.notEInvoice ? " (keine E-Rechnung i.S.d. § 14 UStG)" : ""}`}
        </Text>
        <View style={s.row}>
          <Address
            title="Verkäufer"
            lines={[
              inv.seller.name,
              inv.seller.tradeName,
              sa.line1,
              sa.line2,
              [sa.postalCode, sa.city].filter(Boolean).join(" "),
              sa.countryCode,
              inv.seller.vatId ? `USt-IdNr. ${inv.seller.vatId}` : undefined,
              inv.seller.taxNumber ? `Steuernummer ${inv.seller.taxNumber}` : undefined,
            ]}
          />
          <Address
            title="Käufer"
            lines={[
              inv.buyer.name,
              ba?.line1,
              ba?.line2,
              [ba?.postalCode, ba?.city].filter(Boolean).join(" "),
              ba?.countryCode,
              inv.buyer.vatId ? `USt-IdNr. ${inv.buyer.vatId}` : undefined,
            ]}
          />
        </View>
        <Text style={s.h}>Referenzen</Text>
        <Text>
          {[
            inv.buyerReference ? `Käuferreferenz ${inv.buyerReference}` : null,
            inv.orderRef ? `Bestellung ${inv.orderRef}` : null,
            inv.contractRef ? `Vertrag ${inv.contractRef}` : null,
            ...inv.precedingInvoices.map(
              (p) => `Vorausgehende Rechnung ${p.number}${p.date ? ` vom ${date(p.date)}` : ""}`,
            ),
            inv.supplyDate ? `Leistungsdatum ${date(inv.supplyDate)}` : null,
            inv.period ? `Leistungszeitraum ${date(inv.period.from)} – ${date(inv.period.to)}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "–"}
        </Text>
        {inv.lines.length > 0 && (
          <>
            <Text style={s.h}>Positionen</Text>
            <View style={s.th} fixed>
              {["Pos.", "Bezeichnung", "Menge", "Einzelpreis", "USt", "Netto"].map((h, i) => (
                <Text key={h} style={[{ width: widths[i] }, ...(i >= 2 ? [s.right] : [])]}>
                  {h}
                </Text>
              ))}
            </View>
            {inv.lines.map((l) => (
              <View key={l.id} style={s.tr} wrap={false}>
                <Text style={{ width: widths[0] }}>{l.id}</Text>
                <Text style={{ width: widths[1] }}>{l.description ? `${l.name}\n${l.description}` : l.name}</Text>
                <Text style={[{ width: widths[2] }, s.right]}>{`${qty(l.quantityMilli)} ${l.unitCode ?? ""}`}</Text>
                <Text style={[{ width: widths[3] }, s.right]}>
                  {l.unitPriceMicros !== undefined
                    ? `${(l.unitPriceMicros / 10_000).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${cur}`
                    : ""}
                </Text>
                <Text style={[{ width: widths[4] }, s.right]}>{`${l.category} ${rate(l.rateBp)}`}</Text>
                <Text style={[{ width: widths[5] }, s.right]}>{money(l.netCents, cur)}</Text>
              </View>
            ))}
          </>
        )}
        {inv.allowancesCharges.length > 0 && (
          <>
            <Text style={s.h}>Nachlässe und Zuschläge</Text>
            {inv.allowancesCharges.map((a, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional
              <Text key={i}>
                {`${a.charge ? "Zuschlag" : "Nachlass"} ${a.reason ?? ""}: ${money(a.charge ? a.amountCents : -a.amountCents, cur)} (${a.category} ${rate(a.rateBp)})`}
              </Text>
            ))}
          </>
        )}
        <Text style={s.h}>Umsatzsteuer</Text>
        {inv.vatBreakdown.map((v) => (
          <Text key={`${v.category}-${v.rateBp}`}>
            {`${v.category} ${rate(v.rateBp)}: Basis ${money(v.taxableCents, cur)}, Steuer ${money(v.taxCents, cur)}${v.exemptionReason ? ` – ${v.exemptionReason}` : ""}`}
          </Text>
        ))}
        <Text style={s.h}>Summen</Text>
        <Text>{`Summe Positionen ${money(inv.totals.lineTotalCents, cur)} · Netto ${money(inv.totals.taxExclusiveCents, cur)} · USt ${money(inv.totals.taxCents, cur)}`}</Text>
        <Text>{`Brutto ${money(inv.totals.taxInclusiveCents, cur)} · Bereits gezahlt ${money(inv.totals.prepaidCents, cur)} · Zahlbetrag ${money(inv.totals.payableCents, cur)}`}</Text>
        <Text style={s.h}>Zahlung</Text>
        <Text>
          {[
            inv.payment.iban ? `IBAN ${inv.payment.iban}` : null,
            inv.payment.bic ? `BIC ${inv.payment.bic}` : null,
            inv.payment.accountName ? `Kontoinhaber ${inv.payment.accountName}` : null,
            ...inv.payment.skonto.map((k) => `Skonto ${rate(k.percentBp)} bei Zahlung innerhalb ${k.days} Tagen`),
          ]
            .filter(Boolean)
            .join(" · ") || "–"}
        </Text>
        {inv.payment.termsText ? <Text>{inv.payment.termsText}</Text> : null}
        {inv.notes.length > 0 && (
          <>
            <Text style={s.h}>Bemerkungen</Text>
            {inv.notes.map((n, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional
              <Text key={i}>{n}</Text>
            ))}
          </>
        )}
        <Text
          fixed
          style={s.footer}
          render={({ pageNumber, totalPages }) => `${VISUALISATION_STAMP} · Seite ${pageNumber} von ${totalPages}`}
        />
      </Page>
    </Document>
  );
}

export async function renderEinvoiceVisualisation(inv: ReceivedInvoice): Promise<Uint8Array> {
  registerPdfFonts();
  return new Uint8Array(await renderToBuffer(<EinvoiceVisualisationDocument invoice={inv} />));
}
