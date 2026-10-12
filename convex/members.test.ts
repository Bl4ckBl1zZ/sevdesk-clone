import { describe, expect, test } from "vitest";
import { api, components, internal } from "./_generated/api";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";

const DAY = 86_400_000;

async function sessionsOf(t: TestT, userId: string) {
  const res = (await t.query(components.betterAuth.adapter.findMany, {
    model: "session",
    where: [{ field: "userId", value: userId }],
    paginationOpts: { numItems: 10, cursor: null },
  })) as { page: unknown[] };
  return res.page;
}

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;

describe("invites (02 §4.3, F12 MEM)", () => {
  test("SEC-01 auditor invites need an expiry of at most 30 days and a purpose / fiscal years", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const base = { email: "pruefer@finanzamt.test", role: "auditor" as const };
    expect(await owner.mutation(api.invites.create, base).catch(reasonOf)).toBe("auditor_expiry_required");
    expect(
      await owner
        .mutation(api.invites.create, {
          ...base,
          memberExpiresAt: Date.now() + 31 * DAY,
          auditor: { purpose: "Az 1", fiscalYears: [2025] },
        })
        .catch(reasonOf),
    ).toBe("auditor_expiry_too_long");
    const id = await owner.mutation(api.invites.create, {
      ...base,
      memberExpiresAt: Date.now() + 14 * DAY,
      auditor: { purpose: "Außenprüfung Az 1", fiscalYears: [2024, 2025] },
    });
    const list = await owner.query(api.invites.list, {});
    expect(list.find((i) => i.inviteId === id)).toMatchObject({ role: "auditor", status: "open" });
  });

  test("SEC-01 only the owner manages invites; a new invite supersedes the open one for the same address", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const bookkeeper = await t.asUser("bookkeeper");
    expect(
      await bookkeeper.mutation(api.invites.create, { email: "x@example.test", role: "viewer" }).catch(errorCode),
    ).toBe("forbidden_role");
    const first = await owner.mutation(api.invites.create, { email: "x@example.test", role: "viewer" });
    const second = await owner.mutation(api.invites.create, { email: "X@example.test", role: "bookkeeper" });
    const list = await owner.query(api.invites.list, {});
    expect(list.find((i) => i.inviteId === first)?.status).toBe("revoked");
    expect(list.find((i) => i.inviteId === second)?.status).toBe("open");
    expect(await owner.mutation(api.invites.create, { email: bookkeeper.email, role: "viewer" }).catch(reasonOf)).toBe(
      "already_member",
    );
  });

  test("SEC-01 a revoked invite no longer admits the address", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const inviteId = await owner.mutation(api.invites.create, { email: "late@example.test", role: "viewer" });
    await owner.mutation(api.invites.revoke, { inviteId });
    const decision = await t.query(internal.signup.checkSignIn, { email: "late@example.test" });
    expect(decision).toMatchObject({ allowed: false });
  });

  test("SET-107 the invite mail outcome is stored on the invite", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const inviteId = await owner.mutation(api.invites.create, { email: "m@example.test", role: "viewer" });
    await t.finishAllScheduledFunctions(() => {});
    const invite = await t.run((ctx) => ctx.db.get(inviteId));
    expect(invite).toMatchObject({ mailOutcome: "ok", sentAt: expect.any(Number) });
  });
});

describe("member lifecycle (02 §4.3, E-AUD-30/31)", () => {
  test("SEC-02 disabling a member revokes all sessions immediately; the owner cannot be disabled", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const viewer = await t.asUser("viewer");
    expect(await sessionsOf(t, viewer.userId)).toHaveLength(1);
    if (!viewer.memberId || !owner.memberId) throw new Error("no member");
    await owner.mutation(api.members.disable, { memberId: viewer.memberId, reason: "ausgeschieden" });
    expect(await sessionsOf(t, viewer.userId)).toHaveLength(0);
    expect(await viewer.query(api.members.me, {}).catch(errorCode)).toBe("member_disabled");
    expect(await owner.mutation(api.members.disable, { memberId: owner.memberId, reason: "x" }).catch(errorCode)).toBe(
      "invalid_input",
    );
    const list = await owner.query(api.members.list, {});
    expect(list.find((m) => m.memberId === viewer.memberId)?.access).toBe("disabled");
  });

  test("SEC-02 the hourly expiry job disables expired members and revokes their sessions (member.expired)", async () => {
    const t = makeT();
    const auditor = await t.asUser("auditor", {
      expiresAt: Date.now() - 1,
      auditor: { purpose: "Az 2", fiscalYears: [2025] },
    });
    await t.asUser("viewer", { expiresAt: Date.now() + DAY });
    expect(await t.mutation(internal.members.expireCron, {})).toBe(0); // skipped under IS_TEST
    expect(await t.mutation(internal.members.expireCron, { force: true })).toBe(1);
    expect(await sessionsOf(t, auditor.userId)).toHaveLength(0);
    const entry = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    expect(entry).toMatchObject({ action: "member.expired", actor: "system:cron.members.expire", channel: "cron" });
  });

  test("SEC-01 members.me returns role, expiry and TOTP mirror for the signed-in member", async () => {
    const t = makeT();
    const owner = await t.asUser("owner", { name: "Inhaberin" });
    expect(await owner.query(api.members.me, {})).toMatchObject({
      actor: owner.actor,
      role: "owner",
      name: "Inhaberin",
      expiresAt: null,
      totpEnabled: false,
      auditor: null,
    });
  });
});

