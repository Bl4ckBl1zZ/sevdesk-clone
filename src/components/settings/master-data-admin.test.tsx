import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { MasterDataAdmin } from "./master-data-admin";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue(null);
    return backend.mutations[name];
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  backend.mutations = {};
  toast.success.mockReset();
  toast.warning.mockReset();
  backend.data = {
    "lookups:listUnits": [
      { unitId: "u1", code: "HUR", labelDe: "Std.", labelEn: "h", isSystem: true, archivedAt: null },
      {
        unitId: "u2",
        code: "XPP",
        labelDe: "Palettenplatz",
        labelEn: "pallet place",
        isSystem: false,
        archivedAt: null,
      },
    ],
    "lookups:listPaymentMethods": [
      {
        paymentMethodId: "p1",
        name: "Überweisung",
        text: "Bitte überweisen",
        kind: "transfer",
        isDefault: true,
        active: true,
      },
      {
        paymentMethodId: "p2",
        name: "Barzahlung",
        text: "Betrag in bar erhalten.",
        kind: "cash",
        isDefault: false,
        active: true,
      },
    ],
    "lookups:listTags": [{ tagId: "t1", name: "Wichtig", color: "red", usage: 0 }],
    "lookups:listCustomFields": [
      {
        customFieldId: "f1",
        entity: "contact",
        key: "projekt",
        label: "Projekt",
        type: "text",
        options: [],
        printOnDocuments: true,
        required: false,
        values: 0,
      },
    ],
    "lookups:listCostCenters": [],
  };
});

describe("Stammdaten (F01 SET-090…097)", () => {
  test("SET-090 SET-091 system units show a badge and cannot be deleted; a custom unit with an invalid code is not sent", async () => {
    renderWithIntl(<MasterDataAdmin />);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByText("System")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).queryByRole("button", { name: /Löschen/ })).toBeNull();
    expect(within(rows[1] as HTMLElement).getByRole("button", { name: /Löschen/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Einheit hinzufügen" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect((await within(dialog).findAllByText("Bitte einen Einheitencode wählen.")).length).toBeGreaterThan(0);
    expect(backend.mutations["lookups:createUnit"]).not.toHaveBeenCalled();
  });

  test("SET-093 AO-04 the payment methods tab says that cash is a payment on an invoice and the software is no Kasse", async () => {
    renderWithIntl(<MasterDataAdmin />);
    await userEvent.click(screen.getByRole("tab", { name: "Zahlungsarten" }));
    expect(
      await screen.findByText("Barzahlung wird als Zahlung auf eine Rechnung gebucht. Diese Software ist keine Kasse."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Überweisung · Zahlungsartcode \(BT-81\): 58 \(SEPA\) bzw. 30/)).toBeInTheDocument();
    expect(screen.getByText(/Barzahlung · Zahlungsartcode \(BT-81\): 10/)).toBeInTheDocument();
  });

  test("SET-095 SET-096 editing a custom field keeps key and area fixed", async () => {
    renderWithIntl(<MasterDataAdmin />);
    await userEvent.click(screen.getByRole("tab", { name: "Eigene Felder" }));
    await userEvent.click(await screen.findByRole("button", { name: /Bearbeiten.*Projekt/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/Schlüssel/)).toBeDisabled();
    expect(within(dialog).getByLabelText("Bereich")).toBeDisabled();
    await userEvent.selectOptions(within(dialog).getByLabelText("Typ"), "select");
    await userEvent.type(within(dialog).getByLabelText("Optionen"), "Intern{enter}Extern");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(backend.mutations["lookups:updateCustomField"]).toHaveBeenCalledWith({
      customFieldId: "f1",
      values: expect.objectContaining({ key: "projekt", type: "select", options: "Intern\nExtern" }),
    });
  });

  test("SET-097 a long cost centre number is saved with the DATEV warning", async () => {
    renderWithIntl(<MasterDataAdmin />);
    await userEvent.click(screen.getByRole("tab", { name: "Kostenstellen" }));
    backend.mutations["lookups:saveCostCenter"] = vi
      .fn()
      .mockResolvedValue({ id: "c1", warnings: ["Ältere DATEV-Versionen akzeptieren nur 8 Zeichen."] });
    await userEvent.click(await screen.findByRole("button", { name: "Kostenstelle hinzufügen" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Nummer/), "PROJEKT2026");
    await userEvent.type(within(dialog).getByLabelText(/Bezeichnung/), "Projekt");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(toast.warning).toHaveBeenCalledWith("Ältere DATEV-Versionen akzeptieren nur 8 Zeichen.");
  });

  test("SET-094 tags show their usage and can be deleted", async () => {
    renderWithIntl(<MasterDataAdmin />);
    await userEvent.click(screen.getByRole("tab", { name: "Tags" }));
    expect(await screen.findByText("nicht verwendet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Löschen.*Wichtig/ }));
    expect(backend.mutations["lookups:deleteTag"]).toHaveBeenCalledWith({ tagId: "t1" });
  });
});
