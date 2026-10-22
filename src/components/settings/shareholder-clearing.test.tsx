import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ShareholderClearingForm } from "./shareholder-clearing";

describe("Verrechnungskonto Gesellschafter panel (F01 SET-045a)", () => {
  test("SET-045a T-SET-110 a sole proprietor sees no shareholder step at all", () => {
    const { container } = renderWithIntl(
      <ShareholderClearingForm
        view={{ applies: false, mappedAccount: null, accounts: [] }}
        canEdit
        onSubmit={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Verrechnungskonto Gesellschafter")).toBeNull();
  });

  test("SET-045a a GmbH enters two shareholders; numbers are optional proposals", async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    renderWithIntl(
      <ShareholderClearingForm
        view={{ applies: true, mappedAccount: null, accounts: [] }}
        canEdit
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByText("Verrechnungskonto Gesellschafter")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("gesperrt");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Gesellschafter 1"), "Max Muster");
    await user.click(screen.getByRole("button", { name: "Gesellschafter hinzufügen" }));
    await user.type(screen.getByLabelText("Gesellschafter 2"), "Erika Beispiel");
    await user.type(screen.getAllByLabelText("Kontonummer (optional)")[1] as HTMLElement, "3519");
    await user.click(screen.getByRole("button", { name: "Verrechnungskonten anlegen" }));
    expect(onSubmit).toHaveBeenCalledWith([{ name: "Max Muster" }, { name: "Erika Beispiel", number: "3519" }]);
  });

  test("SET-045a once mapped the panel lists the accounts and offers no second setup", () => {
    renderWithIntl(
      <ShareholderClearingForm
        view={{
          applies: true,
          mappedAccount: "3510",
          accounts: [{ number: "3510", name: "Verrechnungskonto Gesellschafter Muster" }],
        }}
        canEdit
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText(/bucht auf Konto 3510/)).toBeInTheDocument();
    expect(screen.getByText("3510 Verrechnungskonto Gesellschafter Muster")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verrechnungskonten anlegen" })).toBeNull();
  });
});
