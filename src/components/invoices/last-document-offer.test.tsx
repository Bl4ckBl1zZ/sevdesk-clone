import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { emptyEditor, emptyLine, isEmptyContent } from "./editor-model";
import { InvoiceEditor } from "./invoice-editor";

const backend = vi.hoisted(() => ({ data: {} as Record<string, unknown>, calls: [] as string[] }));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) => {
    const name = getFunctionName(ref as never);
    if (enabled) backend.calls.push(name);
    return enabled ? backend.data[name] : undefined;
  },
}));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

beforeEach(() => {
  backend.calls = [];
  backend.data = {
    "members:me": { role: "owner" },
    "invoices:lastDocument": {
      id: "inv1",
      number: "RE-2026-0041",
      documentDate: "2026-09-30",
      content: {
        lines: [
          {
            kind: "item",
            name: "Wartung",
            quantityMilli: 2000,
            unitCode: "HUR",
            unitPriceMicros: 1_000_000,
            vatRateKey: "standard",
            productType: "service",
          },
        ],
        subject: "Wartung Oktober",
        headText: "Vielen Dank für Ihren Auftrag.",
      },
    },
  };
});

describe("DOC-36 „Letztes Dokument übernehmen“", () => {
  test("DOC-36 T-DOC-041 a new empty draft with a contact offers the last document; taking over fills lines and texts", async () => {
    const user = userEvent.setup();
    renderWithIntl(<InvoiceEditor presetContactId="c1" />);
    const offer = screen.getByTestId("last-document-offer");
    expect(offer).toHaveTextContent("RE-2026-0041 vom 30.09.2026");
    await user.click(screen.getByRole("button", { name: "Letztes Dokument übernehmen" }));
    expect(screen.getByLabelText("Betreff")).toHaveValue("Wartung Oktober");
    expect(screen.getByDisplayValue("Wartung")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Vielen Dank für Ihren Auftrag.")).toBeInTheDocument();
    expect(screen.queryByTestId("last-document-offer")).toBeNull();
  });

  test("DOC-36 no offer without a contact, and „Nein, danke“ hides it", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithIntl(<InvoiceEditor />);
    expect(backend.calls).not.toContain("invoices:lastDocument");
    expect(screen.queryByTestId("last-document-offer")).toBeNull();
    unmount();
    renderWithIntl(<InvoiceEditor presetContactId="c1" />);
    await user.click(screen.getByRole("button", { name: "Nein, danke" }));
    expect(screen.queryByTestId("last-document-offer")).toBeNull();
  });

  test("DOC-36 the offer only shows while nothing has been typed", () => {
    const s = emptyEditor("2026-10-12");
    expect(isEmptyContent(s)).toBe(true);
    expect(isEmptyContent({ ...s, subject: "x" })).toBe(false);
    expect(isEmptyContent({ ...s, lines: [{ ...emptyLine(), name: "Beratung" }] })).toBe(false);
  });
});
