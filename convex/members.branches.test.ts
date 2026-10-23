import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import {
  auditAuthEvent,
  changeMemberRole,
  createInvite,
  createMemberFromSignup,
  disableMember,
  extendMember,
  memberAuthFacts,
  recordInviteMail,
  revokeInvite,
  revokeMemberSessions,
  setTotpEnabled,
} from "./model/members";
import { makeT, SYSTEM_AUTH, type TestT } from "./test.setup";

/**
 * Members and invites (02 §4.3, 04 §4.10, F12 AUD-022) — the sign-up trigger, invite lifecycle, TOTP mirror and
 * the member administration guards of convex/model/members.ts.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
const DAY = 86_400_000;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};

async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

const OWNER_CTX = { actor: "user:owner-test", role: "owner", channel: "ui" } as const;

/** A members id that no longer exists (the row was removed again in the same transaction). */
function missingMember(t: TestT) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("members", {
      authUserId: "gone",
      email: "gone@example.test",
      role: "viewer",
      totpEnabled: false,
      createdAt: Date.now(),
    });
    await ctx.db.delete(id);
    return id;
  });
}

function missingInvite(t: TestT) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("invites", {
      email: "gone@example.test",
      role: "viewer",
      expiresAt: Date.now() + DAY,
      createdBy: "user:x",
      createdAt: Date.now(),
    });
    await ctx.db.delete(id);
    return id;
  });
}

const memberOf = (t: TestT, id: Id<"members">) => t.run((ctx) => ctx.db.get(id));

describe("SEC-01 sign-up trigger", () => {
  test("SEC-01 bootstrap creates the owner with its name; a second trigger for the same user is a conflict", async () => {
    const t = makeT();
    const id = await t.model(SYSTEM_AUTH, (ctx) =>
      createMemberFromSignup(ctx, { authUserId: "u-owner", email: "Owner@Example.test", name: "Inhaberin" }),
    );
    expect(await memberOf(t, id)).toMatchObject({ role: "owner", email: "owner@example.test", name: "Inhaberin" });
    const again = await catching(
      t.model(SYSTEM_AUTH, (ctx) =>
        createMemberFromSignup(ctx, { authUserId: "u-owner", email: "owner@example.test" }),
      ),
    );
    expect(errorCode(again)).toBe("conflict");
    expect(dataOf(again).message).toBe("Mitglied existiert bereits.");
    // without an invite nobody else may sign up
    const stranger = await catching(
      t.model(SYSTEM_AUTH, (ctx) => createMemberFromSignup(ctx, { authUserId: "u-x", email: "x@example.test" })),
    );
    expect(errorCode(stranger)).toBe("signup_forbidden");
  });

  test("SEC-01 SEC-03 an auditor invite carries expiry and scope into the member; a blank name is not stored", async () => {
    const t = makeT();
    await t.model(SYSTEM_AUTH, (ctx) =>
      createMemberFromSignup(ctx, { authUserId: "u-owner", email: "owner@example.test" }),
    );
    const expiresAt = Date.now() + 10 * DAY;
    const inviteId = await t.model(OWNER_CTX, (ctx) =>
      createInvite(ctx, {
        email: "pruefer@finanzamt.test",
        role: "auditor",
        memberExpiresAt: expiresAt,
        auditor: { organisation: "Finanzamt Mitte", purpose: "Außenprüfung", fiscalYears: [2025] },
      }),
    );
    const id = await t.model(SYSTEM_AUTH, (ctx) =>
      createMemberFromSignup(ctx, { authUserId: "u-aud", email: "pruefer@finanzamt.test", name: "   " }),
    );
    const m = await memberOf(t, id);
    expect(m).toMatchObject({
      role: "auditor",
      expiresAt,
      auditor: { organisation: "Finanzamt Mitte", purpose: "Außenprüfung", fiscalYears: [2025], extensions: [] },
      inviteId,
      invitedBy: OWNER_CTX.actor,
    });
    expect(m?.name).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(inviteId)))?.acceptedUserId).toBe("u-aud");
  });
});

