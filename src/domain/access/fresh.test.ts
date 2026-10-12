import { describe, expect, test } from "vitest";
import { FRESH_AGE_MS, isSessionFresh, REAUTH_MESSAGE_DE } from "./fresh";
import { ALL_PERMISSIONS, PERMISSIONS, requiresFreshSession } from "./permissions";

const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);

describe("fresh session for ⚠ actions (02 §4.2, 04 §4.9)", () => {
  test("E-AUD-28 a session is fresh for exactly 10 minutes after it was created (Better Auth freshAge 600 s)", () => {
    expect(FRESH_AGE_MS).toBe(600_000);
    expect(isSessionFresh(NOW, NOW)).toBe(true);
    expect(isSessionFresh(NOW - FRESH_AGE_MS, NOW)).toBe(true);
    expect(isSessionFresh(NOW - FRESH_AGE_MS - 1, NOW)).toBe(false);
    expect(isSessionFresh(NOW - 15 * 60_000, NOW)).toBe(false);
  });

  test("E-AUD-28 a session without a creation time or created in the future is never fresh", () => {
    expect(isSessionFresh(undefined, NOW)).toBe(false);
    expect(isSessionFresh(Number.NaN, NOW)).toBe(false);
    expect(isSessionFresh(NOW + 60_000, NOW)).toBe(false);
  });

  test("E-AUD-28 the re-authentication prompt is the German text of F12", () => {
    expect(REAUTH_MESSAGE_DE).toBe("Zur Bestätigung bitte erneut mit Passkey bestätigen.");
  });

  test("E-AUD-28 member, invite and API-key changes require a fresh session; reads never do", () => {
    expect(requiresFreshSession("members.manage")).toBe(true);
    expect(requiresFreshSession("invites.manage")).toBe(true);
    expect(requiresFreshSession("apiKeys.manage")).toBe(true);
    for (const p of ALL_PERMISSIONS) {
      if (!PERMISSIONS[p].write) expect(requiresFreshSession(p), p).toBe(false);
    }
    expect(requiresFreshSession("settings.write")).toBe(false);
  });

  test("E-AUD-28 DOC-24 SND-07 finalising and marking as sent are ⚠ actions with a fresh session; drafts are not", () => {
    expect(requiresFreshSession("invoices.finalize")).toBe(true);
    expect(requiresFreshSession("invoices.send")).toBe(true);
    expect(requiresFreshSession("documents.write")).toBe(false);
    expect(requiresFreshSession("documents.export")).toBe(false);
  });
});
