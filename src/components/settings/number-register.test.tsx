import { screen, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { NumberRegister } from "./number-register";

const backend = vi.hoisted(() => ({ data: {} as Record<string, unknown>, args: [] as unknown[] }));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    if (name === "settings:numberRegister") backend.args.push(args);
    return backend.data[name];
  },
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));

beforeEach(() => {
  backend.args = [];
  backend.data = {
    "settings:listNumberRanges": [{ rangeId: "r1", name: "Rechnungen", format: "RE-{YYYY}-{####}" }],
    "settings:numberRegister": {
      range: { name: "Rechnungen", format: "RE-{YYYY}-{####}", startValue: 1 },
      periods: ["2026"],
      truncated: false,
      rows: [
        {
          number: "RE-2026-0005",
          docType: "invoice",
          periodKey: "2026",
          counter: 5,
          assignedAt: Date.UTC(2026, 9, 12, 10),
          status: "issued",
          imported: false,
          link: "/rechnungen/d2",
        },
        {
          number: "RE-2026-0001",
          docType: "invoice",
          periodKey: "2026",
          counter: 1,
          assignedAt: Date.UTC(2026, 9, 1, 10),
          status: "cancelled_by_storno",
          imported: false,
          link: "/rechnungen/d1",
        },
      ],
      gaps: [
        { periodKey: "2026", from: 2, to: 3, reason: "Abstimmung mit dem Altsystem" },
        { periodKey: "2026", from: 4, to: 4, reason: null },
      ],
    },
  };
});

describe("NumberRegister (SET-063, DOC-39)", () => {
  test("SET-063 lists the numbers with status and document links and the gap report with reasons", () => {
    renderWithIntl(<NumberRegister initialRange="r1" initialPeriod="2026" />);
    expect(backend.args.at(-1)).toEqual({ rangeId: "r1", periodKey: "2026" });
    const table = screen.getByTestId("number-register");
    expect(within(table).getByText("RE-2026-0005")).toBeTruthy();
    expect(within(table).getByText("storniert")).toBeTruthy();
    expect(within(table).getByRole("link", { name: "RE-2026-0001 Öffnen" }).getAttribute("href")).toBe(
      "/rechnungen/d1",
    );
    const gaps = screen.getByTestId("register-gaps");
    expect(gaps.textContent).toContain("2026: 2–3");
    expect(gaps.textContent).toContain("Abstimmung mit dem Altsystem");
    expect(gaps.textContent).toContain("unerklärt");
  });
});
