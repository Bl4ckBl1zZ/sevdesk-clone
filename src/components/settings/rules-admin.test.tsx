import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { RulesAdmin } from "./rules-admin";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  can: true,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    return { id: "o9", warnings: [] };
  },
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/catalog/shared", async (orig) => ({
  ...(await orig<typeof import("@/components/catalog/shared")>()),
  useCan: () => backend.can,
}));

beforeEach(() => {
  backend.calls = [];
  backend.can = true;
  backend.data = {
    "settings:ruleOverview": {
      tables: [
        {
          id: "basiszinssatz",
          group: "basiszinssatz",
          overridable: "basiszinssatz",
          rows: [
            {
              rowId: "basiszinssatz@2026-07-01",
              validFrom: "2026-07-01",
              value: "1,27 %",
              source: "Deutsche Bundesbank",
              origin: "code",
              current: false,
            },
            {
              rowId: "override:o1",
              validFrom: "2027-01-01",
              value: "1,5 %",
              source: "BBk-Mitteilung",
              origin: "override",
              current: true,
              overrideId: "o1",
            },
          ],
        },
        {
          id: "standard",
          group: "taxRate",
          overridable: "taxRate",
          rows: [
            {
              rowId: "standard@2021-01-01",
              validFrom: "2021-01-01",
              value: "19 % (S)",
              source: "§ 12 Abs. 1 UStG",
              origin: "code",
              current: true,
            },
          ],
        },
      ],
      overrides: [
        {
          id: "o1",
          ruleSet: "basiszinssatz",
          tableId: "basiszinssatz",
          validFrom: "2027-01-01",
          value: { rateBp: 150 },
          source: "BBk-Mitteilung",
          locked: true,
        },
        {
          id: "o2",
          ruleSet: "noteText",
          tableId: "ku_note_19",
          validFrom: "2028-01-01",
          value: { de: "x", en: "y" },
          source: "Eigene Formulierung",
          locked: false,
        },
      ],
    },
  };
});

describe("RulesAdmin (SET-120 … SET-123)", () => {
  test("SET-120 lists the shipped tables with source, validity, origin and the row effective today", () => {
    renderWithIntl(<RulesAdmin />);
    expect(screen.getByRole("heading", { name: "Basiszinssatz" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Steuersätze" })).toBeInTheDocument();
    const current = screen.getAllByText("aktuell");
    expect(current).toHaveLength(2);
    expect(screen.getByText("§ 12 Abs. 1 UStG")).toBeInTheDocument();
    expect(screen.getAllByText("Überschreibung").length).toBeGreaterThan(0);
    expect(screen.getByText("01.07.2026 – offen")).toBeInTheDocument();
  });

  test("SET-120 a rule table scrolls in a keyboard-focusable region named after its group (axe scrollable-region-focusable)", () => {
    renderWithIntl(<RulesAdmin />);
    const region = screen.getByRole("region", { name: "Basiszinssatz" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(within(region).getByRole("table")).toBeInTheDocument();
  });

  test("SET-123 a locked override cannot be deleted; an unreferenced one is deleted with a reason", async () => {
    const user = userEvent.setup();
    renderWithIntl(<RulesAdmin />);
    const list = screen.getByTestId("rule-overrides");
    const items = within(list).getAllByRole("listitem");
    expect(within(items[0] as HTMLElement).getByText("gesperrt")).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).queryByRole("button", { name: /Löschen/ })).toBeNull();
    await user.click(within(items[1] as HTMLElement).getByRole("button", { name: /Löschen/ }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Löschen" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Begründung (mindestens 5 Zeichen)"), "Nicht mehr nötig");
    await user.click(confirm);
    expect(backend.calls).toEqual([
      { name: "settings:deleteRuleOverride", args: { id: "o2", reason: "Nicht mehr nötig" } },
    ]);
  });

  test("SET-121 the owner adds a Basiszinssatz override in percent with a mandatory source", async () => {
    const user = userEvent.setup();
    renderWithIntl(<RulesAdmin />);
    await user.click(screen.getByRole("button", { name: "Überschreibung hinzufügen" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Gültig ab/), "2027-07-01");
    await user.type(within(dialog).getByLabelText(/Satz in %/), "-0,5");
    await user.click(within(dialog).getByRole("button", { name: "Überschreibung hinzufügen" }));
    expect(backend.calls).toEqual([]);
    expect(
      within(dialog).getByText("Bitte eine Quelle angeben (z. B. Link zur Bundesbank-Mitteilung)."),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Quelle/), "Bundesbank 28.06.2027");
    await user.click(within(dialog).getByRole("button", { name: "Überschreibung hinzufügen" }));
    expect(backend.calls).toEqual([
      {
        name: "settings:addRuleOverride",
        args: {
          values: {
            ruleSet: "basiszinssatz",
            tableId: "basiszinssatz",
            validFrom: "2027-07-01",
            rateBp: -50,
            source: "Bundesbank 28.06.2027",
          },
        },
      },
    ]);
  });

  test("SET-121 viewers see the tables but no add or delete actions", () => {
    backend.can = false;
    renderWithIntl(<RulesAdmin />);
    expect(screen.queryByRole("button", { name: "Überschreibung hinzufügen" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Löschen/ })).toBeNull();
  });
});
