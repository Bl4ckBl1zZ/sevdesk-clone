import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { OccurrenceTable, RecurringEditor } from "./recurring-editor";
import { emptyRecurringForm, toTemplateValues } from "./recurring-model";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  args: {} as Record<string, unknown[]>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  query: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.args[name] ??= [];
    backend.args[name].push(args);
    return backend.data[name];
  },
}));
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue(null);
    return backend.mutations[name];
  };
  return { useMutation: fn, useAction: fn, useConvex: () => ({ query: backend.query }) };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: backend.replace }),
  usePathname: () => "/rechnungen/wiederkehrend/neu",
  useSearchParams: () => new URLSearchParams(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

function initialValues(over: { finalize?: boolean } = {}) {
  const f = emptyRecurringForm("2026-11-01", "c1");
  return toTemplateValues({
    ...f,
    name: "Wartung",
    contractReference: "V-2026-7",
    endMode: "count",
    maxCount: "12",
    finalize: over.finalize ?? false,
    editor: { ...f.editor, lines: [{ ...f.editor.lines[0], name: "Pauschale", price: "50,00" } as never] },
  }).values;
}

const occurrence = (over: Record<string, unknown> = {}) => ({
  date: "2026-11-01",
  period: { from: "2026-11-01", to: "2026-11-30" },
  grossCents: 5_950,
  currency: "EUR",
  rates: [{ category: "S", rateBp: 1_900 }],
  decision: "XRechnung (B2B)",
  hints: [],
  blocking: null,
  ...over,
});

beforeEach(() => {
  backend.data = {
    "members:me": { role: "owner" },
    "contacts:options": [{ _id: "c1", displayName: "Muster GmbH", number: "10001" }],
    "products:options": [{ _id: "p1", name: "Wartungsstunde", number: "A-1" }],
    "lookups:listUnits": [{ code: "C62", labelDe: "Stück" }],
  };
  backend.args = {};
  backend.mutations = {};
  backend.query = vi.fn();
  backend.replace = vi.fn();
  vi.clearAllMocks();
});

describe("Vorlagen-Editor (F04 §6.5)", () => {
  test("REC-13 the right pane lists the next occurrences with period, amount, rates, ER-03 and hints", () => {
    backend.data["recurring:occurrences"] = [
      occurrence(),
      occurrence({
        date: "2026-12-01",
        period: { from: "2026-12-01", to: "2026-12-31" },
        rates: [],
        decision: null,
        hints: ["Steuersatzänderung zum 01.01.2027"],
        blocking: "KU-Grenze überschritten",
      }),
    ];
    renderWithIntl(<RecurringEditor id={"rt1" as never} initial={initialValues()} version={2} />);
    const next = screen.getByRole("region", { name: "Nächste Termine" });
    expect(next).toHaveTextContent("59,50 € · 01.11.2026");
    const items = within(screen.getByTestId("occurrences")).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Zeitraum: 01.11.2026 – 30.11.2026");
    expect(items[0]).toHaveTextContent("S 19 % · E-Rechnung: XRechnung (B2B)");
    expect(items[1]).toHaveTextContent("—");
    expect(items[1]).toHaveTextContent("Steuersatz-Hinweis: Steuersatzänderung zum 01.01.2027");
    expect(items[1]).toHaveTextContent("Hinweis: KU-Grenze überschritten");
    // REC-11 editing a template only affects future invoices.
    expect(screen.getByText(/Änderungen wirken nur auf künftige Rechnungen/)).toBeInTheDocument();
    expect(screen.getByLabelText("Name der Vorlage")).toHaveValue("Wartung");
    expect(screen.getByLabelText("Vertragsreferenz (BT-12)")).toHaveValue("V-2026-7");
    expect(screen.getByLabelText("Ende")).toHaveValue("count");
    expect(screen.getByLabelText("Anzahl Rechnungen")).toHaveValue("12");
    expect(screen.getByLabelText("Kunde")).toHaveValue("c1");
  });

  test("REC-13 the preview states loading, invalid input and no further dates", () => {
    const { rerender } = renderWithIntl(<OccurrenceTable rows={undefined} />);
    expect(screen.getByText("Termine werden berechnet …")).toBeInTheDocument();
    rerender(<OccurrenceTable rows={null} />);
    expect(screen.getByText(/Für die Vorschau bitte Kunde, Positionen/)).toBeInTheDocument();
    rerender(<OccurrenceTable rows={[]} />);
    expect(screen.getByText("Keine weiteren Termine.")).toBeInTheDocument();
  });

  test("REC-11 saving an edited template sends the version and the changed values", async () => {
    const user = userEvent.setup();
    backend.data["recurring:occurrences"] = [occurrence()];
    renderWithIntl(<RecurringEditor id={"rt1" as never} initial={initialValues()} version={4} inlineActions />);
    const name = screen.getByLabelText("Name der Vorlage");
    await user.clear(name);
    await user.type(name, "Wartung Premium");
    await user.selectOptions(screen.getByLabelText("Intervall"), "P3M");
    await user.selectOptions(screen.getByLabelText("Ende"), "date");
    await user.type(screen.getByLabelText("Letzte Rechnung spätestens am"), "2027-12-31");
    await user.click(screen.getByRole("button", { name: "Vorlage speichern" }));
    await waitFor(() => expect(backend.mutations["recurring:update"]).toHaveBeenCalledTimes(1));
    const args = backend.mutations["recurring:update"]?.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      id: "rt1",
      version: 4,
      confirmAutomation: false,
      values: {
        name: "Wartung Premium",
        contractReference: "V-2026-7",
        schedule: { interval: "P3M", firstDate: "2026-11-01", endDate: "2027-12-31", billing: "in_advance" },
        automation: { finalize: false },
      },
    });
    expect(args.values.schedule.maxCount).toBeUndefined();
    expect(args.values.draft.lines[0]).toMatchObject({ name: "Pauschale", unitPriceMicros: 500_000 });
    expect(toast.success).toHaveBeenCalledWith("Vorlage gespeichert");
  });

  test("REC-14 the first activation of „Fertigstellen“ asks for confirmation before creating", async () => {
    const user = userEvent.setup();
    backend.mutations["recurring:create"] = vi.fn().mockResolvedValue({ id: "rt9" });
    renderWithIntl(<RecurringEditor initial={initialValues()} />);
    expect(screen.queryByText(/Änderungen wirken nur auf künftige Rechnungen/)).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Fertigstellen" }));
    await user.click(screen.getByRole("button", { name: "Vorlage speichern" }));
    const dialog = await screen.findByRole("dialog", { name: "Automatisches Fertigstellen aktivieren?" });
    expect(dialog).toHaveTextContent("Versendet wird nie automatisch");
    expect(backend.mutations["recurring:create"]).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Automatik aktivieren" }));
    await waitFor(() =>
      expect(backend.mutations["recurring:create"]).toHaveBeenCalledWith({
        values: expect.objectContaining({ name: "Wartung", automation: { finalize: true } }),
        confirmAutomation: true,
      }),
    );
    expect(backend.replace).toHaveBeenCalledWith("/rechnungen/wiederkehrend/rt9");
  });

  test("REC-14 automation set up via the API waits for the owner's confirmation", () => {
    renderWithIntl(<RecurringEditor id={"rt1" as never} initial={initialValues({ finalize: true })} version={1} />);
    expect(screen.getByRole("checkbox", { name: "Fertigstellen" })).toBeChecked();
    expect(screen.getByText(/wirkt erst nach Ihrer Bestätigung/)).toBeInTheDocument();
  });

  test("REC-03 an invalid form is not saved and shows the first input error", async () => {
    const user = userEvent.setup();
    renderWithIntl(<RecurringEditor />);
    await user.click(screen.getByRole("button", { name: "Vorlage speichern" }));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(backend.mutations["recurring:create"]).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Name der Vorlage"), "Miete");
    await user.selectOptions(screen.getByLabelText("Ende"), "count");
    await user.type(screen.getByLabelText("Anzahl Rechnungen"), "0");
    await user.click(screen.getByRole("button", { name: "Vorlage speichern" }));
    expect(backend.mutations["recurring:create"]).not.toHaveBeenCalled();
  });

  test("REC-04 a started template locks first date, interval and billing", () => {
    renderWithIntl(<RecurringEditor id={"rt1" as never} initial={initialValues()} version={1} started />);
    expect(screen.getByLabelText("Erste Rechnung")).toBeDisabled();
    expect(screen.getByLabelText("Intervall")).toBeDisabled();
    expect(screen.getByLabelText("Abrechnung")).toBeDisabled();
    expect(screen.getByText(/sind nach der ersten erzeugten Rechnung fest/)).toBeInTheDocument();
  });

  test("REC-01 choosing a customer applies its defaults and adding a product appends its line with warnings", async () => {
    const user = userEvent.setup();
    backend.data["invoices:draftDefaults"] = {
      priceMode: "gross",
      language: "de",
      currency: "EUR",
      paymentTerms: { dueDays: 30 },
      bankAccountId: null,
      paymentMethodId: null,
      buyerReference: "LEITWEG-1",
    };
    backend.query = vi.fn().mockResolvedValue({
      line: {
        kind: "item",
        name: "Wartungsstunde",
        quantityMilli: 1_000,
        unit: "HUR",
        unitPriceMicros: 900_000,
        vatRateKey: "standard",
        discountBp: 0,
      },
      warnings: ["Kundenpreis abgelaufen"],
    });
    renderWithIntl(<RecurringEditor />);
    await user.type(screen.getByLabelText("Kunde suchen"), "Muster");
    expect(backend.args["contacts:options"]?.at(-1)).toEqual({ q: "Muster" });
    await user.selectOptions(screen.getByLabelText("Kunde"), "c1");
    expect(backend.args["invoices:draftDefaults"]?.at(-1)).toEqual({ contactId: "c1" });
    await waitFor(() => expect(screen.getByLabelText("Zahlungsziel (Tage)")).toHaveValue("30"));
    expect(screen.getByLabelText("Preise")).toHaveValue("gross");
    expect(screen.getByLabelText("Leitweg-ID / Käuferreferenz")).toHaveValue("LEITWEG-1");
    await user.selectOptions(screen.getByLabelText(/Produkt hinzufügen/), "p1");
    await waitFor(() =>
      expect(backend.query).toHaveBeenCalledWith(expect.anything(), {
        productId: "p1",
        contactId: "c1",
        referenceDate: expect.any(String),
        priceMode: "gross",
        currency: "EUR",
      }),
    );
    expect(toast.warning).toHaveBeenCalledWith("Kundenpreis abgelaufen");
    await waitFor(() => expect(screen.getByDisplayValue("Wartungsstunde")).toBeInTheDocument());
  });
});
