import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";

/** F12 §5.2/§5.3: role refusals and the auditor member's edge cases (E-AUD-29 … E-AUD-36). */

const NOW = new Date("2026-10-12T10:00:00Z");
const DAY = 86_400_000;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function failure(p: Promise<unknown>): Promise<{ code: string | undefined; message: string | undefined }> {
  try {
    await p;
  } catch (e) {
    return { code: errorCode(e), message: (e as { data?: { message?: string } }).data?.message };
  }
  throw new Error("expected an error");
}

const auditorOf = (t: TestT, years: number[], extra: { expiresAt?: number; disabledAt?: number } = {}) =>
  t.asUser("auditor", {
    expiresAt: extra.expiresAt ?? NOW.getTime() + 10 * DAY,
    ...(extra.disabledAt !== undefined ? { disabledAt: extra.disabledAt } : {}),
    auditor: { purpose: "Az. 123/456/78901", fiscalYears: years },
  });

describe("role refusals (E-AUD-29, E-AUD-32)", () => {
  test("E-AUD-29 a bookkeeper writing owner-only settings and a viewer finalising get forbidden_role with their role", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t);
    const bookkeeper = await t.asUser("bookkeeper");
    expect(
      await failure(
        bookkeeper.mutation(api.notifications.setChannels, {
          kind: "backup.stale",
          channels: { inApp: true, email: false, ntfy: false, digest: false },
        }),
      ),
    ).toEqual({ code: "forbidden_role", message: "Ihre Rolle (Buchhaltung) erlaubt diese Aktion nicht." });
    const viewer = await t.asUser("viewer");
    expect(await failure(viewer.action(api.invoices.finalize, { id, version: 1 }))).toEqual({
      code: "forbidden_role",
      message: "Ihre Rolle (Lesezugriff) erlaubt diese Aktion nicht.",
    });
  });

  test("E-AUD-32 an auditor gets 403 „Nur Lesezugriff.“ for mutations and actions; nothing is written", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t);
    const auditor = await auditorOf(t, [2026]);
    const before = await t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).length);
    const readOnly = { code: "forbidden_role", message: "Nur Lesezugriff." };
    expect(await failure(auditor.mutation(api.invites.create, { email: "x@example.test", role: "viewer" }))).toEqual(
      readOnly,
    );
    expect(await failure(auditor.mutation(api.corrections.cancel, { id }))).toEqual(readOnly);
    expect(await failure(auditor.action(api.invoices.finalize, { id, version: 1 }))).toEqual(readOnly);
    expect(await failure(auditor.mutation(api.notifications.markAllRead, {}))).toEqual(readOnly);
    expect(await t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).length)).toBe(before);
    // reads still work
    expect(await auditor.query(api.invoices.get, { id })).not.toBeNull();
  });
});

describe("auditor lifecycle (E-AUD-30, E-AUD-31, E-AUD-36)", () => {
  test("E-AUD-30 an expired auditor gets no data; the text names the expiry date and the company", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t);
    const auditor = await auditorOf(t, [2026], { expiresAt: NOW.getTime() - 1000 });
    const company = await t.run(async (ctx) => (await ctx.db.query("companyProfile").first())?.name);
    const expected = {
      code: "member_expired",
      message: `Ihr Prüferzugang ist am 12.10.2026 abgelaufen. Bitte wenden Sie sich an ${company}.`,
    };
    expect(await failure(auditor.query(api.invoices.get, { id }))).toEqual(expected);
    expect(await failure(auditor.mutation(api.auditLog.recordAccess, { path: "/rechnungen" }))).toEqual(expected);
  });

  test("E-AUD-31 an auditor deactivated during a session is refused at the next request with „beendet“", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t);
    const owner = await t.asUser("owner");
    const auditor = await auditorOf(t, [2026]);
    expect(await auditor.query(api.invoices.get, { id })).not.toBeNull();
    if (!auditor.memberId) throw new Error("no member");
    await owner.mutation(api.members.disable, { memberId: auditor.memberId, reason: "Prüfung beendet" });
    const r = await failure(auditor.query(api.invoices.get, { id }));
    expect(r.code).toBe("member_disabled");
    expect(r.message).toMatch(/^Ihr Prüferzugang ist am 12\.10\.2026 beendet\. Bitte wenden Sie sich an .+\.$/);
  });

  test("E-AUD-36 a shared sign-in cannot be prevented, but every access is logged per session and the owner can end them", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const auditor = await auditorOf(t, [2026]);
    // a second device signs in with the same account (shared credentials)
    const second = await t.asUser("auditor", { existingUserId: auditor.userId });
    expect(second.sessionId).not.toBe(auditor.sessionId);
    await auditor.mutation(api.auditLog.recordAccess, { path: "/rechnungen" });
    await second.mutation(api.auditLog.recordAccess, { path: "/buchhaltung/journal" });
    const access = (await t.run((ctx) => ctx.db.query("auditLog").collect())).filter(
      (e) => e.action === "auditor.access",
    );
    expect(access.map((e) => [e.actor, e.sessionId, e.entity.id])).toEqual([
      [auditor.actor, auditor.sessionId, "/rechnungen"],
      [auditor.actor, second.sessionId, "/buchhaltung/journal"],
    ]);
    if (!auditor.memberId) throw new Error("no member");
    await owner.mutation(api.members.revokeSessions, { memberId: auditor.memberId });
    expect((await failure(second.mutation(api.auditLog.recordAccess, { path: "/" }))).code).toBe("session_invalid");
    expect((await failure(auditor.mutation(api.auditLog.recordAccess, { path: "/" }))).code).toBe("session_invalid");
  });
});

describe("granted fiscal years (E-AUD-33)", () => {
  test("E-AUD-33 data outside the granted years is filtered out of lists and single reads; master data stays", async () => {
    const t = makeT();
    const { id, personId } = await finalizedInvoice(t); // dated 2026
    const other = await auditorOf(t, [2025]);
    expect(await other.query(api.invoices.get, { id })).toBeNull();
    const page = await other.query(api.invoices.list, { paginationOpts: { numItems: 50, cursor: null } });
    expect(page.page.map((d: { _id?: string; id?: string }) => d._id ?? d.id)).not.toContain(id);
    expect(await other.query(api.contacts.get, { id: personId })).not.toBeNull();

    const granted = await auditorOf(t, [2026]);
    expect(await granted.query(api.invoices.get, { id })).not.toBeNull();
    const grantedPage = await granted.query(api.invoices.list, { paginationOpts: { numItems: 50, cursor: null } });
    expect(grantedPage.page.length).toBeGreaterThan(0);
  });
});
