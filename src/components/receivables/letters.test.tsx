import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ArchivedLetters, LetterButton, StatementButton } from "./letters";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  fns: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.fns[name] ??= vi.fn().mockResolvedValue(
      name === "payments:letter"
        ? { letterId: "l1", url: null, pdfBase64: btoa("%PDF-1.7"), name: "Brief.pdf", data: null }
        : null,
    );
    return backend.fns[name];
  };
  return { useMutation: fn, useAction: fn };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  backend.fns = {};
  backend.data = { "members:me": { role: "owner" } };
  toast.success.mockClear();
  URL.createObjectURL = vi.fn(() => "blob:letter");
});

describe("receivables letters UI (PAY-005, PAY-048)", () => {
  test("PAY-005 „Kontoauszug erstellen“ asks for the period and creates the archived PDF (nothing is sent)", async () => {
    const user = userEvent.setup();
    renderWithIntl(<StatementButton contactId="c1" />);
    await user.click(screen.getByRole("button", { name: "Kontoauszug erstellen" }));
    const from = screen.getByLabelText("Von") as HTMLInputElement;
    expect(from.value).toMatch(/^\d{4}-01-01$/);
    await user.click(screen.getByLabelText("Als Saldenbestätigung (Kunde bestätigt den Saldo)"));
    await user.click(screen.getByRole("button", { name: "PDF erstellen" }));
    await waitFor(() => expect(backend.fns["payments:letter"]).toHaveBeenCalled());
    expect(backend.fns["payments:letter"]?.mock.calls[0]?.[0]).toMatchObject({
      request: { kind: "account_statement", contactId: "c1", from: from.value, confirmationRequest: true },
    });
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("Die App versendet nichts"));
  });

  test("PAY-048 an archived letter can be marked sent once; a sent one shows date and channel", async () => {
    const user = userEvent.setup();
    backend.data["payments:letters"] = [
      {
        id: "l1",
        kind: "payment_confirmation",
        date: "2026-10-12",
        title: "Zahlungsbestätigung",
        subject: "Bestätigung Ihres Zahlungseingangs zur Rechnung RE-2026-0001",
        fileName: "Zahlungsbestaetigung.pdf",
        sha256: "a".repeat(64),
        url: "https://files/l1",
        hasData: false,
        sent: null,
      },
      {
        id: "l2",
        kind: "account_statement",
        date: "2026-10-01",
        title: "Kontoauszug",
        subject: "Kontoauszug vom 01.01.2026 bis 30.09.2026",
        fileName: "Kontoauszug.pdf",
        sha256: "b".repeat(64),
        url: "https://files/l2",
        hasData: false,
        sent: { sentOn: "2026-10-02", channel: "post", note: null },
      },
    ];
    renderWithIntl(<ArchivedLetters documentId="d1" />);
    expect(screen.getByRole("link", { name: /Bestätigung Ihres Zahlungseingangs/ })).toHaveAttribute(
      "href",
      "https://files/l1",
    );
    expect(screen.getByText("versendet am 02.10.2026 (Post)")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Als versendet markieren" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Als versendet markieren" }));
    await user.selectOptions(screen.getByLabelText("Versandweg"), "hand");
    const dialogButtons = screen.getAllByRole("button", { name: "Als versendet markieren" });
    await user.click(dialogButtons[dialogButtons.length - 1] as HTMLElement);
    await waitFor(() => expect(backend.fns["payments:markLetterSent"]).toHaveBeenCalled());
    expect(backend.fns["payments:markLetterSent"]?.mock.calls[0]?.[0]).toMatchObject({ id: "l1", channel: "hand" });
  });

  test("the letter button is hidden for the auditor (no payments.receipt)", () => {
    backend.data["members:me"] = { role: "auditor" };
    renderWithIntl(
      <LetterButton label="Zinsforderung stellen" request={{ kind: "interest_claim", invoiceId: "d1" as never }} />,
    );
    expect(screen.queryByRole("button", { name: "Zinsforderung stellen" })).not.toBeInTheDocument();
  });
});
