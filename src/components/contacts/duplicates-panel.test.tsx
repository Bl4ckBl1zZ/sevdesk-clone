import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { DuplicatesPanel, MergeDialog } from "./duplicates-panel";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  queries: [] as { name: string; args: unknown }[],
  calls: [] as { name: string; args: unknown }[],
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown, enabled = true) => {
    if (!enabled) return undefined;
    const name = getFunctionName(ref as never);
    backend.queries.push({ name, args });
    return backend.data[name];
  },
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    return null;
  },
}));
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const winner = {
  _id: "c1",
  number: "10001",
  kind: "organization",
  displayName: "Muster GmbH",
  organizationName: "Muster GmbH",
  vatId: "DE123456789",
  paymentTerms: { dueDays: 14 },
};
const loser = {
  _id: "c9",
  number: "10009",
  kind: "organization",
  displayName: "Muster G.m.b.H.",
  organizationName: "Muster G.m.b.H.",
  vatId: "DE987654321",
  paymentTerms: { dueDays: 30 },
};
const preview = {
  contacts: [winner, loser],
  moves: { addresses: 2, channels: 3, activities: 4, customerPrices: 1, persons: 0 },
  stays: { vatIdChecks: 5 },
};

beforeEach(() => {
  backend.queries = [];
  backend.calls = [];
  router.push.mockReset();
  backend.data = {
    "members:me": { role: "owner" },
    "contacts:duplicates": [
      {
        score: 0.87,
        reasons: ["vat_id", "invoice_email"],
        a: { _id: "c1", number: "10001", displayName: "Muster GmbH", kind: "organization" },
        b: { _id: "c9", number: "10009", displayName: "Muster G.m.b.H.", kind: "organization" },
      },
      {
        score: 0.5,
        reasons: ["name"],
        a: { _id: "c3", number: "10003", displayName: "Anna Berg", kind: "person" },
        b: { _id: "c4", number: "10004", displayName: "Berg AG", kind: "organization" },
      },
    ],
    "contacts:mergePreview": preview,
    "contacts:options": [
      { _id: "c1", number: "10001", displayName: "Muster GmbH", kind: "organization" },
      { _id: "c9", number: "10009", displayName: "Muster G.m.b.H.", kind: "organization" },
    ],
  };
});

