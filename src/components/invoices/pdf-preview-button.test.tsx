import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DraftValues } from "@/domain/schemas/documents";
import { renderWithIntl } from "@/i18n/test-utils";
import { InvoiceEditor } from "./invoice-editor";

const backend = vi.hoisted(() => ({ data: {} as Record<string, unknown>, save: vi.fn() }));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? backend.data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => ({
  useMutation: () => backend.save,
  useAction: () => vi.fn(),
  useConvex: () => ({ query: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const check = (canFinalize: boolean) => ({
  canFinalize,
  findings: [],
  lines: [],
  einvoice: { allowed: ["none"], format: "none", decision: "NOT_REQUIRED" },
});

const opened: { href: string; closed: boolean }[] = [];
beforeEach(() => {
  opened.length = 0;
  backend.save = vi.fn(async () => ({ version: 2 }));
  backend.data = { "members:me": { role: "owner" }, "invoices:check": check(true) };
  vi.spyOn(window, "open").mockImplementation(() => {
    const w = { href: "", closed: false };
    opened.push(w);
    return {
      location: {
        set href(v: string) {
          w.href = v;
        },
      },
      close: () => {
        w.closed = true;
      },
    } as never;
  });
});
afterEach(() => vi.restoreAllMocks());

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

describe("„PDF-Vorschau“ in the draft editor (F04 §4.4.7, DOC-42)", () => {
  test("DOC-42 a saved draft opens its watermarked PDF in a new tab", async () => {
    const user = userEvent.setup();
    renderWithIntl(<InvoiceEditor id={"d1" as never} initial={initial} version={1} />);
    await user.click(screen.getByRole("button", { name: "PDF-Vorschau" }));
    expect(opened).toEqual([{ href: "/dokumente/d1/vorschau", closed: false }]);
  });

  test("DOC-42 with popups blocked the preview opens in the same tab", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "open").mockReturnValue(null);
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as never);
    renderWithIntl(<InvoiceEditor id={"d1" as never} initial={initial} version={1} />);
    await user.click(screen.getByRole("button", { name: "PDF-Vorschau" }));
    expect(assign).toHaveBeenCalledWith("/dokumente/d1/vorschau");
  });

  test("DOC-42 a new, unsaved draft has no preview yet", () => {
    renderWithIntl(<InvoiceEditor />);
    expect(screen.queryByRole("button", { name: "PDF-Vorschau" })).toBeNull();
  });

  test("DOC-42 the preview is disabled while the saved draft has blocking errors", () => {
    backend.data["invoices:check"] = check(false);
    renderWithIntl(<InvoiceEditor id={"d1" as never} initial={initial} version={1} />);
    expect(screen.getByRole("button", { name: "PDF-Vorschau" })).toBeDisabled();
  });
});
