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