describe("duplicates and merge (F02 §6.5)", () => {
  test("CON-131 pairs show score, reasons and links; merge only for pairs of the same kind", () => {
    renderWithIntl(<DuplicatesPanel />);
    const [first, second] = screen.getAllByRole("listitem") as HTMLElement[];
    expect(first).toHaveTextContent("Ähnlichkeit: 87 %");
    expect(first).toHaveTextContent("Gründe: gleiche USt-IdNr, gleiche Rechnungs-E-Mail");
    expect(within(first as HTMLElement).getByRole("link", { name: "Muster GmbH (10001)" })).toHaveAttribute(
      "href",
      "/kontakte/c1",
    );
    expect(within(first as HTMLElement).getByRole("button", { name: "Zusammenführen" })).toBeInTheDocument();
    expect(within(second as HTMLElement).queryByRole("button", { name: "Zusammenführen" })).toBeNull();
    expect(second).toHaveTextContent("ähnlicher Name, gleiche PLZ");
  });

  test("CON-131 „Kein Duplikat“ dismisses the pair", async () => {
    renderWithIntl(<DuplicatesPanel />);
    await userEvent.click(screen.getAllByRole("button", { name: "Kein Duplikat" })[0] as HTMLElement);
    expect(backend.calls).toEqual([{ name: "contacts:dismissDuplicate", args: { a: "c1", b: "c9" } }]);
  });

  test("CON-131 empty and loading states; viewers cannot merge", () => {
    backend.data["contacts:duplicates"] = [];
    const { unmount } = renderWithIntl(<DuplicatesPanel />);
    expect(screen.getByText("Keine möglichen Duplikate gefunden.")).toBeInTheDocument();
    unmount();
    backend.data["contacts:duplicates"] = undefined;
    const second = renderWithIntl(<DuplicatesPanel />);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    second.unmount();
    backend.data["contacts:duplicates"] = [
      {
        score: 0.9,
        reasons: ["iban"],
        a: { _id: "c1", number: "10001", displayName: "Muster GmbH", kind: "organization" },
        b: { _id: "c9", number: "10009", displayName: "Muster G.m.b.H.", kind: "organization" },
      },
    ];
    backend.data["members:me"] = { role: "viewer" };
    renderWithIntl(<DuplicatesPanel />);
    expect(screen.queryByRole("button", { name: "Zusammenführen" })).toBeNull();
  });

  test("CON-134 the merge dialog lists what moves and stays; a VAT conflict must be confirmed", async () => {
    renderWithIntl(<DuplicatesPanel />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Zusammenführen" }));
    const dialog = await screen.findByRole("dialog", { name: "Kontakte zusammenführen" });
    expect(dialog).toHaveTextContent(
      "Wird übernommen: 2 Adressen, 3 Kommunikationsdaten, 4 Verlaufseinträge, 1 Kundenpreise, 0 Ansprechpartner.",
    );
    expect(dialog).toHaveTextContent("Bleibt beim bisherigen Kontakt: 5 USt-IdNr-Prüfnachweise");
    const confirm = within(dialog).getByRole("button", { name: "Endgültig zusammenführen" });
    expect(confirm).toBeDisabled();
    // CON-132: per-field choice of the value (USt-IdNr from the loser)
    const vat = within(dialog).getByRole("radiogroup", { name: "USt-IdNr" });
    await user.click(within(vat).getByRole("radio", { name: "DE987654321" }));
    expect(within(dialog).getByRole("radiogroup", { name: "Zahlungsbedingungen" })).toHaveTextContent("30 Tage");
    await user.click(within(dialog).getByRole("checkbox", { name: /Unterschiedliche USt-IdNrs/ }));
    await user.click(confirm);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/kontakte/c1"));
    expect(backend.calls.find((c) => c.name === "contacts:merge")?.args).toEqual({
      values: { winnerId: "c1", loserIds: ["c9"], fieldChoices: { vatId: "c9" }, confirmVatConflict: true },
    });
  });

  test("CON-132 from the contact page the second contact is searched; switching the winner swaps the pair", async () => {
    const onClose = vi.fn();
    renderWithIntl(<MergeDialog winnerId={"c1" as never} kind="organization" onClose={onClose} />);
    const dialog = await screen.findByRole("dialog");
    const user = userEvent.setup();
    await user.type(within(dialog).getByLabelText("Zweiten Kontakt suchen"), "Muster");
    await waitFor(() =>
      expect(backend.queries.filter((q) => q.name === "contacts:options").at(-1)?.args).toEqual({
        kind: "organization",
        q: "Muster",
      }),
    );
    // the winner itself is not offered
    expect(within(dialog).queryByRole("radio", { name: "Muster GmbH (10001)" })).toBeNull();
    await user.click(within(dialog).getByRole("radio", { name: "Muster G.m.b.H. (10009)" }));
    expect(backend.queries.filter((q) => q.name === "contacts:mergePreview").at(-1)?.args).toEqual({
      winnerId: "c1",
      loserIds: ["c9"],
    });
    const winnerSet = within(dialog).getByRole("group", { name: "Zielkontakt (bleibt erhalten)" });
    await user.click(within(winnerSet).getByRole("radio", { name: "Muster G.m.b.H. (10009)" }));
    expect(backend.queries.filter((q) => q.name === "contacts:mergePreview").at(-1)?.args).toEqual({
      winnerId: "c9",
      loserIds: ["c1"],
    });
    await user.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(onClose).toHaveBeenCalled();
  });
});