describe("SEC-01 SET-107 invite lifecycle", () => {
  test("SEC-01 accepted and revoked invites are not superseded again; revoke guards; the mail outcome distinguishes resend and failure", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const first = await t.model(OWNER_CTX, (ctx) => createInvite(ctx, { email: "a@example.test", role: "viewer" }));
    await t.model(OWNER_CTX, (ctx) => revokeInvite(ctx, first));
    await t.model(OWNER_CTX, (ctx) => revokeInvite(ctx, first)); // already revoked → no-op
    const second = await t.model(OWNER_CTX, (ctx) => createInvite(ctx, { email: "a@example.test", role: "viewer" }));
    const revokes = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((a) => a.action === "invite.revoke"),
    );
    expect(revokes).toHaveLength(1);

    await t.model(OWNER_CTX, (ctx) => recordInviteMail(ctx, second, false));
    await t.model(OWNER_CTX, (ctx) => recordInviteMail(ctx, second, true));
    expect(await t.run((ctx) => ctx.db.get(second))).toMatchObject({ mailOutcome: "ok" });
    const mailActions = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((a) => a.entity.id === second).map((a) => a.action),
    );
    expect(mailActions).toEqual(["invite.create", "invite.create", "invite.resend"]);

    const gone = await missingInvite(t);
    await t.model(OWNER_CTX, (ctx) => recordInviteMail(ctx, gone, true)); // ignored
    expect(errorCode(await catching(t.model(OWNER_CTX, (ctx) => revokeInvite(ctx, gone))))).toBe("not_found");

    await t.model(SYSTEM_AUTH, (ctx) => createMemberFromSignup(ctx, { authUserId: "u-a", email: "a@example.test" }));
    const accepted = await catching(t.model(OWNER_CTX, (ctx) => revokeInvite(ctx, second)));
    expect(errorCode(accepted)).toBe("conflict");
    expect(dataOf(accepted).message).toBe("Die Einladung wurde bereits angenommen.");
    // a member's address cannot be invited again
    const member = await catching(
      t.model(OWNER_CTX, (ctx) => createInvite(ctx, { email: "a@example.test", role: "viewer" })),
    );
    expect(dataOf(member).reason).toBe("already_member");
    expect(owner.actor).toMatch(/^user:/);
  });
});

