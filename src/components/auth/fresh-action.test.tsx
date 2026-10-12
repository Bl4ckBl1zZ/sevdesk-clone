import { act, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { FreshActionProvider, retryWhileStale, useFreshAction } from "./fresh-action";

const reauth = vi.hoisted(() => ({ onSuccess: null as null | (() => void) }));
vi.mock("./session-provider", () => ({
  ReauthPanel: ({ onSuccess }: { onSuccess: () => void }) => {
    reauth.onSuccess = onSuccess;
    return <p>Passkey-Abfrage</p>;
  },
}));

const stale = () =>
  new ConvexError({ code: "reauth_required", message: "Zur Bestätigung bitte erneut mit Passkey bestätigen." });

function Probe({ fn, onResult }: { fn: () => Promise<string>; onResult: (r: string) => void }) {
  const fresh = useFreshAction();
  return (
    <button type="button" onClick={() => void fresh(fn).then(onResult, (e: Error) => onResult(`error:${e.message}`))}>
      Ausführen
    </button>
  );
}

describe("fresh session dialog (04 §4.9, E-AUD-28)", () => {
  test("E-AUD-28 TST-AUD-31 reauth_required opens the confirmation dialog; after re-authentication the action is retried", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(stale())
      .mockRejectedValueOnce(stale()) // the Convex token still belongs to the old session
      .mockResolvedValue("ok");
    const onResult = vi.fn();
    renderWithIntl(
      <FreshActionProvider>
        <Probe fn={fn} onResult={onResult} />
      </FreshActionProvider>,
    );
    await act(async () => screen.getByRole("button", { name: "Ausführen" }).click());
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Bestätigung erforderlich");
    expect(dialog).toHaveTextContent("Zur Bestätigung bitte erneut mit Passkey bestätigen.");
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => reauth.onSuccess?.());
    await waitFor(() => expect(onResult).toHaveBeenCalledWith("ok"), { timeout: 3000 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("E-AUD-28 other errors pass through without a dialog", async () => {
    const onResult = vi.fn();
    renderWithIntl(
      <FreshActionProvider>
        <Probe fn={() => Promise.reject(new Error("kaputt"))} onResult={onResult} />
      </FreshActionProvider>,
    );
    await act(async () => screen.getByRole("button", { name: "Ausführen" }).click());
    await waitFor(() => expect(onResult).toHaveBeenCalledWith("error:kaputt"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("E-AUD-28 without the provider the call runs unchanged", async () => {
    const onResult = vi.fn();
    render(<Probe fn={() => Promise.resolve("direkt")} onResult={onResult} />);
    await act(async () => screen.getByRole("button", { name: "Ausführen" }).click());
    expect(onResult).toHaveBeenCalledWith("direkt");
  });

  test("E-AUD-28 retryWhileStale gives up after the retry budget and rethrows", async () => {
    const fn = vi.fn().mockRejectedValue(stale());
    await expect(retryWhileStale(fn, 2, 1)).rejects.toBeInstanceOf(ConvexError);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
