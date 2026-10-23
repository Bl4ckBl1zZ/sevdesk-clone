import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { BewirtungSheet, EigenbelegSheet } from "./voucher-approvals";

const backend = vi.hoisted(() => ({ actions: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock("convex/react", () => ({
  useAction: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.actions[name] ??= vi.fn().mockResolvedValue(null);
    return backend.actions[name];
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  backend.actions = {};
  vi.clearAllMocks();
});

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("Bewirtungsbeleg sheet (F06 §6.4)", () => {
  test("VOU-060 VOU-062 the declaration is approved with occasion, participants, host, place, tip and confirmations", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithIntl(<BewirtungSheet id={"v1" as never} stored={null} documentDate="2026-10-10" onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Bewirtungsbeleg" })).toHaveTextContent("§ 4 Abs. 5 Nr. 2 EStG");
    expect(screen.getByLabelText("Tag der Bewirtung")).toHaveValue("2026-10-10");
    expect(screen.queryByLabelText("Grund für die neue Fassung")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Anlass"), "arbeitnehmer");
    type("Konkreter Anlass", "Projektbesprechung Website-Relaunch");
    type("Teilnehmer", "Erika Muster\n\n Max Beispiel ");
    type("Bewirtende Person", "Erika Muster");
    type("Ort (Gaststätte)", "Ristorante Roma, Berlin");
    type("Trinkgeld", "5,50");
    await user.click(screen.getByRole("checkbox", { name: /maschinell erstellt und registriert/ }));
    await user.click(screen.getByRole("checkbox", { name: /Name der bewirtenden Person steht auf der Rechnung/ }));
    await user.click(screen.getByTestId("bewirtung-approve"));
    await waitFor(() =>
      expect(backend.actions["vouchers:approveBewirtungBeleg"]).toHaveBeenCalledWith({
        id: "v1",
        data: {
          occasionType: "arbeitnehmer",
          occasion: "Projektbesprechung Website-Relaunch",
          participants: ["Erika Muster", "Max Beispiel"],
          host: "Erika Muster",
          place: "Ristorante Roma, Berlin",
          date: "2026-10-10",
          tipCents: 550,
          tseConfirmed: true,
          hostOnInvoiceConfirmed: true,
        },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Bewirtungsbeleg freigegeben");
    expect(onClose).toHaveBeenCalled();
  });

  test("VOU-062 a re-approval shows the earlier approval, needs a reason and acknowledges ⚑ warnings", async () => {
    const user = userEvent.setup();
    const warn = new ConvexError({
      code: "invalid_input",
      message: "Ohne TSE-Bestätigung ist der Betriebsausgabenabzug gefährdet.",
      reason: "WARNINGS_UNACKNOWLEDGED",
      warnings: "tse_missing,host_missing",
    });
    backend.actions["vouchers:approveBewirtungBeleg"] = vi.fn().mockRejectedValueOnce(warn).mockResolvedValue(null);
    renderWithIntl(
      <BewirtungSheet
        id={"v1" as never}
        stored={{
          occasionType: "geschaeftlich",
          occasion: "Kundentermin",
          participants: ["Erika Muster", "Max Beispiel"],
          host: "Erika Muster",
          place: "Café Mitte",
          date: "2026-10-09",
          tipCents: 300,
          tseConfirmed: false,
          approvedAt: Date.UTC(2026, 9, 11, 10),
        }}
        documentDate="2026-10-10"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/^Freigegeben am/)).toBeInTheDocument();
    expect(screen.getByLabelText("Trinkgeld")).toHaveValue("3,00");
    expect(screen.getByLabelText("Teilnehmer")).toHaveValue("Erika Muster\nMax Beispiel");
    type("Grund für die neue Fassung", "Teilnehmer ergänzt");
    await user.click(screen.getByTestId("bewirtung-approve"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ohne TSE-Bestätigung");
    expect(toast.success).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", { name: "Warnungen gelesen – trotzdem freigeben" }));
    await user.click(screen.getByTestId("bewirtung-approve"));
    await waitFor(() =>
      expect(backend.actions["vouchers:approveBewirtungBeleg"]).toHaveBeenLastCalledWith(
        expect.objectContaining({
          reason: "Teilnehmer ergänzt",
          acknowledgeWarnings: ["tse_missing", "host_missing"],
          data: expect.objectContaining({ occasionType: "geschaeftlich", tipCents: 300, tseConfirmed: false }),
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Bewirtungsbeleg freigegeben");
  });

  test("VOU-061 an invalid tip is flagged at the field", () => {
    renderWithIntl(<BewirtungSheet id={"v1" as never} stored={null} documentDate="2026-10-10" onClose={vi.fn()} />);
    type("Trinkgeld", "5,555");
    expect(screen.getByText("Betrag ungültig.")).toBeInTheDocument();
  });
});

describe("Eigenbeleg sheet (F06 VOU-063)", () => {
  test("VOU-063 the replacement receipt is approved with reason, explanation, recipient and purpose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithIntl(<EigenbelegSheet id={"v2" as never} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Eigenbeleg" })).toHaveTextContent("Kein Vorsteuerabzug.");
    await user.selectOptions(screen.getByLabelText("Grund"), "not_obtainable");
    type("Erläuterung", "Parkautomat ohne Quittung");
    type("Empfänger der Zahlung", "Stadt Berlin");
    type("Zweck / Gegenstand", "Parken Kundentermin");
    await user.click(screen.getByTestId("eigenbeleg-approve"));
    await waitFor(() =>
      expect(backend.actions["vouchers:approveEigenbelegBeleg"]).toHaveBeenCalledWith({
        id: "v2",
        data: {
          reason: "not_obtainable",
          reasonText: "Parkautomat ohne Quittung",
          recipient: "Stadt Berlin",
          purpose: "Parken Kundentermin",
        },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Eigenbeleg freigegeben");
    expect(onClose).toHaveBeenCalled();
  });

  test("VOU-063 a rejected approval shows the error and keeps the sheet open", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    backend.actions["vouchers:approveEigenbelegBeleg"] = vi
      .fn()
      .mockRejectedValue(new ConvexError({ code: "invalid_input", message: "Bitte den Empfänger angeben." }));
    renderWithIntl(<EigenbelegSheet id={"v2" as never} onClose={onClose} />);
    await user.click(screen.getByTestId("eigenbeleg-approve"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Bitte den Empfänger angeben.");
    expect(backend.actions["vouchers:approveEigenbelegBeleg"]).toHaveBeenCalledWith({
      id: "v2",
      data: { reason: "lost", recipient: "", purpose: "" },
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
