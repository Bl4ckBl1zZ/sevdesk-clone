import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DraftValues } from "@/domain/schemas/documents";
import { renderWithIntl } from "@/i18n/test-utils";
import { InvoiceEditor } from "./invoice-editor";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  finalize: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? backend.data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(async () => ({ version: 2 })),
  useAction: () => backend.finalize,
  useConvex: () => ({ query: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: backend.toastError, info: vi.fn(), warning: vi.fn() },
}));

const check = (canFinalize: boolean) => ({
  canFinalize,
  findings: [],
  lines: [],
  buyer: { name: "Muster GmbH" },
  totals: { netCents: 20_000, vatCents: 0, grossCents: 20_000, payableCents: 20_000, groups: [], lineNets: [20_000] },
  einvoice: { allowed: ["none"], format: "none", decision: "NOT_REQUIRED" },
});

const initial = {
  type: "invoice",
  contactId: "c1",
  supplyDateMode: "explicit",
  supplyDate: { kind: "date", date: "2026-10-09" },
  currency: "EUR",
  priceMode: "net",
  paymentTerms: { dueDays: 30 },
  language: "de",
  lines: [
    {
      kind: "item",
      productType: "service",
      name: "Beratung",
      quantityMilli: 1_000,
      unitCode: "HUR",
      unitPriceMicros: 1_000_000,
      vatRateKey: "standard",
    },
  ],
} as DraftValues;

const editor = (askFinalize: boolean) => (
  <InvoiceEditor id={"d1" as never} initial={initial} version={4} askFinalize={askFinalize} />
);

beforeEach(() => {
  backend.finalize = vi.fn(async () => ({ number: "RE-1013" }));
  backend.toastError.mockClear();
  backend.data = { "members:me": { role: "owner" }, "invoices:check": check(true) };
  window.history.replaceState(null, "", "/rechnungen/d1?fertigstellen=1");
});

describe("DOC-61 finalise dialog requested by a link", () => {
  test("DOC-61 T-DOC-045 the dialog opens by itself, and nothing is finalised before the confirm click", async () => {
    const user = userEvent.setup();
    renderWithIntl(editor(true));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Muster GmbH");
    expect(backend.finalize).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Jetzt fertigstellen" }));
    await waitFor(() => expect(backend.finalize).toHaveBeenCalledWith({ id: "d1", version: 4 }));
  });

  test("DOC-61 T-DOC-045 cancelling leaves the draft alone, and the parameter is gone so a reload asks nothing", async () => {
    const user = userEvent.setup();
    renderWithIntl(editor(true));
    await screen.findByRole("dialog");
    expect(window.location.pathname + window.location.search).toBe("/rechnungen/d1");
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(backend.finalize).not.toHaveBeenCalled();
  });

  test("DOC-61 T-DOC-045 the dialog waits for the compliance check before it opens", async () => {
    backend.data["invoices:check"] = undefined;
    const { rerender } = renderWithIntl(editor(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.search).toBe("?fertigstellen=1");
    backend.data["invoices:check"] = check(true);
    rerender(editor(true));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  test("DOC-61 T-DOC-045 a draft with blocking errors gets no dialog but says why", async () => {
    backend.data["invoices:check"] = check(false);
    renderWithIntl(editor(true));
    await waitFor(() => expect(backend.toastError).toHaveBeenCalledOnce());
    expect(backend.toastError.mock.calls[0]?.[0]).toMatch(/noch nicht fertiggestellt/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backend.finalize).not.toHaveBeenCalled();
  });

  test("DOC-61 without the request the editor opens no dialog", () => {
    window.history.replaceState(null, "", "/rechnungen/d1");
    renderWithIntl(editor(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
