import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ReminderDetail } from "./reminder-detail";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  push: vi.fn(),
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
    backend.mutations[name] ??= vi.fn().mockResolvedValue(null);
    return backend.mutations[name];
  };
  return { useMutation: fn, useAction: fn };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: backend.push, replace: vi.fn() }),
  usePathname: () => "/mahnungen/rem1",
  useSearchParams: () => new URLSearchParams(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const view = (over: Record<string, unknown> = {}) => ({
  id: "rem1",
  number: null,
  status: "draft",
  level: 2,
  title: "1. Mahnung",
  invoiceId: "inv1",
  invoiceNumber: "RE-2026-0042",
  contactId: "c1",
  contactName: "Muster GmbH",
  documentDate: null,
  openAmountCents: 119_000,
  feeCents: 250,
  interestCents: 1_234,
  flatFee40Cents: 4_000,
  totalCents: 125_484,
  newDueDate: "2099-11-06",
  defaultStartDate: "2026-09-01",
  createdByRun: false,
  finalizedAt: null,
  sentOn: null,
  zugang: null,
  artifactStatus: null,
  cancellation: null,
  version: 3,
  ...over,
});

const segments = [
  { from: "2026-09-01", to: "2026-10-15", days: 45, principalCents: 119_000, rateBp: 1_027, amountCents: 1_234 },
];

const draftData = (over: Record<string, unknown> = {}) => ({
  reminder: view(),
  detail: {
    invoiceId: "inv1",
    level: 2,
    title: "1. Mahnung",
    feeCents: 250,
    interestCents: 1_234,
    flatFee40Cents: 4_000,
    openAmountCents: 119_000,
    totalCents: 125_484,
    newDueDate: "2099-11-06",
    manual: {},
  },
  texts: { subject: "", headText: "Sehr geehrte Damen und Herren,", footText: "Mit freundlichen Grüßen" },
  isConsumer: false,
  invoice: {
    id: "inv1",
    number: "RE-2026-0042",
    documentDate: "2026-08-01",
    dueDate: "2026-08-31",
    openAmountCents: 119_000,
    payableCents: 119_000,
    zugang: { date: "2026-08-04", basis: "post" },
    sentOn: "2026-08-01",
  },
  case: {
    status: "active",
    currentLevel: 1,
    flatFeeCharged: false,
    defaultStartDate: "2026-09-01",
    defaultRoute: null,
  },
  findings: [{ code: "fee_b2c", severity: "W", message: "Mahngebühr über 5,00 € – nur tatsächliche Kosten." }],
  computed: {
    feeCents: 250,
    interestCents: 1_234,
    flatFee40Cents: 4_000,
    totalCents: 125_484,
    newDueDate: "2099-11-06",
    interestSegments: segments,
    inDefault: true,
    defaultStartDate: "2026-09-01",
    flatFeeAlreadyClaimed: false,
  },
  claim: null,
  snapshot: null,
  artifacts: [],
  sendLog: [],
  effectiveMarkId: null,
  defaultMarkSelection: [],
  today: "2026-10-16",
  ...over,
});

const finalData = (over: Record<string, unknown> = {}) =>
  draftData({
    reminder: view({
      number: "MA-2026-0007",
      status: "sent",
      documentDate: "2026-10-10",
      sentOn: "2026-10-11",
      zugang: { date: "2026-10-14", basis: "post" },
      artifactStatus: "ready",
    }),
    detail: { ...draftData().detail, interestSegments: segments },
    findings: [],
    computed: null,
    snapshot: { texts: { headText: "Kopftext der Mahnung", footText: "Fußtext der Mahnung" }, buyer: {} },
    artifacts: [
      {
        _id: "a1",
        kind: "pdf",
        variant: "original",
        name: "MA-2026-0007.pdf",
        sha256: "ab".repeat(32),
        bytes: 10,
        createdAt: 1,
      },
    ],
    sendLog: [
      {
        _id: "s1",
        kind: "mark_sent",
        sentOn: "2026-10-11",
        channel: "post",
        note: "Einschreiben",
        retractsId: null,
        at: 1,
        actor: "user:u1",
      },
    ],
    effectiveMarkId: "s1",
    ...over,
  });

beforeEach(() => {
  backend.data = { "members:me": { role: "owner" } };
  backend.mutations = {};
  backend.push = vi.fn();
  vi.clearAllMocks();
});

describe("ReminderDetail (F05 §6.5)", () => {
  test("DUN-004 loading shows a busy placeholder; an unknown id shows „Mahnung nicht gefunden“", () => {
    const { container, unmount } = renderWithIntl(<ReminderDetail id="rem1" />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    unmount();
    backend.data["dunning:reminder"] = null;
    renderWithIntl(<ReminderDetail id="rem1" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Mahnung nicht gefunden");
  });

  test("DUN-005 the draft shows the claim, the compliance panel and the computed interest", () => {
    backend.data["dunning:reminder"] = draftData();
    renderWithIntl(<ReminderDetail id="rem1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Mahnentwurf Stufe 2" })).toBeInTheDocument();
    const claim = screen.getByTestId("claim-summary");
    expect(within(claim).getByText("1.190,00 €")).toBeInTheDocument();
    expect(within(claim).getByTestId("claim-total")).toHaveTextContent("1.254,84 €");
    expect(within(claim).getByText("40,00 €")).toBeInTheDocument();
    const panel = screen.getByTestId("reminder-compliance");
    expect(panel).toHaveTextContent("Verzug seit 01.09.2026 (Verzugsbeginn)");
    expect(panel).toHaveTextContent("04.08.2026 (Post)");
    expect(within(panel).getByRole("link", { name: "RE-2026-0042" })).toHaveAttribute("href", "/rechnungen/inv1");
    expect(within(panel).getByRole("status")).toHaveTextContent("Bereit zum Fertigstellen.");
    expect(within(panel).getByTestId("reminder-findings")).toHaveTextContent("Mahngebühr über 5,00 €");
    expect(screen.getByText("Berechnet: 12,34 € (Verzug seit 01.09.2026)")).toBeInTheDocument();
    expect(screen.getByText("Laut Mahnstufe: 2,50 €")).toBeInTheDocument();
  });

  test("DUN-008 saving sends only the overridden fee and the adjusted interest with its reason", async () => {
    const user = userEvent.setup();
    backend.data["dunning:reminder"] = draftData();
    backend.mutations["dunning:updateReminder"] = vi.fn().mockResolvedValue({ version: 4 });
    renderWithIntl(<ReminderDetail id="rem1" />);
    const save = screen.getByRole("button", { name: "Entwurf speichern" });
    expect(save).toBeDisabled();
    const fee = screen.getByLabelText("Mahngebühr (€)");
    await user.clear(fee);
    await user.type(fee, "5,00");
    await user.click(screen.getByRole("checkbox", { name: "Zinsen anpassen" }));
    await user.clear(screen.getByLabelText("Zinsen (€)"));
    await user.type(screen.getByLabelText("Zinsen (€)"), "10,00");
    // EC-DUN-08: the adjusted interest needs a reason.
    await user.click(save);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(backend.mutations["dunning:updateReminder"]).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Grund der Anpassung"), "Kulanz");
    await user.click(save);
    await waitFor(() =>
      expect(backend.mutations["dunning:updateReminder"]).toHaveBeenCalledWith({
        id: "rem1",
        version: 3,
        values: {
          headText: "Sehr geehrte Damen und Herren,",
          footText: "Mit freundlichen Grüßen",
          feeCents: 500,
          interestCents: 1_000,
          interestReason: "Kulanz",
        },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Entwurf gespeichert.");
  });

  test("DUN-024 the 40-€ flat fee already claimed is not selectable and explains why", () => {
    backend.data["dunning:reminder"] = draftData({
      computed: { ...draftData().computed, flatFeeAlreadyClaimed: true, flatFee40Cents: 0 },
      reminder: view({ flatFee40Cents: 0 }),
      case: { ...draftData().case, flatFeeCharged: true },
    });
    renderWithIntl(<ReminderDetail id="rem1" />);
    const box = screen.getByRole("checkbox", { name: "40-€-Pauschale (§ 288 Abs. 5 BGB) geltend machen" });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Warum ist die Pauschale nicht wählbar?" })).toBeInTheDocument();
    expect(within(screen.getByTestId("claim-summary")).getByText("bereits geltend gemacht")).toBeInTheDocument();
  });

  test("DUN-024 consumers never see the 40-€ flat fee", () => {
    backend.data["dunning:reminder"] = draftData({ isConsumer: true });
    renderWithIntl(<ReminderDetail id="rem1" />);
    expect(screen.queryByRole("checkbox", { name: /40-€-Pauschale/ })).toBeNull();
    expect(within(screen.getByTestId("claim-summary")).queryByText("Pauschale § 288 Abs. 5 BGB")).toBeNull();
  });

  test("DUN-004 an error finding blocks „Fertigstellen“", () => {
    backend.data["dunning:reminder"] = draftData({
      findings: [{ code: "claim_error", severity: "E", message: "Rechnung ist bezahlt." }],
    });
    renderWithIntl(<ReminderDetail id="rem1" />);
    expect(screen.getByRole("button", { name: "Fertigstellen" })).toBeDisabled();
    expect(within(screen.getByTestId("reminder-compliance")).getByRole("status")).toHaveTextContent(
      "1 Fehler verhindert das Fertigstellen",
    );
  });

  test("DUN-043 finalising confirms a ⚑ warning and retries with the acknowledged codes", async () => {
    const user = userEvent.setup();
    backend.data["dunning:reminder"] = draftData();
    const warn = new ConvexError({
      code: "invalid_input",
      message: "Die Forderung ist als bestritten markiert.",
      reason: "WARNINGS_UNACKNOWLEDGED",
      warnings: "disputed",
    });
    backend.mutations["dunning:finalize"] = vi
      .fn()
      .mockRejectedValueOnce(warn)
      .mockResolvedValue({ number: "MA-2026-0008" });
    renderWithIntl(<ReminderDetail id="rem1" />);
    await user.click(screen.getByRole("button", { name: "Fertigstellen" }));
    const dialog = await screen.findByRole("dialog", { name: "Mahnung fertigstellen?" });
    await user.click(within(dialog).getByRole("button", { name: "Jetzt fertigstellen" }));
    expect(await screen.findByTestId("dunning-warning")).toHaveTextContent("bestritten");
    await user.click(screen.getByRole("button", { name: "Trotzdem fertigstellen" }));
    await waitFor(() =>
      expect(backend.mutations["dunning:finalize"]).toHaveBeenLastCalledWith({
        id: "rem1",
        version: 3,
        acknowledgeWarnings: ["disputed"],
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Mahnung MA-2026-0008 fertiggestellt.");
  });

  test("DUN-008 deleting the draft returns to the invoice", async () => {
    const user = userEvent.setup();
    backend.data["dunning:reminder"] = draftData();
    renderWithIntl(<ReminderDetail id="rem1" />);
    await user.click(screen.getByRole("button", { name: "Entwurf löschen" }));
    const dialog = await screen.findByRole("dialog", { name: "Mahnentwurf löschen?" });
    await user.click(within(dialog).getByRole("button", { name: "Entwurf löschen" }));
    await waitFor(() => expect(backend.mutations["dunning:deleteReminder"]).toHaveBeenCalledWith({ id: "rem1" }));
    expect(backend.push).toHaveBeenCalledWith("/rechnungen/inv1");
  });

  test("DUN-004 a viewer sees the draft read-only without the editor", () => {
    backend.data["members:me"] = { role: "viewer" };
    backend.data["dunning:reminder"] = draftData();
    renderWithIntl(<ReminderDetail id="rem1" />);
    expect(screen.getByText("Sie können diesen Entwurf ansehen, aber nicht bearbeiten.")).toBeInTheDocument();
    expect(screen.queryByTestId("reminder-editor")).toBeNull();
    expect(screen.getByTestId("claim-total")).toHaveTextContent("1.254,84 €");
  });
});

describe("finalised reminder (DUN-009, DUN-010, PAY-052)", () => {
  test("DUN-010 the sent reminder is locked and shows dispatch, Zugang, send log, texts and archived files", () => {
    backend.data["dunning:reminder"] = finalData();
    renderWithIntl(<ReminderDetail id="rem1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Mahnung MA-2026-0007" })).toBeInTheDocument();
    expect(screen.getByText("Unveränderbar")).toBeInTheDocument();
    const dispatch = screen.getByTestId("reminder-dispatch");
    expect(dispatch).toHaveTextContent("10.10.2026");
    expect(dispatch).toHaveTextContent("14.10.2026 (Post)");
    expect(within(dispatch).getByTestId("reminder-send-log")).toHaveTextContent(
      "Als versendet markiert am 11.10.2026 (Post) – Einschreiben (maßgeblich)",
    );
    expect(screen.getByText("Kopftext der Mahnung")).toBeInTheDocument();
    expect(screen.getByTestId("reminder-artifacts")).toHaveTextContent(`SHA-256 ${"ab".repeat(32)}`);
    expect(screen.getByTestId("interest-segments")).toHaveTextContent("01.09.2026 – 15.10.2026");
    expect(screen.getByTestId("mark-sent")).toHaveTextContent("Erneut als versendet markieren");
    expect(screen.queryByTestId("reminder-editor")).toBeNull();
  });

  test("DUN-009 „Gegenstandslos setzen“ needs a reason of at least 5 characters", async () => {
    const user = userEvent.setup();
    backend.data["dunning:reminder"] = finalData();
    renderWithIntl(<ReminderDetail id="rem1" />);
    await user.click(screen.getByRole("button", { name: "Gegenstandslos setzen" }));
    const dialog = await screen.findByRole("dialog", { name: "Mahnung MA-2026-0007 gegenstandslos setzen" });
    expect(dialog).toHaveTextContent("sollten Sie den Kunden informieren");
    const confirm = within(dialog).getByRole("button", { name: "Gegenstandslos setzen" });
    await user.type(within(dialog).getByLabelText("Grund (mindestens 5 Zeichen)"), "Za");
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Grund (mindestens 5 Zeichen)"), "hlung erhalten");
    await user.click(confirm);
    await waitFor(() =>
      expect(backend.mutations["dunning:withdraw"]).toHaveBeenCalledWith({
        id: "rem1",
        values: { reason: "Zahlung erhalten" },
      }),
    );
  });

  test("PAY-052 the Zugang is corrected with a date and a reason", async () => {
    const user = userEvent.setup();
    backend.data["dunning:reminder"] = finalData();
    renderWithIntl(<ReminderDetail id="rem1" />);
    await user.click(screen.getByRole("button", { name: "Zugang korrigieren" }));
    const dialog = await screen.findByRole("dialog", { name: "Zugang korrigieren" });
    expect(within(dialog).getByLabelText("Zugangsdatum")).toHaveValue("2026-10-14");
    await user.type(within(dialog).getByLabelText("Begründung (mindestens 5 Zeichen)"), "Rückschein");
    await user.click(within(dialog).getByRole("button", { name: "Zugang speichern" }));
    await waitFor(() =>
      expect(backend.mutations["dunning:overrideZugang"]).toHaveBeenCalledWith({
        id: "rem1",
        values: { date: "2026-10-14", reason: "Rückschein" },
      }),
    );
  });

  test("DUN-009 a withdrawn reminder shows the reason and no further actions; a viewer has no actions", () => {
    backend.data["members:me"] = { role: "viewer" };
    backend.data["dunning:reminder"] = finalData({
      reminder: view({
        number: "MA-2026-0007",
        status: "cancelled",
        documentDate: "2026-10-10",
        artifactStatus: "pending",
        cancellation: { at: Date.UTC(2026, 9, 12, 8), reason: "Zahlung erhalten" },
      }),
      sendLog: [],
    });
    renderWithIntl(<ReminderDetail id="rem1" />);
    expect(screen.getByText(/Gegenstandslos seit 12\.10\.2026.*Zahlung erhalten/)).toBeInTheDocument();
    expect(screen.getByText("Das PDF wird erstellt. Export und Versandmarkierung sind gleich möglich.")).toBeVisible();
    expect(screen.queryByTestId("mark-sent")).toBeNull();
    expect(screen.queryByRole("button", { name: "Gegenstandslos setzen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zugang korrigieren" })).toBeNull();
  });
});
