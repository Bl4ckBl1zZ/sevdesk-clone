import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { AddressesCard, ChannelsCard } from "./contact-addresses";
import { contactBundle } from "./test-fixtures";

const backend = vi.hoisted(() => ({ calls: [] as { name: string; args: unknown }[] }));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    return null;
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  backend.calls = [];
});

describe("addresses and channels (F02 §6.3)", () => {
  test("CON-020 addresses are listed with type, default badge and the formatted lines", () => {
    renderWithIntl(<AddressesCard data={contactBundle()} canWrite />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Rechnungsadresse");
    expect(items[0]).toHaveTextContent("Standard");
    expect(items[0]).toHaveTextContent("Hauptstr. 1");
    expect(items[0]).toHaveTextContent("10115 Berlin");
    expect(items[1]).toHaveTextContent("Lieferadresse");
    expect(items[1]).toHaveTextContent("Wareneingang");
    expect(items[1]).not.toHaveTextContent("Standard");
  });

  test("CON-020 adding an address sends the form to contacts:saveAddress", async () => {
    renderWithIntl(<AddressesCard data={contactBundle({ addresses: [] })} canWrite />);
    expect(screen.getByText(/Noch keine Adresse hinterlegt/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Adresse hinzufügen" }));
    const dialog = await screen.findByRole("dialog", { name: "Adresse hinzufügen" });
    expect(within(dialog).getByLabelText("Adressart")).toHaveValue("billing");
    await user.type(within(dialog).getByLabelText("Name in der Adresse"), "Muster GmbH");
    await user.type(within(dialog).getByLabelText("Straße und Hausnummer"), "Neue Str. 7");
    await user.type(within(dialog).getByLabelText("PLZ"), "20095");
    await user.type(within(dialog).getByLabelText("Ort"), "Hamburg");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(backend.calls.some((c) => c.name === "contacts:saveAddress")).toBe(true));
    expect(backend.calls.find((c) => c.name === "contacts:saveAddress")?.args).toMatchObject({
      contactId: "c1",
      values: { type: "billing", isDefault: true, street: "Neue Str. 7", postalCode: "20095", city: "Hamburg" },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("CON-024 editing prefills the address; removing calls contacts:removeAddress", async () => {
    renderWithIntl(<AddressesCard data={contactBundle()} canWrite />);
    const user = userEvent.setup();
    const second = screen.getAllByRole("listitem")[1] as HTMLElement;
    await user.click(within(second).getByRole("button", { name: "Bearbeiten" }));
    const dialog = await screen.findByRole("dialog", { name: "Adresse bearbeiten" });
    expect(within(dialog).getByLabelText("Ort")).toHaveValue("München");
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(backend.calls.find((c) => c.name === "contacts:saveAddress")?.args).toMatchObject({
        addressId: "a2",
        values: { type: "delivery", city: "München", department: "Wareneingang" },
      }),
    );
    await user.click(
      within(screen.getAllByRole("listitem")[0] as HTMLElement).getByRole("button", { name: "Entfernen" }),
    );
    expect(backend.calls.find((c) => c.name === "contacts:removeAddress")?.args).toEqual({ addressId: "a1" });
  });

  test("CON-020 without write permission there are no add, edit or remove buttons", () => {
    renderWithIntl(
      <>
        <AddressesCard data={contactBundle()} canWrite={false} />
        <ChannelsCard data={contactBundle()} canWrite={false} />
      </>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("CON-030 channels render as mailto/tel/web links with label, primary and invoice badges", () => {
    renderWithIntl(<ChannelsCard data={contactBundle()} canWrite />);
    expect(screen.getByRole("link", { name: "rechnung@muster.de" })).toHaveAttribute(
      "href",
      "mailto:rechnung@muster.de",
    );
    expect(screen.getByRole("link", { name: "030 123456" })).toHaveAttribute("href", "tel:+4930123456");
    expect(screen.getByRole("link", { name: "https://muster.de" })).toHaveAttribute("target", "_blank");
    expect(screen.getByText("030 999")).toBeInTheDocument();
    expect(screen.getByText("(Zentrale)")).toBeInTheDocument();
    expect(screen.getAllByText("Haupt")).toHaveLength(2);
    expect(screen.getByText("Rechnung")).toBeInTheDocument();
  });

  test("CON-030 adding an invoice e-mail calls contacts:saveChannel; removing calls removeChannel", async () => {
    renderWithIntl(<ChannelsCard data={contactBundle()} canWrite />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Eintrag hinzufügen" }));
    const dialog = await screen.findByRole("dialog", { name: "Kommunikation hinzufügen" });
    await user.type(within(dialog).getByLabelText(/^Wert/), "buchhaltung@muster.de");
    await user.click(within(dialog).getByLabelText("Rechnungs-E-Mail"));
    await user.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(backend.calls.find((c) => c.name === "contacts:saveChannel")?.args).toEqual({
        contactId: "c1",
        values: { type: "email", value: "buchhaltung@muster.de", label: "", isPrimary: true, isInvoiceEmail: true },
      }),
    );
    await user.click(screen.getAllByRole("button", { name: "Entfernen" })[1] as HTMLElement);
    expect(backend.calls.find((c) => c.name === "contacts:removeChannel")?.args).toEqual({ channelId: "ch2" });
  });

  test("CON-030 editing a channel prefills it; empty list shows the hint", async () => {
    const { unmount } = renderWithIntl(<ChannelsCard data={contactBundle({ channels: [] })} canWrite />);
    expect(screen.getByText("Noch keine Kommunikationsdaten.")).toBeInTheDocument();
    unmount();
    renderWithIntl(<ChannelsCard data={contactBundle()} canWrite />);
    await userEvent.click(screen.getAllByRole("button", { name: "Bearbeiten" })[1] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Kommunikation bearbeiten" });
    expect(within(dialog).getByLabelText(/^Wert/)).toHaveValue("030 123456");
    expect(within(dialog).getByLabelText("Bezeichnung")).toHaveValue("Zentrale");
    await userEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
