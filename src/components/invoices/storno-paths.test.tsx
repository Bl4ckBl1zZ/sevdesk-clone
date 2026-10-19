import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { StornoDialog } from "./corrections";

const backend = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn().mockResolvedValue(null),
  useAction: () => vi.fn().mockResolvedValue(null),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const MESSAGE =
  "Rechnung RE-2026-0042 ist (teil)bezahlt. Stornieren ist nur bei unbezahlten Rechnungen möglich. Erstellen Sie eine Rechnungskorrektur und erfassen Sie die Erstattung – oder lösen Sie zuerst die Zahlungszuordnung, falls sie falsch ist.";

beforeEach(() => {
  backend.data = {
    "members:me": { role: "owner" },
    "corrections:cancelPreview": {
      original: { number: "RE-2026-0042", documentDate: "2026-10-01" },
      guard: { code: "storno_paid_invoice", message: MESSAGE },
      mirror: null,
      notice: "",
    },
  };
});

describe("Storno of a paid invoice (PAY-034, EC-074)", () => {
  test("PAY-034 the block message links to both paths: Rechnungskorrektur and the payment allocation", async () => {
    const onCorrection = vi.fn();
    const onClose = vi.fn();
    renderWithIntl(<StornoDialog id={"d1" as never} onClose={onClose} onCorrection={onCorrection} />);
    const alert = screen.getByTestId("storno-blocked");
    expect(alert).toHaveTextContent("(teil)bezahlt");
    const paths = within(alert).getByTestId("paid-storno-paths");
    await userEvent.click(within(paths).getByRole("button", { name: "Zahlungszuordnung prüfen" }));
    expect(onClose).toHaveBeenCalled();
    await userEvent.click(within(paths).getByRole("button", { name: "Rechnungskorrektur erstellen" }));
    expect(onCorrection).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stornorechnung erstellen" })).toBeDisabled();
  });
});
