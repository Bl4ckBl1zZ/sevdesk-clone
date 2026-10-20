import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { defaultPeriod, KennzahlenCard } from "./kennzahlen-card";

const backend = vi.hoisted(() => ({ calls: [] as { name: string; args: unknown }[], can: new Set<string>() }));
vi.mock("convex/react", () => ({
  useAction: (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    return { name: "UStVA_2026-09_Kennzahlen.pdf", mime: "application/pdf", data: new ArrayBuffer(4) };
  },
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/catalog/shared", async (orig) => ({
  ...(await orig<typeof import("@/components/catalog/shared")>()),
  useCan: (p: string) => backend.can.has(p),
}));

beforeEach(() => {
  backend.calls = [];
  backend.can = new Set(["tax.read"]);
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});

describe("KennzahlenCard (EXP-020)", () => {
  test("EXP-020 default periods: previous month for the UStVA, previous quarter for the ZM", () => {
    expect(defaultPeriod("ustva", "2026-01-10")).toBe("2025-12");
    expect(defaultPeriod("ustva", "2026-10-20")).toBe("2026-09");
    expect(defaultPeriod("zm", "2026-02-01")).toBe("2025-Q4");
    expect(defaultPeriod("zm", "2026-10-20")).toBe("2026-Q3");
  });

  test("EXP-020 downloads the chosen sheet as PDF or CSV", async () => {
    renderWithIntl(<KennzahlenCard />);
    expect(screen.getByRole("heading", { name: "Kennzahlen" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Meldung"), "zm");
    const period = screen.getByLabelText("Zeitraum");
    await user.clear(period);
    await user.type(period, "2026-Q3");
    await user.click(screen.getByRole("button", { name: "CSV herunterladen" }));
    expect(backend.calls[0]).toEqual({
      name: "kennzahlenNode:download",
      args: { form: "zm", period: "2026-Q3", format: "csv" },
    });
    expect(screen.getByRole("link", { name: "Zur Umsatzsteuer-Voranmeldung" })).toHaveAttribute(
      "href",
      "/steuern/ustva",
    );
  });

  test("hidden without tax.read", () => {
    backend.can = new Set();
    const { container } = renderWithIntl(<KennzahlenCard />);
    expect(container).toBeEmptyDOMElement();
  });
});
