import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { TextTemplatesAdmin } from "./text-templates-admin";

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
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  backend.mutations = {};
  toast.success.mockReset();
  backend.data = {
    "lookups:listTextTemplates": [
      {
        templateId: "t1",
        kind: "document_head",
        docTypes: ["invoice"],
        language: "de",
        name: "Standard Kopftext Rechnung (DE)",
        subject: "",
        body: "<p>{{contact.letterSalutation}}</p><p>vielen Dank für Ihren Auftrag.</p>",
        isDefault: true,
      },
    ],
  };
});

async function openEditor() {
  renderWithIntl(<TextTemplatesAdmin />);
  await userEvent.click(screen.getByRole("button", { name: /Bearbeiten/ }));
  return screen.findByRole("dialog", { name: "Textvorlage bearbeiten" });
}

describe("Textvorlagen (F01 SET-080…087)", () => {
  test("SET-080 the list shows kind, document types, language and the default badge", () => {
    renderWithIntl(<TextTemplatesAdmin />);
    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Standard Kopftext Rechnung (DE)")).toBeInTheDocument();
    expect(within(row).getByText("Standard")).toBeInTheDocument();
    expect(within(row).getByText("DE")).toBeInTheDocument();
    expect(within(row).getByText("Kopftext · Rechnung")).toBeInTheDocument();
  });

  test("SET-087 the picker groups placeholders, searches and inserts the snippet; the preview shows sample values", async () => {
    const dialog = await openEditor();
    expect(within(dialog).getByTestId("template-preview")).toHaveTextContent("Sehr geehrte Frau Dr. Müller,");
    await userEvent.click(within(dialog).getByRole("button", { name: "Platzhalter einfügen" }));
    const picker = await screen.findByRole("dialog", { name: "Platzhalter einfügen" });
    expect(within(picker).getByRole("heading", { name: "Kontakt" })).toBeInTheDocument();
    expect(within(picker).queryByRole("heading", { name: "Mahnung" })).toBeNull();
    await userEvent.type(within(picker).getByLabelText("Suche"), "Zahlungsbedingungen");
    const option = within(picker).getByRole("button", { name: /Zahlungsbedingungen/ });
    expect(option).toHaveTextContent("Beispiel: Zahlbar bis 26.10.2026 ohne Abzug.");
    await userEvent.click(option);
    const body = within(dialog).getByLabelText("Text (Quelltext)") as HTMLTextAreaElement;
    expect(body.value).toContain("{{document.paymentTermsText}}");
    expect(within(dialog).getByTestId("template-preview")).toHaveTextContent("Zahlbar bis 26.10.2026 ohne Abzug.");
  });

  test("SET-081 the preview never renders scripts; SET-082 an unknown placeholder blocks saving with the German message", async () => {
    const dialog = await openEditor();
    const body = within(dialog).getByLabelText("Text (Quelltext)");
    await userEvent.clear(body);
    await userEvent.type(body, "<p>Hallo<script>alert(1)</script> {{{{contact.foo}}");
    expect(within(dialog).getByTestId("template-preview").innerHTML).not.toContain("script");
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect((await within(dialog).findAllByText(/Unbekannter Platzhalter/)).length).toBeGreaterThan(0);
    expect(backend.mutations["lookups:saveTextTemplate"]).not.toHaveBeenCalled();
  });

  test("SET-080 a refused save shows the server message in the dialog", async () => {
    backend.mutations["lookups:saveTextTemplate"] = vi.fn().mockRejectedValue(
      new ConvexError({ code: "invalid_input", message: "Höchstens 20.000 Zeichen." }),
    );
    const dialog = await openEditor();
    await userEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Höchstens 20.000 Zeichen.");
  });
});
