import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { MessageTextDialog } from "./message-text-dialog";

const backend = vi.hoisted(() => ({ data: {} as Record<string, unknown>, mutation: vi.fn(), action: vi.fn() }));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({ useMutation: () => backend.mutation, useAction: () => backend.action }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const BODY = "Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie unsere Rechnung RE-2026-0042 vom 12.10.2026.";

beforeEach(() => {
  backend.data = {
    "invoices:messageText": {
      subject: "Rechnung RE-2026-0042 – Muster Design GmbH",
      body: BODY,
      templateName: null,
      recipients: ["rechnung@mueller.de"],
      mailto: "mailto:rechnung%40mueller.de?subject=Rechnung&body=Text",
    },
  };
});

describe("SND-19 „E-Mail-Text kopieren“", () => {
  test("SND-19 T-SND-014 address, subject and body each copy to the clipboard; mailto link; nothing is written", async () => {
    const user = userEvent.setup();
    renderWithIntl(<MessageTextDialog id={"d1" as never} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Betreff")).toHaveValue("Rechnung RE-2026-0042 – Muster Design GmbH");
    expect(screen.getByLabelText("Text")).toHaveValue(BODY);
    await user.click(screen.getByRole("button", { name: "rechnung@mueller.de kopieren" }));
    await expect(navigator.clipboard.readText()).resolves.toBe("rechnung@mueller.de");
    await user.click(screen.getByRole("button", { name: "Betreff kopieren" }));
    await expect(navigator.clipboard.readText()).resolves.toBe("Rechnung RE-2026-0042 – Muster Design GmbH");
    await user.click(screen.getByRole("button", { name: "Text kopieren" }));
    await expect(navigator.clipboard.readText()).resolves.toBe(BODY);
    expect(screen.getByRole("link", { name: "Im E-Mail-Programm öffnen" })).toHaveAttribute(
      "href",
      "mailto:rechnung%40mueller.de?subject=Rechnung&body=Text",
    );
    expect(backend.mutation).not.toHaveBeenCalled();
    expect(backend.action).not.toHaveBeenCalled();
  });

  test("SND-19 without an invoice e-mail on the contact the dialog says so", () => {
    backend.data["invoices:messageText"] = { ...(backend.data["invoices:messageText"] as object), recipients: [] };
    renderWithIntl(<MessageTextDialog id={"d1" as never} onClose={vi.fn()} />);
    expect(screen.getByText("Beim Kontakt ist keine Rechnungs-E-Mail hinterlegt.")).toBeInTheDocument();
  });
});