describe("SEC-02 member administration guards", () => {
  test("SEC-02 disabling twice is a no-op; unknown members are not found everywhere", async () => {
    const t = makeT();
    await t.asUser("owner");
    const viewer = await t.seedUser("viewer");
    const id = viewer.memberId as Id<"members">;
    await t.model(OWNER_CTX, (ctx) => disableMember(ctx, id, "Projekt beendet"));
    await t.model(OWNER_CTX, (ctx) => disableMember(ctx, id, "nochmal"));
    const disables = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((a) => a.action === "member.disable"),
    );
    expect(disables.map((a) => a.reason)).toEqual(["Projekt beendet"]);

    const gone = await missingMember(t);
    for (const call of [
      t.model(OWNER_CTX, (ctx) => disableMember(ctx, gone, "x")),
      t.model(OWNER_CTX, (ctx) => changeMemberRole(ctx, gone, { role: "viewer" })),
      t.model(OWNER_CTX, (ctx) => extendMember(ctx, gone, { expiresAt: null })),
      t.model(OWNER_CTX, (ctx) => revokeMemberSessions(ctx, gone)),
    ])
      expect(errorCode(await catching(call))).toBe("not_found");
  });

  test("SEC-01 SEC-03 a role change to auditor takes the new scope or keeps the stored one; staff expiries are optional", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const bk = await t.seedUser("bookkeeper");
    const id = bk.memberId as Id<"members">;
    const expiresAt = Date.now() + 20 * DAY;
    const scopeless = await catching(
      owner.mutation(api.members.changeRole, { memberId: id, role: "auditor", expiresAt }),
    );
    expect(dataOf(scopeless).reason).toBe("auditor_scope_required");
    await owner.mutation(api.members.changeRole, {
      memberId: id,
      role: "auditor",
      expiresAt,
      auditor: { purpose: "Prüfung 2025", fiscalYears: [2025] },
    });
    expect(await memberOf(t, id)).toMatchObject({
      role: "auditor",
      expiresAt,
      auditor: { purpose: "Prüfung 2025", fiscalYears: [2025], extensions: [] },
    });
    // back to viewer drops the auditor scope, then auditor again without a scope reuses nothing → refused
    await t.model(OWNER_CTX, (ctx) => changeMemberRole(ctx, id, { role: "viewer" }));
    const back = await memberOf(t, id);
    expect(back?.auditor).toBeUndefined();
    expect(back?.expiresAt).toBe(expiresAt);

    // an auditor becomes a viewer: the scope is dropped, the expiry stays
    const aud = await t.seedUser("auditor", {
      expiresAt: Date.now() + 5 * DAY,
      auditor: { purpose: "Betriebsprüfung", fiscalYears: [2024] },
    });
    const audId = aud.memberId as Id<"members">;
    await t.model(OWNER_CTX, (ctx) => changeMemberRole(ctx, audId, { role: "viewer" }));
    expect((await memberOf(t, audId))?.auditor).toBeUndefined();
  });

  test("SEC-01 AUD-022 extending a staff member to unlimited clears the expiry; an auditor extension appends to the history", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const viewer = await t.seedUser("viewer", { expiresAt: Date.now() + 3 * DAY });
    const vid = viewer.memberId as Id<"members">;
    await owner.mutation(api.members.extend, { memberId: vid, expiresAt: null });
    expect((await memberOf(t, vid))?.expiresAt).toBeUndefined();
    const aud = await t.seedUser("auditor", {
      expiresAt: Date.now() + 5 * DAY,
      auditor: { purpose: "Betriebsprüfung", fiscalYears: [2024] },
    });
    const aid = aud.memberId as Id<"members">;
    const next = Date.now() + 15 * DAY;
    await owner.mutation(api.members.extend, { memberId: aid, expiresAt: next, reason: "  Verlängerung beantragt " });
    const m = await memberOf(t, aid);
    expect(m?.auditor?.extensions).toEqual([{ at: Date.now(), expiresAt: next, reason: "Verlängerung beantragt" }]);
    const entry = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).find((a) => a.action === "member.extend" && a.entity.id === aid),
    );
    expect(entry?.reason).toBe("Verlängerung beantragt");
  });
});

describe("SEC-01 Better Auth mirrors", () => {
  test("SEC-01 the TOTP mirror ignores unknown users and unchanged states; auth events of unknown users carry no label", async () => {
    const t = makeT();
    const bk = await t.seedUser("bookkeeper");
    const id = bk.memberId as Id<"members">;
    await t.model(SYSTEM_AUTH, (ctx) => setTotpEnabled(ctx, "kein-user", true));
    await t.model(SYSTEM_AUTH, (ctx) => setTotpEnabled(ctx, bk.userId, false)); // unchanged
    await t.model(SYSTEM_AUTH, (ctx) => setTotpEnabled(ctx, bk.userId, true));
    await t.model(SYSTEM_AUTH, (ctx) => setTotpEnabled(ctx, bk.userId, false));
    expect((await memberOf(t, id))?.totpEnabled).toBe(false);
    const actions = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).map((a) => a.action).filter((a) => a.startsWith("auth.totp")),
    );
    expect(actions).toEqual(["auth.totp_enable", "auth.totp_disable"]);

    await t.model(SYSTEM_AUTH, (ctx) =>
      auditAuthEvent(ctx, "auth.sign_in", "kein-user", { table: "session", id: "s1" }),
    );
    const signIn = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).find((a) => a.action === "auth.sign_in"),
    );
    expect(signIn?.entity).toEqual({ table: "session", id: "s1" });
  });

  test("SEC-01 the last sign-in is the newest session", async () => {
    const t = makeT();
    const bk = await t.seedUser("bookkeeper");
    const later = Date.now() + 60_000;
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: { token: "tok-later", userId: bk.userId, expiresAt: later + DAY, createdAt: later, updatedAt: later },
      },
    });
    const facts = await t.model(SYSTEM_AUTH, (ctx) => memberAuthFacts(ctx, bk.userId));
    expect(facts).toEqual({ passkeys: 0, lastSignInAt: later });
  });
});