describe("fresh session for ⚠ actions (02 §4.2, 04 §4.9, E-AUD-28)", () => {
  test("E-AUD-28 TST-AUD-31 member and invite changes with a 15-minute-old session ask for re-authentication", async () => {
    const t = makeT();
    const stale = await t.asUser("owner", { sessionAgeMs: 15 * 60_000 });
    const viewer = await t.seedUser("viewer");
    if (!viewer.memberId) throw new Error("no member");
    const err = await stale
      .mutation(api.invites.create, { email: "neu@example.test", role: "viewer" })
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("reauth_required");
    expect((err as { data?: { message?: string } }).data?.message).toBe(
      "Zur Bestätigung bitte erneut mit Passkey bestätigen.",
    );
    expect(await stale.mutation(api.members.disable, { memberId: viewer.memberId, reason: "x" }).catch(errorCode)).toBe(
      "reauth_required",
    );
    // Reads and non-⚠ writes keep working with the older session.
    expect(await stale.query(api.members.list, {})).toHaveLength(2);
    // After re-authentication (a new session) the same action runs.
    const fresh = await t.asUser("owner", { email: stale.email, existingUserId: stale.userId });
    await fresh.mutation(api.invites.create, { email: "neu@example.test", role: "viewer" });
  });
});

describe("member administration (04 §4.10: Rolle ändern, Verlängern, Sitzungen abmelden)", () => {
  test("SEC-01 the owner changes a role (member.role_change, audited with before/after); the owner row is fixed", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const member = await t.asUser("viewer");
    if (!member.memberId || !owner.memberId) throw new Error("no member");
    await owner.mutation(api.members.changeRole, { memberId: member.memberId, role: "bookkeeper" });
    expect(await member.query(api.members.me, {})).toMatchObject({ role: "bookkeeper" });
    const entry = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    expect(entry).toMatchObject({
      action: "member.role_change",
      actor: owner.actor,
      actorRole: "owner",
      diff: { before: { role: "viewer" }, after: { role: "bookkeeper" } },
    });
    expect(
      await owner.mutation(api.members.changeRole, { memberId: owner.memberId, role: "viewer" }).catch(reasonOf),
    ).toBe("owner_immutable");
    expect(
      await owner.mutation(api.members.changeRole, { memberId: member.memberId, role: "auditor" }).catch(reasonOf),
    ).toBe("auditor_expiry_required");
  });

  test("SEC-01 a role change ends the member's sessions so the new role applies at the next sign-in", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const member = await t.asUser("bookkeeper");
    if (!member.memberId) throw new Error("no member");
    await owner.mutation(api.members.changeRole, { memberId: member.memberId, role: "viewer" });
    expect(await sessionsOf(t, member.userId)).toHaveLength(0);
  });

  test("SEC-03 AUD-022 extending an auditor grant needs a reason and is recorded in auditor.extensions", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const auditor = await t.asUser("auditor", {
      expiresAt: Date.now() + 2 * DAY,
      auditor: { purpose: "Az 3", fiscalYears: [2025] },
    });
    if (!auditor.memberId) throw new Error("no member");
    const until = Date.now() + 20 * DAY;
    expect(
      await owner
        .mutation(api.members.extend, { memberId: auditor.memberId, expiresAt: until, reason: " " })
        .catch(reasonOf),
    ).toBe("reason_required");
    await owner.mutation(api.members.extend, {
      memberId: auditor.memberId,
      expiresAt: until,
      reason: "Prüfung verlängert",
    });
    const row = await t.run((ctx) => ctx.db.get(auditor.memberId as never));
    expect(row).toMatchObject({
      expiresAt: until,
      auditor: { extensions: [{ expiresAt: until, reason: "Prüfung verlängert", at: expect.any(Number) }] },
    });
    const entry = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    expect(entry).toMatchObject({ action: "member.extend", reason: "Prüfung verlängert" });
  });

  test("SEC-01 extending a member expired by the cron reactivates the access", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const viewer = await t.asUser("viewer", { expiresAt: Date.now() - 1 });
    if (!viewer.memberId) throw new Error("no member");
    await t.mutation(internal.members.expireCron, { force: true });
    expect((await owner.query(api.members.list, {})).find((m) => m.memberId === viewer.memberId)?.access).toBe(
      "disabled",
    );
    await owner.mutation(api.members.extend, { memberId: viewer.memberId, expiresAt: Date.now() + 30 * DAY });
    expect((await owner.query(api.members.list, {})).find((m) => m.memberId === viewer.memberId)?.access).toBe(
      "active",
    );
  });

  test("SEC-02 „Sitzungen abmelden“ ends every session of the member and is audited", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const viewer = await t.asUser("viewer");
    if (!viewer.memberId) throw new Error("no member");
    await owner.mutation(api.members.revokeSessions, { memberId: viewer.memberId });
    expect(await sessionsOf(t, viewer.userId)).toHaveLength(0);
    const actions = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).map((e) => e.action).filter((a) => a.startsWith("member.")),
    );
    expect(actions).toContain("member.revoke_sessions");
    // The member stays active: a new sign-in works (unlike „Deaktivieren").
    expect((await owner.query(api.members.list, {})).find((m) => m.memberId === viewer.memberId)?.access).toBe(
      "active",
    );
  });
});
