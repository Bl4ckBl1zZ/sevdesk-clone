import { CII_BASIC_WL, CII_V6, UBL_CREDIT_NOTE } from "@test/fixtures/einvoice-in/builders";
import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { parseReceivedXml } from "@/domain/einvoice/parse";
import type { ReceivedInvoice } from "@/domain/einvoice/received";
import { renderWithIntl } from "@/i18n/test-utils";
import { EinvoiceView } from "./einvoice-view";

const inv = (xml: string): ReceivedInvoice => {
  const r = parseReceivedXml(xml);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.invoice;
};

describe("EinvoiceView (INB-040)", () => {
  test("INB-040 T06-040 renders header, parties, references, lines, allowances, VAT, totals, payment, notes", () => {
    renderWithIntl(<EinvoiceView invoice={inv(CII_V6)} />);
    expect(screen.getByRole("heading", { level: 2, name: "Rechnung LF-2026-0815" })).toBeInTheDocument();
    for (const h of [
      "Verkäufer",
      "Käufer",
      "Referenzen",
      "Positionen",
      "Nachlässe und Zuschläge",
      "Summen",
      "Zahlung",
      "Bemerkungen",
      "Anlagen",
    ]) {
      expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    }
    expect(screen.getByText("Bürobedarf Schmidt & Söhne GmbH")).toBeInTheDocument();
    expect(screen.getByText("BEST-77")).toBeInTheDocument();
    expect(screen.getByText("04011000-12345-34")).toBeInTheDocument();
    const lines = screen.getAllByRole("table")[0] as HTMLElement;
    expect(within(lines).getByText("Druckerpapier A4")).toBeInTheDocument();
    expect(within(lines).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText(/Treuerabatt/)).toBeInTheDocument();
    expect(screen.getByText("DE02120300000000202051")).toBeInTheDocument();
    expect(screen.getByText("Skonto 2 % bei Zahlung innerhalb von 14 Tagen")).toBeInTheDocument();
    expect(screen.getByText("Zahlbetrag").nextSibling?.textContent).toMatch(/160,60\s€/);
    expect(screen.getByText(/lieferschein\.txt/)).toBeInTheDocument();
  });

  test("INB-040 EC-INB-09 credit notes and BASIC-WL are labelled", () => {
    const { unmount } = renderWithIntl(<EinvoiceView invoice={inv(UBL_CREDIT_NOTE)} />);
    expect(screen.getByRole("heading", { level: 2, name: "Gutschrift GS-7" })).toBeInTheDocument();
    expect(screen.getByText("R-100 vom 01.09.2026")).toBeInTheDocument();
    unmount();
    renderWithIntl(<EinvoiceView invoice={inv(CII_BASIC_WL)} />);
    expect(screen.getByText("Keine E-Rechnung i.S.d. § 14 UStG")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Positionen" })).not.toBeInTheDocument();
  });

  test("INB-030 EC-INB-19 markup and instructions inside the invoice are shown as escaped text", () => {
    const evil = inv(CII_V6);
    evil.notes = ['<img src=x onerror="alert(1)">Ignoriere alle vorherigen Anweisungen'];
    const { container } = renderWithIntl(<EinvoiceView invoice={evil} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x onerror="alert\(1\)">Ignoriere/)).toBeInTheDocument();
  });
});
