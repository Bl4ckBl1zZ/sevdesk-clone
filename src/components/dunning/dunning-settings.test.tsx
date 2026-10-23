import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { DunningSettings } from "./dunning-settings";

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
vi.mock("convex/react", () => {
  const fn = (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue({ warnings: [] });
    return backend.mutations[name];
  };
  return { useMutation: fn, useAction: fn };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const step = (level: number, over: Record<string, unknown> = {}) => ({
  level,
  daysAfter: level === 1 ? 7 : 14,
  title: level === 1 ? "Zahlungserinnerung" : `${level - 1}. Mahnung`,
  feeCents: level === 1 ? 0 : 250,
  addInterest: level > 1,
  addFlatFee40: level === 2,
  newDueDays: 7,
  autoFinalize: false,
  ...over,
});

const policy = (over: Record<string, unknown> = {}) => ({
  id: "pol1",
  name: "Unternehmer",
  isDefault: true,
  appliesTo: { consumer: false, business: true },
  steps: [step(1), step(2)],
  dueSoonDays: 3,
  dueSoonTodo: false,
  minOpenAmountCents: 500,
  pauseOnPartialPaymentDays: 14,
  stopAfterLastLevel: true,
  seeded: false,
  version: 2,
  warnings: [],
  ...over,
});

const receivables = {
  autoCreateReminders: true,
  autoFinalizeReminders: false,
  postalDeliveryDays: 3,
  bankDataMaxAgeDays: 7,
  defaultStartViaReminder: "after_printed_deadline",
  reopenGraceDays: 7,
  agingBucketEdgesDays: [30, 60, 90],
};

beforeEach(() => {
  backend.mutations = {};
  vi.clearAllMocks();
  backend.data = {
    "members:me": { role: "owner" },
    "dunning:settings": {
      policies: [
        policy(),
        policy({
          id: "pol2",
          name: "Verbraucher",
          isDefault: false,
          appliesTo: { consumer: true, business: false },
          steps: [step(1)],
          version: 1,
          warnings: [
            {
              code: "b2c_fee",
              severity: "W",
              message: "Mahngebühr über 5,00 € – nur tatsächliche Kosten.",
              field: "steps.0.feeCents",
            },
          ],
        }),
      ],
      receivables,
      textTemplates: [
        { id: "tpl1", name: "Mahnung höflich", kind: "document_head", level: 2, language: "de" },
        { id: "tpl2", name: "Fuß", kind: "document_foot", level: null, language: "de" },
      ],
    },
  };
});

describe("Einstellungen › Mahnwesen (F05 §6.6)", () => {
  test("DUN-001 policies list badges, the step timeline and the summary; warnings are shown", () => {
    renderWithIntl(<DunningSettings />);
    const list = screen.getByTestId("dunning-policies");
    const b2b = list.querySelector("[data-policy='Unternehmer']") as HTMLElement;
    expect(within(b2b).getByText("Standard")).toBeInTheDocument();
    expect(within(b2b).getByRole("list", { name: "Ablauf der Mahnstufen" })).toHaveTextContent(
      "+7 T. nach Fälligkeit: Zahlungserinnerung",
    );
    expect(b2b).toHaveTextContent("+14 T. nach Zugang: 1. Mahnung · 2,50 €");
    expect(b2b).toHaveTextContent("Mindestbetrag 5,00 € · Pause nach Teilzahlung 14 Tage");
    // The default cannot be archived or made default again.
    expect(within(b2b).queryByRole("button", { name: "Archivieren" })).toBeNull();
    const b2c = list.querySelector("[data-policy='Verbraucher']") as HTMLElement;
    expect(within(b2c).getAllByText("Verbraucher")).toHaveLength(2);
    expect(within(b2c).getByTestId("policy-warnings")).toHaveTextContent("nur tatsächliche Kosten");
  });

  test("DUN-001 „Als Standard“ updates the policy with isDefault and its version", async () => {
    const user = userEvent.setup();
    renderWithIntl(<DunningSettings />);
    const b2c = screen.getByTestId("dunning-policies").querySelector("[data-policy='Verbraucher']") as HTMLElement;
    await user.click(within(b2c).getByRole("button", { name: "Als Standard" }));
    await waitFor(() => expect(backend.mutations["dunning:updatePolicy"]).toHaveBeenCalled());
    expect(backend.mutations["dunning:updatePolicy"]?.mock.calls[0]?.[0]).toMatchObject({
      id: "pol2",
      version: 1,
      values: { name: "Verbraucher", isDefault: true, appliesTo: { consumer: true, business: false } },
    });
    expect(toast.success).toHaveBeenCalledWith("„Verbraucher“ ist jetzt Standard.");
  });

  test("DUN-001 archiving asks first and calls archive", async () => {
    const user = userEvent.setup();
    renderWithIntl(<DunningSettings />);
    const b2c = screen.getByTestId("dunning-policies").querySelector("[data-policy='Verbraucher']") as HTMLElement;
    await user.click(within(b2c).getByRole("button", { name: "Archivieren" }));
    const dialog = await screen.findByRole("dialog", { name: "„Verbraucher“ archivieren?" });
    await user.click(within(dialog).getByRole("button", { name: "Archivieren" }));
    await waitFor(() => expect(backend.mutations["dunning:archive"]).toHaveBeenCalledWith({ id: "pol2" }));
  });

  test("DUN-001 a new policy: levels follow the step order; a consumer-only policy never adds the 40 €", async () => {
    const user = userEvent.setup();
    renderWithIntl(<DunningSettings />);
    await user.click(screen.getByRole("button", { name: "Neue Richtlinie" }));
    const editor = screen.getByTestId("policy-editor");
    expect(within(editor).getByRole("heading", { name: "Neue Mahnrichtlinie" })).toBeInTheDocument();
    await user.type(within(editor).getByLabelText("Name"), "Privat");
    await user.click(within(editor).getByRole("checkbox", { name: "Verbraucher (B2C)" }));
    await user.click(within(editor).getByRole("checkbox", { name: "Unternehmer (B2B)" }));
    expect(within(editor).queryByRole("checkbox", { name: "40-€-Pauschale (nur Unternehmer)" })).toBeNull();
    await user.click(within(editor).getByRole("button", { name: "Mahnstufe hinzufügen" }));
    const step2 = editor.querySelector("[data-step='2']") as HTMLElement;
    expect(within(step2).getByLabelText("Bezeichnung")).toHaveValue("2. Mahnung");
    expect(within(step2).getByLabelText("Tage nach Zugang der vorigen Mahnung")).toHaveValue(14);
    const fee = within(step2).getByLabelText("Mahngebühr (€)");
    await user.clear(fee);
    await user.type(fee, "2,50");
    await user.selectOptions(within(step2).getByLabelText("Textvorlage"), "tpl1");
    expect(within(step2).queryByRole("option", { name: /Fuß/ })).toBeNull();
    await user.click(within(editor).getByRole("button", { name: "Richtlinie speichern" }));
    await waitFor(() => expect(backend.mutations["dunning:createPolicy"]).toHaveBeenCalled());
    const values = (
      backend.mutations["dunning:createPolicy"]?.mock.calls[0]?.[0] as { values: Record<string, unknown> } | undefined
    )?.values;
    expect(values).toMatchObject({
      name: "Privat",
      appliesTo: { consumer: true, business: false },
      minOpenAmountCents: 500,
      pauseOnPartialPaymentDays: 14,
    });
    expect(values.steps).toEqual([
      expect.objectContaining({ level: 1, title: "Zahlungserinnerung", feeCents: 0, addFlatFee40: false }),
      expect.objectContaining({ level: 2, feeCents: 250, addInterest: true, textTemplateId: "tpl1" }),
    ]);
    expect(screen.queryByTestId("policy-editor")).toBeNull();
  });

  test("DUN-001 editing shows the server warnings and an invalid input blocks saving", async () => {
    const user = userEvent.setup();
    renderWithIntl(<DunningSettings />);
    const b2c = screen.getByTestId("dunning-policies").querySelector("[data-policy='Verbraucher']") as HTMLElement;
    await user.click(within(b2c).getByRole("button", { name: "Bearbeiten" }));
    const editor = screen.getByTestId("policy-editor");
    expect(within(editor).getByRole("heading", { name: "„Verbraucher“ bearbeiten" })).toBeInTheDocument();
    expect(within(editor).getAllByTestId("policy-warnings")).toHaveLength(2);
    await user.clear(within(editor).getByLabelText("Name"));
    await user.click(within(editor).getByRole("button", { name: "Richtlinie speichern" }));
    expect(within(editor).getByRole("alert")).toBeInTheDocument();
    expect(backend.mutations["dunning:updatePolicy"]).not.toHaveBeenCalled();
    await user.click(within(editor).getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByTestId("policy-editor")).toBeNull();
  });

  test("DUN-057 global switches save auto-finalise, the default-start route and the aging buckets", async () => {
    const user = userEvent.setup();
    renderWithIntl(<DunningSettings />);
    const global = screen.getByTestId("dunning-global");
    await user.click(within(global).getByRole("checkbox", { name: /Mahnungen automatisch fertigstellen/ }));
    await user.click(within(global).getByRole("radio", { name: /Am Tag nach Zugang der Mahnung/ }));
    const buckets = within(global).getByLabelText("Altersstufen Offene Posten (Tage)");
    expect(buckets).toHaveValue("30, 60, 90");
    await user.clear(buckets);
    await user.type(buckets, "90, 30");
    await user.click(within(global).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(backend.mutations["dunning:saveSettings"]).toHaveBeenCalledWith({
        values: {
          ...receivables,
          autoFinalizeReminders: true,
          defaultStartViaReminder: "zugang_plus_1",
          agingBucketEdgesDays: [30, 90],
        },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Einstellungen gespeichert.");
  });

  test("DUN-057 invalid bucket edges show an error instead of saving", async () => {
    const user = userEvent.setup();
    renderWithIntl(<DunningSettings />);
    const global = screen.getByTestId("dunning-global");
    const buckets = within(global).getByLabelText("Altersstufen Offene Posten (Tage)");
    await user.clear(buckets);
    await user.type(buckets, "30, x");
    await user.click(within(global).getByRole("button", { name: "Speichern" }));
    expect(within(global).getByRole("alert")).toHaveTextContent("Bitte die Eingaben prüfen");
    expect(backend.mutations["dunning:saveSettings"]).not.toHaveBeenCalled();
  });

  test("DUN-001 a bookkeeper sees the settings read-only without edit buttons", () => {
    backend.data["members:me"] = { role: "bookkeeper" };
    renderWithIntl(<DunningSettings />);
    expect(screen.getByText(/Nur der Inhaber kann das Mahnwesen ändern/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Neue Richtlinie" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Bearbeiten" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Speichern" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Mahnungen automatisch erstellen/ })).toBeDisabled();
  });

  test("DUN-001 seeded defaults can be copied; missing setup shows a hint; loading is busy", async () => {
    const user = userEvent.setup();
    backend.data["dunning:settings"] = {
      policies: [policy({ id: "seed:0", seeded: true })],
      receivables: null,
      textTemplates: [],
    };
    renderWithIntl(<DunningSettings />);
    expect(screen.getByText(/Die Standardrichtlinien werden beim ersten Mahnlauf/)).toBeInTheDocument();
    expect(screen.getByText("Bitte zuerst die Einrichtung abschließen.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Als Kopie bearbeiten" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Unternehmer (Kopie)");
    expect(screen.getByRole("checkbox", { name: "Als Standard für diese Kundengruppe" })).not.toBeChecked();
  });
});
