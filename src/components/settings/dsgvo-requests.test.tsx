import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { DsgvoRequests } from "./dsgvo-requests";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  downloads: [] as unknown[][],
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? backend.data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: unknown) => {
    backend.calls.push({ name: getFunctionName(ref as never), args });
    return null;
  },
}));
vi.mock("@/components/exports/export-menu", () => ({
  downloadText: (...args: unknown[]) => backend.downloads.push(args),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const row = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  kind: "access",
  kindLabel: "Auskunft (Art. 15)",
  subject: "Erika Muster",
  contactId: "c1",
  channel: "email",
  receivedAt: "2026-10-01",
  dueAt: "2026-11-02",
  status: "open",
  identityVerified: null,
  extension: null,
  erasure: null,
  hasResult: false,
  overdue: false,
  stage: "due7",
  ...over,
});

const erasureRow = row({
  id: "r2",
  kind: "erasure",
  kindLabel: "Löschung (Art. 17)",
  subject: "Max Kunde",
  contactId: "c2",
  identityVerified: { method: "Rückruf", at: 1 },
  extension: { months: 2 },
  stage: "overdue",
  overdue: true,
});

beforeEach(() => {
  backend.calls = [];
  backend.downloads = [];
  backend.data = {
    "members:me": { role: "owner" },
    "dsgvo:list": [
      row(),
      erasureRow,
      row({
        id: "r3",
        subject: "Alt",
        status: "done",
        hasResult: true,
        erasure: { contactDeleted: false, deleted: 4, scheduledPurgeAt: "2036-12-31" },
      }),
    ],
    "dsgvo:resultUrl": "https://files/auskunft.zip",
    "dsgvo:letter": "Sehr geehrte Frau Muster, …",
    "dsgvo:preview": {
      deleteContact: false,
      receivablesNotice: "Es gibt noch offene Forderungen.",
      deleteNow: [{ id: "n1", label: "Notiz vom 01.09.2026" }],
      clearFields: ["Telefon", "Geburtstag"],
      restrict: [{ id: "i1", label: "Rechnung RE-2024-0001", retentionUntil: "2034-12-31" }],
      scheduledPurgeAt: "2035-01-01",
    },
  };
});

describe("DSGVO-Anfragen (F12 §6)", () => {
  test("PRV-010 the register lists requests with deadline, channel, identity and overdue badges", () => {
    renderWithIntl(<DsgvoRequests />);
    const list = screen.getByRole("list", { name: "Datenschutzanfragen" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0] as HTMLElement).getByText("Auskunft (Art. 15)")).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText("Frist läuft bald ab")).toBeInTheDocument();
    expect(items[0]).toHaveTextContent("Eingang 01.10.2026 · Frist 02.11.2026 · E-Mail · Identität nicht bestätigt");
    expect(within(items[1] as HTMLElement).getByText("Überfällig")).toBeInTheDocument();
    expect(items[1]).toHaveTextContent("Identität bestätigt (Rückruf)");
    expect(within(items[1] as HTMLElement).queryByRole("button", { name: "Frist verlängern" })).toBeNull();
    expect(items[2]).toHaveTextContent("4 Datensätze gelöscht, Kontakt gesperrt bis zur Löschung am 31.12.2036.");
    expect(within(items[2] as HTMLElement).getByRole("link", { name: "Auskunft herunterladen" })).toHaveAttribute(
      "href",
      "https://files/auskunft.zip",
    );
    expect(within(items[2] as HTMLElement).queryByRole("button", { name: "Erledigt" })).toBeNull();
  });

  test("PRV-010 a new request without a contact needs the person's name", async () => {
    renderWithIntl(<DsgvoRequests />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Anfrage erfassen" }));
    const dialog = screen.getByRole("dialog", { name: "Anfrage erfassen" });
    const save = within(dialog).getByRole("button", { name: "Speichern" });
    expect(save).toBeDisabled();
    await user.selectOptions(within(dialog).getByLabelText("Art der Anfrage"), "erasure");
    await user.selectOptions(within(dialog).getByLabelText("Eingangsweg"), "post");
    await user.type(within(dialog).getByLabelText("Name der Person"), "Ina Interessent");
    await user.type(within(dialog).getByLabelText("E-Mail der Person (optional)"), "ina@example.org");
    await user.type(within(dialog).getByLabelText("Notiz (optional)"), "Brief vom 01.10.");
    await user.click(save);
    const call = backend.calls.find((c) => c.name === "dsgvo:create");
    expect(call?.args).toMatchObject({
      subject: { name: "Ina Interessent", email: "ina@example.org" },
      kind: "erasure",
      channel: "post",
      notes: "Brief vom 01.10.",
    });
    expect((call?.args as { receivedAt: string } | undefined)?.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("PRV-010 opened from a contact the create dialog is bound to that contact", async () => {
    renderWithIntl(<DsgvoRequests contactId="c9" />);
    const dialog = screen.getByRole("dialog", { name: "Anfrage erfassen" });
    expect(within(dialog).getByText("Anfrage zu diesem Kontakt erfassen.")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Name der Person")).toBeNull();
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(backend.calls.find((c) => c.name === "dsgvo:create")?.args).toMatchObject({
      contactId: "c9",
      kind: "access",
    });
  });

  test("TST-PRV-11 identity check, deadline extension, export, letter, done and rejection", async () => {
    renderWithIntl(<DsgvoRequests />);
    const user = userEvent.setup();
    const first = within(screen.getAllByRole("listitem")[0] as HTMLElement);
    await user.click(first.getByRole("button", { name: "Identität bestätigen" }));
    let dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Prüfweg"), "Ausweiskopie");
    await user.click(within(dialog).getByRole("button", { name: "Identität bestätigen" }));
    expect(backend.calls.find((c) => c.name === "dsgvo:verify")?.args).toEqual({ id: "r1", method: "Ausweiskopie" });

    await user.click(first.getByRole("button", { name: "Frist verlängern" }));
    dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Verlängerung (Monate)"), "1");
    await user.type(within(dialog).getByLabelText("Begründung"), "Komplexe Anfrage");
    await user.click(within(dialog).getByRole("button", { name: "Frist verlängern" }));
    expect(backend.calls.find((c) => c.name === "dsgvo:extend")?.args).toMatchObject({
      id: "r1",
      months: 1,
      reason: "Komplexe Anfrage",
    });

    await user.click(first.getByRole("button", { name: "Auskunft erstellen" }));
    expect(backend.calls.find((c) => c.name === "dsgvo:startExport")?.args).toEqual({ id: "r1" });

    await user.click(first.getByRole("button", { name: "Antwortschreiben" }));
    await waitFor(() =>
      expect(backend.downloads).toContainEqual([
        "dsgvo-antwort.txt",
        "Sehr geehrte Frau Muster, …",
        "text/plain;charset=utf-8",
      ]),
    );

    await user.click(first.getByRole("button", { name: "Erledigt" }));
    expect(backend.calls.find((c) => c.name === "dsgvo:setRequestStatus")?.args).toEqual({ id: "r1", to: "done" });

    await user.click(first.getByRole("button", { name: "Ablehnen" }));
    dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Begründung der Ablehnung"), "offensichtlich unbegründet");
    await user.click(within(dialog).getByRole("button", { name: "Ablehnen" }));
    expect(backend.calls.filter((c) => c.name === "dsgvo:setRequestStatus").at(-1)?.args).toEqual({
      id: "r1",
      to: "rejected",
      rejectionReason: "offensichtlich unbegründet",
    });
  });

  test("PRV-011 the erasure preview shows the delete and retain buckets before executing", async () => {
    renderWithIntl(<DsgvoRequests />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Löschung prüfen" }));
    const dialog = screen.getByRole("dialog", { name: "Löschung bzw. Sperrung nach Art. 17/18 DSGVO" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Es gibt noch offene Forderungen.");
    const del = within(dialog).getByRole("region", { name: "Wird sofort gelöscht" });
    expect(del).toHaveTextContent("Notiz vom 01.09.2026");
    expect(del).toHaveTextContent("Felder: Telefon, Geburtstag");
    expect(within(dialog).getByRole("region", { name: "Bleibt aufbewahrt (gesperrt)" })).toHaveTextContent(
      "Rechnung RE-2024-0001 – aufzubewahren bis 31.12.2034",
    );
    expect(dialog).toHaveTextContent("ab 01.01.2035 im Löschlauf anonymisiert");
    await user.click(within(dialog).getByRole("button", { name: "Löschen und sperren" }));
    expect(backend.calls.find((c) => c.name === "dsgvo:execute")?.args).toEqual({ id: "r2" });
  });

  test("PRV-010 only the owner sees the register; empty register shows the empty text", () => {
    backend.data["members:me"] = { role: "bookkeeper" };
    const { unmount } = renderWithIntl(<DsgvoRequests />);
    expect(screen.getByText("Datenschutzanfragen bearbeitet nur der Inhaber.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anfrage erfassen" })).toBeNull();
    unmount();
    backend.data["members:me"] = { role: "owner" };
    backend.data["dsgvo:list"] = [];
    renderWithIntl(<DsgvoRequests />);
    expect(screen.getByText("Noch keine Datenschutzanfragen.")).toBeInTheDocument();
  });
});
