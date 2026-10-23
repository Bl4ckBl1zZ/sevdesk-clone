import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { type VoucherDetailData, VoucherEditor } from "./voucher-editor";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("@/components/catalog/shared", async (orig) => {
  const actual = await orig<typeof import("@/components/catalog/shared")>();
  return { ...actual, useCan: () => true };
});
vi.mock("@/components/auth/fresh-action", () => ({ useFreshAction: () => (fn: () => unknown) => fn() }));
vi.mock("./voucher-files", () => ({ VoucherFiles: () => null }));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue({ version: 4 });
    return backend.mutations[name];
  },
  useAction: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue({});
    return backend.mutations[name];
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const subtypeError = { code: "tax_payment_subtype", message: "Bitte die Art der Steuerzahlung angeben." };

const detail = (
  over: Record<string, unknown> = {},
  errors: { code: string; message: string }[] = [],
): VoucherDetailData =>
  ({
    voucher: {
      _id: "v1",
      version: 3,
      direction: "expense",
      kind: "tax_payment",
      status: "draft",
      supplierName: "Finanzamt Berlin-Mitte",
      documentDate: "2026-10-12",
      currency: "EUR",
      priceMode: "gross",
      taxRule: "no_input_vat",
      ...over,
    },
    lines: [{ account: "1780", netCents: 50_000, vatRateBp: 0, vatCents: 0, grossCents: 50_000, description: "USt" }],
    files: [],
    check: { errors, warnings: [], infos: [], inputVatAtRisk: [], totals: undefined },
  }) as unknown as VoucherDetailData;

beforeEach(() => {
  backend.data = { "vouchers:options": { accounts: [], taxRules: [], ku: false, corporation: false } };
  backend.mutations = {};
});

describe("BNK-064 TAX-018 tax-payment fields in the voucher editor", () => {
  test("BNK-064 a tax_payment draft without type shows the missing type on the field; choosing type and period saves them", async () => {
    const user = userEvent.setup();
    renderWithIntl(<VoucherEditor data={detail({}, [subtypeError])} />);
    const subtype = screen.getByRole("combobox", { name: "Art der Steuerzahlung" });
    expect(subtype).toHaveAttribute("aria-invalid", "true");
    expect(subtype).toHaveAttribute("aria-required", "true");
    expect(subtype).toHaveAccessibleDescription("Bitte die Art der Steuerzahlung angeben.");
    // No period field before a type that has one is chosen.
    expect(screen.queryByRole("textbox", { name: "Zeitraum" })).toBeNull();
    await user.selectOptions(subtype, "USt-Vorauszahlung");
    const period = screen.getByRole("textbox", { name: "Zeitraum" });
    expect(period).toHaveAccessibleDescription(/MM\/JJJJ/);
    await user.type(period, "09/2026");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    const update = backend.mutations["vouchers:updateDraft"];
    expect(update).toHaveBeenCalledTimes(1);
    expect(update?.mock.calls[0]?.[0]).toMatchObject({
      id: "v1",
      input: { kind: "tax_payment", taxPayment: { subtype: "ust_prepayment", period: "2026-09" } },
    });
  });

  test("BNK-064 an invalid period is reported on the field in German and nothing is saved", async () => {
    const user = userEvent.setup();
    renderWithIntl(<VoucherEditor data={detail({ taxPayment: { subtype: "ust_annual" } })} />);
    const period = screen.getByRole("textbox", { name: "Zeitraum" });
    await user.type(period, "letztes Jahr");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(period).toHaveAttribute("aria-invalid", "true");
    expect(period).toHaveAccessibleDescription("Bitte den Zeitraum als JJJJ, MM/JJJJ oder Qn/JJJJ angeben.");
    expect(backend.mutations["vouchers:updateDraft"]).not.toHaveBeenCalled();
  });

  test("BNK-064 the stored type and period are shown; other kinds have no tax-payment fields", () => {
    const { unmount } = renderWithIntl(
      <VoucherEditor data={detail({ taxPayment: { subtype: "sondervorauszahlung", period: "2026" } })} />,
    );
    expect(screen.getByRole("combobox", { name: "Art der Steuerzahlung" })).toHaveValue("sondervorauszahlung");
    expect(screen.getByRole("textbox", { name: "Zeitraum" })).toHaveValue("2026");
    unmount();
    renderWithIntl(<VoucherEditor data={detail({ kind: "standard" })} />);
    expect(screen.queryByRole("combobox", { name: "Art der Steuerzahlung" })).toBeNull();
  });
});
