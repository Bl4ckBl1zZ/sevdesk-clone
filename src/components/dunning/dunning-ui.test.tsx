import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { DunningCockpit } from "./dunning-cockpit";
import { parseBucketEdges, policyValuesOf } from "./dunning-settings";
import { DispatchStatus, isLateMark, ReminderMarkSentDialog, warningsOf } from "./dunning-shared";
import { interestInput } from "./interest-calculator";
import { draftValues } from "./reminder-detail";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  search: "",
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, args: unknown, enabled = true) => {
    if (!enabled) return undefined;
    const v = backend.data[getFunctionName(ref as never)];
    return typeof v === "function" ? v(args) : v;
  },
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
  useSearchParams: () => new URLSearchParams(backend.search),
  usePathname: () => "/mahnungen",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  backend.data = { "members:me": { role: "owner" } };
  backend.mutations = {};
  backend.search = "";
});

const claim = {
  title: "1. Mahnung",
  openAmountCents: 11_900,
  feeCents: 0,
  interestCents: 120,
  flatFee40Cents: 4_000,
  flatFeeAlreadyClaimed: false,
  totalCents: 16_020,
  newDueDate: "2026-10-23",
  inDefault: true,
  defaultStartDate: "2026-09-01",
};

const action = (over: Record<string, unknown>) => ({
  invoiceId: "inv1",
  number: "RE-2026-0001",
  kind: "create_draft",
  level: 2,
  reason: null,
  reasonLabel: "1. Mahnung",
  detail: null,
  claim,
  notes: [],
  contactName: "Muster GmbH",
  ...over,
});

const emptyCockpit = {
  today: "2026-10-16",
  dueSoon: [],
  drafts: [],
  toSend: [],
  sent: [],
  withdrawn: [],
  unmarked: [],
  paused: [],
  limitation: [],
  runs: [],
  counts: { drafts: 0, toSend: 0 },
};

describe("F05 §6.4 Mahnungen cockpit", () => {
  test("DUN-031 Vorschau: only planned actions are selectable; the run uses the selection's own digest", async () => {
    const user = userEvent.setup();
    backend.data["dunning:cockpit"] = emptyCockpit;
    backend.data["dunning:preview"] = (args: { invoiceIds?: string[] }) => ({
      date: "2026-10-16",
      digest: args.invoiceIds ? `sub:${args.invoiceIds.join(",")}` : "all",
      bankDataCurrent: true,
      bankDataNote: null,
      actions: args.invoiceIds
        ? [action({ invoiceId: "inv1" })]
        : [
            action({ invoiceId: "inv1" }),
            action({ invoiceId: "inv2", number: "RE-2026-0002" }),
            action({
              invoiceId: "inv3",
              number: "RE-2026-0003",
              kind: "skip",
              level: null,
              reason: "not_marked_sent",
              reasonLabel: "Rechnung nicht als versendet markiert – ohne Zugang wird nicht gemahnt",
              claim: null,
            }),
          ],
    });
    backend.mutations["dunning:run"] = vi
      .fn()
      .mockResolvedValue({ runId: "r1", evaluated: 1, drafts: 1, finalized: [], todos: 0, skipped: 0, errors: 0 });
    renderWithIntl(<DunningCockpit />);
    const preview = screen.getByTestId("dunning-preview");
    // Table and phone cards both render in jsdom: one checkbox per layout for each actionable row, none for skips.
    expect(within(preview).getAllByRole("checkbox", { name: "RE-2026-0001 auswählen" })).toHaveLength(2);
    expect(within(preview).queryByRole("checkbox", { name: "RE-2026-0003 auswählen" })).toBeNull();
    expect(within(preview).getAllByText("Übersprungen").length).toBeGreaterThan(0);

    const [box2] = within(preview).getAllByRole("checkbox", { name: "RE-2026-0002 auswählen" });
    await user.click(box2 as HTMLElement);
    expect(within(preview).getByText("1 Rechnung ausgewählt")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ausgewählte jetzt ausführen" }));
    const dialog = await screen.findByRole("dialog", { name: "Ausgewählte jetzt ausführen?" });
    expect(within(dialog).getByText("1 Mahnentwurf wird erstellt")).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/\bsenden\b/i);
    await user.click(within(dialog).getByRole("button", { name: "Jetzt ausführen" }));
    await waitFor(() =>
      expect(backend.mutations["dunning:run"]).toHaveBeenCalledWith({
        mode: "drafts",
        invoiceIds: ["inv1"],
        expectedDigest: "sub:inv1",
      }),
    );
  });

  test("DUN-055 the „Entwürfe“ tab opens from ?tab=entwuerfe and links each draft to its editor", () => {
    backend.search = "tab=entwuerfe";
    backend.data["dunning:cockpit"] = {
      ...emptyCockpit,
      drafts: [
        {
          id: "rem1",
          number: null,
          status: "draft",
          level: 1,
          title: "Zahlungserinnerung",
          invoiceId: "inv1",
          invoiceNumber: "RE-2026-0001",
          contactId: null,
          contactName: "Muster GmbH",
          documentDate: null,
          openAmountCents: 11_900,
          feeCents: 0,
          interestCents: 0,
          flatFee40Cents: 0,
          totalCents: 11_900,
          newDueDate: "2026-10-23",
          defaultStartDate: null,
          createdByRun: true,
          finalizedAt: null,
          sentOn: null,
          zugang: null,
          artifactStatus: null,
          cancellation: null,
          version: 1,
        },
      ],
      counts: { drafts: 1, toSend: 0 },
    };
    renderWithIntl(<DunningCockpit />);
    const list = screen.getByTestId("reminders-drafts");
    const links = within(list).getAllByRole("link", { name: "Entwurf Stufe 1" });
    expect(links[0]).toHaveAttribute("href", "/mahnungen/rem1");
    expect(within(list).getAllByText("Mahnlauf").length).toBeGreaterThan(0);
  });
});

