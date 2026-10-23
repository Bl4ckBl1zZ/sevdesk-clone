import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ContactDunningCard } from "./contact-dunning-card";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue(null);
    return backend.mutations[name];
  };
  return { useMutation: fn, useAction: fn };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  backend.mutations = {};
  vi.clearAllMocks();
  backend.data = {
    "members:me": { role: "owner" },
    "dunning:contactDunning": {
      dunning: { policyId: "pol2", blocked: false, calendarDueDateAgreed: false },
      policies: [
        { id: "pol1", name: "Unternehmer", seeded: false },
        { id: "pol2", name: "Verbraucher", seeded: false },
      ],
    },
  };
});

describe("ContactDunningCard (F05 §6.7, DUN-002, PAY-053)", () => {
  test("DUN-002 the contact's policy, „Nicht mahnen“ with a reason and the calendar due date are saved", async () => {
    const user = userEvent.setup();
    renderWithIntl(<ContactDunningCard contactId="c1" />);
    const card = screen.getByTestId("contact-dunning");
    expect(within(card).getByLabelText("Mahnrichtlinie")).toHaveValue("pol2");
    await user.selectOptions(within(card).getByLabelText("Mahnrichtlinie"), "pol1");
    await user.click(within(card).getByRole("checkbox", { name: "Nicht mahnen" }));
    const save = within(card).getByRole("button", { name: "Speichern" });
    expect(save).toBeDisabled();
    await user.type(within(card).getByLabelText("Grund"), "Großkunde");
    await user.click(within(card).getByRole("checkbox", { name: /Zahlungstermin kalendermäßig vereinbart/ }));
    await user.click(save);
    await waitFor(() =>
      expect(backend.mutations["dunning:saveContact"]).toHaveBeenCalledWith({
        contactId: "c1",
        policyId: "pol1",
        blocked: true,
        blockedReason: "Großkunde",
        calendarDueDateAgreed: true,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Mahnwesen-Einstellungen gespeichert.");
  });

  test("PAY-053 a viewer cannot change the contact's dunning settings; no stored policies shows the hint", () => {
    backend.data["members:me"] = { role: "viewer" };
    backend.data["dunning:contactDunning"] = { dunning: null, policies: [] };
    renderWithIntl(<ContactDunningCard contactId="c1" />);
    expect(screen.getByLabelText("Mahnrichtlinie")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Nicht mahnen" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Speichern" })).toBeNull();
    expect(screen.getByText(/Eigene Richtlinien legen Sie unter Einstellungen/)).toBeInTheDocument();
  });

  test("DUN-002 nothing renders while loading", () => {
    backend.data["dunning:contactDunning"] = undefined;
    const { container } = renderWithIntl(<ContactDunningCard contactId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
