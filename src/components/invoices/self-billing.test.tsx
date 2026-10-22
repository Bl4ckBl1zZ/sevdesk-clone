import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { typeFeatures } from "./editor-model";
import { ObjectionDialog } from "./self-billing";

describe("self-billing Gutschrift UI (F04 §4.9, INV-16)", () => {
  test("INV-16 „Widerspruch erfassen“ needs a text and a date between the Gutschrift and today", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(
      <ObjectionDialog
        documentDate="2026-10-01"
        number="GS-2026-0001"
        today="2026-10-12"
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Widerspruch zur Gutschrift GS-2026-0001" })).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Widerspruch erfassen" });
    expect(confirm).toBeDisabled();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Inhalt des Widerspruchs"), "Provision zu hoch abgerechnet");
    const date = screen.getByLabelText("Datum des Widerspruchs");
    await user.clear(date);
    await user.type(date, "2026-09-30");
    expect(screen.getByRole("alert")).toHaveTextContent("nicht vor der Gutschrift");
    expect(confirm).toBeDisabled();
    await user.clear(date);
    await user.type(date, "2026-10-05");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ date: "2026-10-05", text: "Provision zu hoch abgerechnet" });
  });

  test("INV-16 the editor shows no payment terms or EPC QR for a Gutschrift (we pay the supplier)", () => {
    expect(typeFeatures("self_billing")).toMatchObject({ payment: false, epcQr: false, einvoice: false });
    expect(typeFeatures("invoice")).toMatchObject({ payment: true, epcQr: true });
  });
});