const reminderDetail = (documentDate: string) => ({
  reminder: {
    id: "rem1",
    number: "MA-2026-0001",
    status: "finalized",
    level: 1,
    title: "Zahlungserinnerung",
    invoiceId: "inv1",
    invoiceNumber: "RE-2026-0001",
    documentDate,
    sentOn: null,
    zugang: null,
    artifactStatus: "ready",
  },
  artifacts: [{ _id: "a1", kind: "pdf", variant: "original", name: "MA-2026-0001.pdf", sha256: "x", bytes: 1 }],
  defaultMarkSelection: ["a1"],
  today: "2026-10-16",
});

describe("DUN-058 / DUN-056 „Als versendet markieren“ for reminders", () => {
  test("DUN-056 a sent date more than 3 days after the document date warns before anything is recorded", async () => {
    const user = userEvent.setup();
    backend.data["dunning:reminder"] = reminderDetail("2026-10-10");
    backend.mutations["invoices:markSent"] = vi.fn().mockResolvedValue({ warnings: [] });
    renderWithIntl(<ReminderMarkSentDialog id="rem1" onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Die im Schreiben genannte Frist ist ggf. zu kurz – Mahnung neu erstellen?",
    );
    expect(within(dialog).getByRole("button", { name: "Gegenstandslos setzen und neu erstellen" })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Trotzdem als versendet markieren" }));
    await waitFor(() =>
      expect(backend.mutations["invoices:markSent"]).toHaveBeenCalledWith({
        id: "rem1",
        values: { sentOn: "2026-10-16", channel: "email_manual", artifactIds: ["a1"] },
      }),
    );
  });

  test("DUN-058 a timely mark shows no warning", async () => {
    backend.data["dunning:reminder"] = reminderDetail("2026-10-15");
    renderWithIntl(<ReminderMarkSentDialog id="rem1" onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Als versendet markieren" })).toBeEnabled();
  });

  test("DUN-056 isLateMark counts calendar days after the document date", () => {
    expect(isLateMark("2026-10-10", "2026-10-13")).toBe(false);
    expect(isLateMark("2026-10-10", "2026-10-14")).toBe(true);
    expect(isLateMark(null, "2026-10-14")).toBe(false);
  });
});

describe("shared helpers", () => {
  test("DUN-043 warningsOf reads the codes of WARNINGS_UNACKNOWLEDGED (⚑ confirm-and-retry)", () => {
    const e = new ConvexError({
      code: "invalid_input",
      message: "Die Forderung ist als bestritten markiert.",
      reason: "WARNINGS_UNACKNOWLEDGED",
      warnings: "disputed_hand_over,limitation_passed",
    });
    expect(warningsOf(e)).toEqual({
      codes: ["disputed_hand_over", "limitation_passed"],
      message: "Die Forderung ist als bestritten markiert.",
    });
    expect(warningsOf(new ConvexError({ code: "invalid_input", message: "x", reason: "fee" }))).toBeNull();
  });

  test("DUN-010 dispatch line: sent date, Zugang and channel", () => {
    renderWithIntl(
      <DispatchStatus
        reminder={{ status: "sent", sentOn: "2026-10-12", zugang: { date: "2026-10-15", basis: "post" } }}
      />,
    );
    expect(screen.getByText("versendet am 12.10.2026 · Zugang 15.10.2026 (Post)")).toBeInTheDocument();
  });

  test("DUN-008 the editor sends only overridden amounts so the rest is recomputed at finalisation", () => {
    const computed = { feeCents: 0, flatFee40Cents: 4_000, newDueDate: "2026-10-23" };
    const base = {
      fee: "0,00",
      adjustInterest: false,
      interest: "1,20",
      interestReason: "",
      includeFlatFee: true,
      newDueDate: "2026-10-23",
      headText: "Kopf",
      footText: "Fuß",
    };
    expect(draftValues(base, computed, true)).toEqual({ ok: true, values: { headText: "Kopf", footText: "Fuß" } });
    expect(draftValues({ ...base, fee: "2,50", includeFlatFee: false }, computed, true)).toEqual({
      ok: true,
      values: { headText: "Kopf", footText: "Fuß", feeCents: 250, includeFlatFee: false },
    });
    // EC-DUN-08: adjusted interest needs a reason.
    expect(draftValues({ ...base, adjustInterest: true, interest: "5,00" }, computed, true)).toEqual({
      ok: false,
      field: "interestReason",
    });
    // EC-DUN-01: the flat fee is never sent for consumers.
    expect(draftValues({ ...base, includeFlatFee: false }, computed, false)).toEqual({
      ok: true,
      values: { headText: "Kopf", footText: "Fuß" },
    });
  });

  test("DUN-022 the calculator input: amount, period, margin and partial payments", () => {
    const form = {
      amount: "1.000,00",
      from: "2026-01-01",
      to: "2026-03-31",
      margin: "b2b" as const,
      customPoints: "",
      payments: [{ date: "2026-02-01", amount: "500" }],
    };
    expect(interestInput(form)).toEqual({
      amountCents: 100_000,
      from: "2026-01-01",
      to: "2026-03-31",
      margin: "b2b",
      payments: [{ date: "2026-02-01", amountCents: 50_000 }],
    });
    expect(interestInput({ ...form, margin: "custom", customPoints: "8" })?.margin).toBe(800);
    expect(interestInput({ ...form, to: "2025-12-31" })).toBeNull();
    expect(interestInput({ ...form, amount: "" })).toBeNull();
  });

  test("DUN-001 the policy form numbers the steps by order; aging edges parse ascending", () => {
    const step = {
      key: 0,
      daysAfter: "7",
      title: "Zahlungserinnerung",
      fee: "0",
      addInterest: false,
      addFlatFee40: true,
      newDueDays: "7",
      textTemplateId: "",
      autoFinalize: false,
    };
    const r = policyValuesOf({
      name: "B2C",
      isDefault: false,
      consumer: true,
      business: false,
      dueSoonDays: "3",
      dueSoonTodo: false,
      minOpen: "5,00",
      pauseDays: "14",
      stopAfterLastLevel: true,
      steps: [step, { ...step, key: 1, title: "1. Mahnung", fee: "2,50" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.values.steps.map((s) => [s.level, s.feeCents, s.addFlatFee40])).toEqual([
        [1, 0, false],
        [2, 250, false],
      ]);
      expect(r.values.minOpenAmountCents).toBe(500);
    }
    expect(parseBucketEdges("90, 30;60")).toEqual([30, 60, 90]);
    expect(parseBucketEdges("30, x")).toBeNull();
  });
});
