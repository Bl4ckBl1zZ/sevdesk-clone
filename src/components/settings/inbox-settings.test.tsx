import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { InboxMailForm, type InboxSettingsView, OcrForm } from "./inbox-settings";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const inbox = (over: Partial<InboxSettingsView["inbox"]> = {}): InboxSettingsView["inbox"] => ({
  enabled: false,
  dpaConfirmedAt: null,
  receivingAddress: "belege@in.example.de",
  allowlist: ["@lieferant.de"],
  credentials: "missing",
  bucket: null,
  endpoint: null,
  pollIntervalMinutes: 5,
  limits: { mailMb: 25, attachmentMb: 20 },
  health: { consecutiveFailures: 0 },
  lastTestAt: null,
  lastTestOk: null,
  lastTestDetail: null,
  ...over,
});

const ocr = (over: Partial<InboxSettingsView["ocr"]> = {}): InboxSettingsView["ocr"] => ({
  enabled: false,
  active: false,
  dpaConfirmedAt: null,
  apiKeyStored: false,
  endpoint: null,
  model: "claude-sonnet-5-5",
  region: "global",
  pageLimit: 5,
  monthlyBudget: null,
  usage: null,
  lastTestAt: null,
  lastTestOk: null,
  lastTestDetail: null,
  ...over,
});

describe("Einstellungen › Posteingang (SET-110, INB-011/051/052)", () => {
  test("SET-110 INB-011 INB-052 address with copy button, credentials „fehlt“, limits, pause alert, AVV + allowlist saved", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithIntl(
      <InboxMailForm
        view={inbox({ health: { consecutiveFailures: 3, pausedAt: Date.UTC(2026, 9, 19, 7), lastError: "403" } })}
        canManage
        onSave={onSave}
        onTest={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Empfangsadresse kopieren" })).toBeInTheDocument();
    expect(screen.getByText("fehlt")).toBeInTheDocument();
    expect(screen.getByText("25 MB pro E-Mail, 20 MB pro Anhang")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/Abruf pausiert seit/);
    await user.click(screen.getByRole("checkbox", { name: /Auftragsverarbeitungsvertrag \(AVV\) mit Cloudflare/ }));
    await user.click(screen.getByRole("checkbox", { name: "E-Mail-Empfang aktiv" }));
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(onSave).toHaveBeenCalledWith({
      enabled: true,
      receivingAddress: "belege@in.example.de",
      allowlist: "@lieferant.de",
      dpaConfirmed: true,
    });
  });
});

describe("Einstellungen › Belegerkennung (SET-111…113)", () => {
  test("SET-111 EC-INB-17 a non-EU region shows the warning live; the key field is write-only", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue({ warnings: [], released: 0 });
    renderWithIntl(<OcrForm view={ocr({ apiKeyStored: true })} canManage onSave={onSave} onTest={vi.fn()} />);
    expect(screen.getByRole("note")).toHaveTextContent(/außerhalb der EU/);
    const key = screen.getByLabelText("API-Schlüssel");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveValue("");
    await user.selectOptions(screen.getByLabelText("Region (Verarbeitungsort)"), "eu");
    expect(screen.queryByRole("note")).toBeNull();
    await user.type(key, "sk-ant-test");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ region: "eu", apiKey: "sk-ant-test", model: "claude-sonnet-5-5", pageLimit: 5 }),
    );
    expect(key).toHaveValue("");
  });

  test("SET-112 „Verbindung testen“ shows model and latency; SET-113 released items are announced", async () => {
    const user = userEvent.setup();
    const onTest = vi.fn().mockResolvedValue({ ok: true, detail: "claude-sonnet-5-5 · 412 ms" });
    const onSave = vi.fn().mockResolvedValue({ warnings: [], released: 2 });
    renderWithIntl(
      <OcrForm
        view={ocr({ apiKeyStored: true, enabled: true, active: true, region: "eu", dpaConfirmedAt: 1 })}
        canManage
        onSave={onSave}
        onTest={onTest}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Verbindung testen" }));
    expect(toast.success).toHaveBeenCalledWith("claude-sonnet-5-5 · 412 ms");
    await user.click(screen.getByRole("checkbox", { name: "Belegerkennung aktiv" }));
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(toast.info).toHaveBeenCalledWith("2 wartende Belege gehen in die manuelle Prüfung");
  });
});
