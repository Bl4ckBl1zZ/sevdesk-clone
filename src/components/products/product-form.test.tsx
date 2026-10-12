import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { productSchema } from "@/domain/schemas/products";
import { renderWithIntl } from "@/i18n/test-utils";
import { formFromProduct, ProductForm } from "./product-form";

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
    backend.mutations[name] ??= vi.fn().mockResolvedValue({ id: "p1", number: "ART-00001", warnings: [] });
    return backend.mutations[name];
  },
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  backend.mutations = {};
  router.push.mockReset();
  backend.data = {
    "products:nextNumber": "ART-00001",
    "products:categories": [],
    "lookups:listUnits": [
      { unitId: "u1", code: "HUR", labelDe: "Stunde", labelEn: "hour", isSystem: true, archivedAt: null },
      { unitId: "u2", code: "C62", labelDe: "Stück", labelEn: "piece", isSystem: true, archivedAt: null },
      { unitId: "u3", code: "DAY", labelDe: "Tag", labelEn: "day", isSystem: true, archivedAt: null },
    ],
    "lookups:listTags": [],
    "lookups:listCustomFields": [],
  };
});

describe("product form (F03 §6.4)", () => {
  test("PRD-002 an empty article number shows the automatic preview", () => {
    renderWithIntl(<ProductForm />);
    expect(screen.getByText("Leer lassen: wird automatisch vergeben (ART-00001).")).toBeInTheDocument();
  });

  test("PRD-011 PRD-013 typing the gross price stores the gross side; the net view is derived at today's rate", async () => {
    renderWithIntl(<ProductForm />);
    await userEvent.type(screen.getByLabelText(/^Name/), "Beratung");
    await userEvent.type(screen.getByLabelText("VK brutto"), "119");
    expect(screen.getByLabelText("VK netto")).toHaveValue("100,00");
    expect(screen.getByText("berechnet mit 19 %")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Produkt anlegen" }));
    const create = backend.mutations["products:create"];
    expect(create).toHaveBeenCalledOnce();
    const { values } = (create?.mock.calls[0]?.[0] ?? {}) as {
      values: { priceMode: string; price: string; name: string };
    };
    expect(values).toMatchObject({ name: "Beratung", priceMode: "gross", price: "119" });
    expect(router.push).toHaveBeenCalledWith("/produkte/p1");
  });

  test("PRD-035 the extra-unit price is derived from the base price and the factor", async () => {
    renderWithIntl(<ProductForm />);
    await userEvent.type(screen.getByLabelText("VK netto"), "1,5");
    await userEvent.click(screen.getByRole("button", { name: "Zusatzeinheit hinzufügen" }));
    await userEvent.type(screen.getByLabelText("Faktor (Basiseinheiten)"), "8");
    const row = screen.getByRole("button", { name: "Zusatzeinheit 1 entfernen" }).parentElement as HTMLElement;
    expect(within(row).getByText("12,00 €")).toBeInTheDocument();
  });

  test("PRD-024 an exempt product requires a § 4 UStG reason before saving", async () => {
    renderWithIntl(<ProductForm />);
    await userEvent.type(screen.getByLabelText(/^Name/), "Versicherung");
    await userEvent.selectOptions(screen.getByLabelText("Steuersatz"), "exempt");
    await userEvent.click(screen.getByRole("button", { name: "Produkt anlegen" }));
    expect(
      await screen.findAllByText("Für steuerfreie Produkte ist ein Befreiungsgrund (§ 4 UStG) erforderlich."),
    ).not.toHaveLength(0);
    expect(backend.mutations["products:create"]).not.toHaveBeenCalled();
  });

  test("PRD-011 a stored product round-trips through the shared schema with its entered side", () => {
    const values = productSchema.parse(
      formFromProduct({
        _id: "p1",
        _creationTime: 0,
        number: "ART-00007",
        numberNormalized: "ART-00007",
        name: "Pfand",
        searchText: "pfand",
        type: "good",
        unitCode: "C62",
        priceMode: "gross",
        unitPriceMicros: 1_234_567_8,
        purchasePriceMicros: 5000,
        vatRateKey: "reduced",
        laborCostShareBp: 6250,
        extraUnits: [{ unitCode: "DAY", factorMilli: 1500 }],
        tags: [],
        customFields: {},
        active: true,
        version: 1,
      } as never),
    );
    expect(values).toMatchObject({
      priceMode: "gross",
      unitPriceMicros: 12_345_678,
      purchasePriceMicros: 5000,
      laborCostShareBp: 6250,
      extraUnits: [{ unitCode: "DAY", factorMilli: 1500 }],
    });
  });
});
