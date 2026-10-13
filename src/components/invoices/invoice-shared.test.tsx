import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { CompliancePanel, InvoiceStatusBadge, TotalsPanel } from "./invoice-shared";

describe("DOC-20 compliance panel and DOC-55 status badge", () => {
  test("DOC-20 errors block, warnings inform; every finding shows its rule ID, grouped", () => {
    const { container } = renderWithIntl(
      <CompliancePanel
        findings={[
          {
            code: "bank_account_missing",
            severity: "E",
            message: "Bankverbindung fehlt.",
            rule: "ER-10",
            group: "pflichtangaben",
          },
          { code: "pdf_consent", severity: "W", message: "PDF-Zustimmung fehlt.", rule: "MAIL-01", group: "e_rechnung" },
        ]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("1 Fehler verhindert das Fertigstellen · 1 Hinweis");
    expect(screen.getByText("Pflichtangaben")).toBeInTheDocument();
    expect(screen.getByText("E-Rechnung")).toBeInTheDocument();
    expect(container.querySelector("[data-code=bank_account_missing]")).toHaveTextContent("(ER-10)");
    expect(container.querySelector("[data-code=bank_account_missing]")).toHaveTextContent("Fehler:");
  });

  test("DOC-20 without findings the panel says the invoice is ready", () => {
    renderWithIntl(<CompliancePanel findings={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Bereit zum Fertigstellen.");
  });

  test("DOC-55 the badge renders the domain label, overdue with an icon", () => {
    const { container } = renderWithIntl(<InvoiceStatusBadge token="overdue" label="Überfällig" />);
    expect(screen.getByText("Überfällig")).toBeInTheDocument();
    expect(container.querySelector("[data-status=overdue] svg")).not.toBeNull();
  });

  test("DOC-19 totals show net, VAT per rate and gross in German format", () => {
    renderWithIntl(
      <TotalsPanel
        currency="EUR"
        totals={{
          netCents: 100_000,
          vatCents: 19_000,
          grossCents: 119_000,
          payableCents: 119_000,
          groups: [{ category: "S", rateBp: 1900, baseCents: 100_000, vatCents: 19_000 }],
        }}
      />,
    );
    expect(screen.getByText("USt 19 %")).toBeInTheDocument();
    expect(screen.getByTestId("gross")).toHaveTextContent("1.190,00 €");
  });
});
