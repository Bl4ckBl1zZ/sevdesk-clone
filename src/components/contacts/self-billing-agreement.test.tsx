import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { SelfBillingAgreementForm } from "./self-billing-agreement";

const AGREEMENT = { agreedOn: "2026-01-02", scope: "Provisionsabrechnungen", validFrom: "2026-01-01" };

describe("Gutschriftsvereinbarung card (F04 §4.9, INV-16, UST-33)", () => {
  test("INV-16 UST-33 without an agreement there is no „Gutschrift erstellen“; the form refuses an empty scope", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    renderWithIntl(
      <SelfBillingAgreementForm contactId="c1" agreement={null} canWrite today="2026-10-12" onSave={onSave} />,
    );
    expect(screen.getByText("Keine Gutschriftsvereinbarung hinterlegt.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Gutschrift erstellen" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Vereinbarung erfassen" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte den Umfang der Vereinbarung beschreiben");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
    await user.type(screen.getByLabelText("Umfang"), "Provisionsabrechnungen");
    await user.type(screen.getByLabelText("Auszahlungskonto des Lieferanten (IBAN)"), "DE75512108001245126199");
    await user.click(screen.getByRole("checkbox", { name: /Kleinunternehmer/ }));
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(onSave).toHaveBeenCalledWith({
      agreedOn: "2026-10-12",
      validFrom: "2026-10-12",
      scope: "Provisionsabrechnungen",
      supplierKleinunternehmer: true,
      iban: "DE75512108001245126199",
    });
  });

  test("INV-16 a valid agreement shows its terms and links to a new Gutschrift for this supplier", () => {
    renderWithIntl(
      <SelfBillingAgreementForm contactId="c1" agreement={AGREEMENT} canWrite today="2026-10-12" onSave={vi.fn()} />,
    );
    expect(screen.getByText("Provisionsabrechnungen")).toBeInTheDocument();
    expect(screen.getByText("01.01.2026 – unbefristet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Gutschrift erstellen" })).toHaveAttribute(
      "href",
      "/rechnungen/neu?typ=gutschrift&kontakt=c1",
    );
  });

  test("UST-33 an expired agreement blocks Gutschriften (status shown, no create link)", () => {
    renderWithIntl(
      <SelfBillingAgreementForm
        contactId="c1"
        agreement={{ ...AGREEMENT, validTo: "2026-06-30" }}
        canWrite
        today="2026-10-12"
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("heute nicht gültig");
    expect(screen.queryByRole("link", { name: "Gutschrift erstellen" })).toBeNull();
  });
});
