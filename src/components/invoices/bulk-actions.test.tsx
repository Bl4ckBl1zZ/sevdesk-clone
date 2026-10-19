import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { BulkActions } from "./bulk-actions";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue({ jobId: "j1" });
    return backend.mutations[name];
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  backend.mutations = {};
  backend.data = { "members:me": { role: "owner" } };
});

describe("bulk bar (SND-20)", () => {
  test("SND-20 „Sammel-Export“ and „Sammel-Markierung“ start jobs for the selection", async () => {
    const onDone = vi.fn();
    renderWithIntl(<BulkActions selected={["a", "b"]} onDone={onDone} />);
    expect(screen.getByText("2 ausgewählt")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sammel-Export" }));
    expect(backend.mutations["bulk:startExport"]).toHaveBeenCalledWith({ ids: ["a", "b"] });
    expect(onDone).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Sammel-Markierung" }));
    const dialog = await screen.findByRole("dialog", { name: "2 Dokumente als versendet markieren" });
    await userEvent.selectOptions(screen.getByLabelText("Kanal"), "post");
    await userEvent.clear(screen.getByLabelText("Versendet am"));
    await userEvent.type(screen.getByLabelText("Versendet am"), "2026-10-12");
    await userEvent.type(screen.getByLabelText("Notiz (optional)"), "Briefe");
    await userEvent.click(screen.getByRole("button", { name: "Markieren" }));
    expect(backend.mutations["bulk:startMarkSent"]).toHaveBeenCalledWith({
      ids: ["a", "b"],
      values: { sentOn: "2026-10-12", channel: "post", note: "Briefe" },
    });
    expect(dialog).toBeDefined();
  });

  test("SND-20 more than 2,000 selected documents disable the bulk actions; nothing selected hides the bar", () => {
    const { unmount } = renderWithIntl(
      <BulkActions selected={Array.from({ length: 2001 }, (_, i) => `d${i}`)} onDone={vi.fn()} />,
    );
    expect(screen.getByText("Höchstens 2000 Dokumente pro Auftrag.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sammel-Export" })).toBeDisabled();
    unmount();
    renderWithIntl(<BulkActions selected={[]} onDone={vi.fn()} />);
    expect(screen.queryByTestId("bulk-bar")).toBeNull();
  });
});
