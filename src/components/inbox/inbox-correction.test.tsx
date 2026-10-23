import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { InboxCorrection } from "./inbox-correction";

const backend = vi.hoisted(() => ({
  view: null as unknown,
  mark: vi.fn(),
  retract: vi.fn(),
  exportPdf: vi.fn(),
}));
vi.mock("@/hooks/use-authed-query", () => ({ useAuthedQuery: () => backend.view }));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => (getFunctionName(ref as never).includes("retract") ? backend.retract : backend.mark),
  useAction: () => backend.exportPdf,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

const TEXT =
  "Muster GmbH\n\nBitte um Rechnungskorrektur – Ihre Rechnung Nr. R-1\n\n– Geschäftsregelfehler (BR-DE-17): Rechnungsart unzulässig";
const view = (over: Record<string, unknown> = {}) => ({
  available: true,
  subject: "Bitte um Rechnungskorrektur – Ihre Rechnung Nr. R-1",
  text: TEXT,
  artifact: null,
  effectiveMarkId: null,
  marks: [],
  ...over,
});

beforeEach(() => {
  backend.mark = vi.fn().mockResolvedValue({ sendLogId: "s1" });
  backend.retract = vi.fn().mockResolvedValue(null);
  backend.exportPdf = vi.fn().mockResolvedValue({ artifactId: "a1", sha256: "ab", url: null, text: TEXT });
});

describe("„Korrektur anfordern“ (INB-046)", () => {
  test("INB-046 shows the letter; marking needs the exported PDF; nothing for items without findings", async () => {
    backend.view = view({ available: false, text: null });
    const { unmount } = renderWithIntl(<InboxCorrection id="inb1" canWrite />);
    expect(screen.queryByTestId("inbox-correction")).toBeNull();
    unmount();

    backend.view = view();
    renderWithIntl(<InboxCorrection id="inb1" canWrite />);
    await userEvent.click(screen.getByRole("button", { name: "Korrektur anfordern" }));
    expect(screen.getByTestId("correction-text")).toHaveTextContent("Geschäftsregelfehler (BR-DE-17)");
    expect(screen.getByText(/Die App versendet nichts/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Als versendet markieren" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Als PDF exportieren" }));
    expect(backend.exportPdf).toHaveBeenCalledWith({ id: "inb1" });
  });

  test("INB-046 MAIL-02 mark with date and channel; „Sonstiges“ needs a note; retraction needs 10 characters", async () => {
    backend.view = view({
      artifact: { id: "a1", sha256: "abcdef0123", name: "Rechnungskorrektur.pdf", createdAt: 0, url: null },
      marks: [
        {
          id: "s0",
          kind: "mark_sent",
          sentOn: "2026-10-20",
          channel: "post",
          note: null,
          at: 1,
          actor: "user:u1",
          retractsId: null,
          retracted: false,
        },
      ],
    });
    renderWithIntl(<InboxCorrection id="inb1" canWrite />);
    expect(screen.getByTestId("correction-marks")).toHaveTextContent("Versendet am 20.10.2026 · Post");
    await userEvent.click(screen.getByRole("button", { name: "Korrektur anfordern" }));
    await userEvent.click(screen.getByRole("button", { name: "Als versendet markieren" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText("Versandweg"), "other");
    const confirm = within(dialog).getByRole("button", { name: "Als versendet markieren" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Hinweis (Pflicht bei „Sonstiges“)"), "Lieferantenportal");
    await userEvent.click(confirm);
    expect(backend.mark).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inb1", channel: "other", note: "Lieferantenportal" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Versandmarkierung zurücknehmen" }));
    const retractDialog = screen.getByRole("dialog");
    const field = within(retractDialog).getByLabelText("Grund (mindestens 10 Zeichen)");
    await userEvent.type(field, "zu kurz");
    const retractButton = within(retractDialog).getByRole("button", { name: "Versandmarkierung zurücknehmen" });
    expect(retractButton).toBeDisabled();
    await userEvent.type(field, " – falscher Empfänger");
    await userEvent.click(retractButton);
    expect(backend.retract).toHaveBeenCalledWith({
      id: "inb1",
      retractsId: "s0",
      reason: "zu kurz – falscher Empfänger",
    });
  });
});
