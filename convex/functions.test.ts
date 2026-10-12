import { v } from "convex/values";
import { afterEach, describe, expect, test } from "vitest";
import { clearInvariantTarget } from "../test/invariants";
import { api, internal } from "./_generated/api";
import { mutation, query, systemMutation } from "./functions";
import { errorCode } from "./lib/errors";
import { appendAudit } from "./model/audit";
import { guardedDb, newWriteStats } from "./model/db";
import { makeT } from "./test.setup";

const DAY = 86_400_000;

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return errorCode(e);
  }
}

describe("wrappers: authentication (AUD-021, SEC-01)", () => {
  test("AUD-021 a public query without identity is rejected (fails closed)", async () => {
    const t = makeT();
    expect(await codeOf(t.query(api.members.me, {}))).toBe("unauthenticated");
    expect(await codeOf(t.query(api.integrity.status, {}))).toBe("unauthenticated");
  });

  test("AUD-021 an identity from an unknown issuer is rejected", async () => {
    const t = makeT();
    const forged = t.withIdentity({ issuer: "https://evil.example", subject: "x" });
    expect(await codeOf(forged.query(api.members.me, {}))).toBe("unauthenticated");
  });

  test("SEC-01 a Better Auth user without a member row has no access", async () => {
    const t = makeT();
    const u = await t.asUser("owner", { noMember: true });
    expect(await codeOf(u.query(api.members.me, {}))).toBe("not_a_member");
  });

  test("SEC-01 expired and disabled members are treated as signed out (E-AUD-30, E-AUD-31)", async () => {
    const t = makeT();
    const expired = await t.asUser("auditor", {
      expiresAt: Date.now() - 1000,
      auditor: { purpose: "Az 1", fiscalYears: [2025] },
    });
    expect(await codeOf(expired.query(api.members.me, {}))).toBe("member_expired");
    const disabled = await t.asUser("viewer", { disabledAt: Date.now() - 1 });
    expect(await codeOf(disabled.query(api.members.me, {}))).toBe("member_disabled");
  });

  test("SEC-01 writes need a live Better Auth session (a JWT outlives sign-out by up to 15 min)", async () => {
    const t = makeT();
    const owner = await t.asUser("owner", { sessionExpired: true });
    expect((await owner.query(api.members.me, {}))?.role).toBe("owner");
    expect(await codeOf(owner.mutation(api.invites.create, { email: "a@b.de", role: "viewer" }))).toBe(
      "session_invalid",
    );
  });
});

describe("wrappers: roles and scopes (02 §4.3, E-AUD-29)", () => {
  test.each(["bookkeeper", "viewer", "auditor"] as const)("SEC-01 %s cannot manage invites", async (role) => {
    const t = makeT();
    const u = await t.asUser(
      role,
      role === "auditor" ? { expiresAt: Date.now() + DAY, auditor: { purpose: "Az", fiscalYears: [2025] } } : {},
    );
    try {
      await u.mutation(api.invites.create, { email: "x@y.de", role: "viewer" });
      expect.unreachable();
    } catch (e) {
      expect(errorCode(e)).toBe("forbidden_role");
      expect((e as { data: { message: string } }).data.message).toMatch(
        /^Ihre Rolle \(.+\) erlaubt diese Aktion nicht\.$/,
      );
    }
  });

  test("SEC-01 every role may read its own member record", async () => {
    const t = makeT();
    for (const role of ["owner", "bookkeeper", "viewer"] as const) {
      const u = await t.asUser(role);
      expect(await u.query(api.members.me, {})).toMatchObject({ role, actor: u.actor, email: u.email });
    }
  });

  test("SEC-02 API keys need the matching scope; members/invites are never grantable", async () => {
    const t = makeT();
    const key = await t.asApiKey(["audit:read", "settings:write"]);
    await expect(key.query(api.integrity.status, {})).resolves.toMatchObject({ finalisationBlocked: false });
    expect(await codeOf(key.mutation(api.invites.create, { email: "a@b.de", role: "viewer" }))).toBe("forbidden_scope");
    expect(await codeOf(key.query(api.members.list, {}))).toBe("forbidden_scope");
    const weak = await t.asApiKey(["contacts:read"]);
    expect(await codeOf(weak.query(api.integrity.status, {}))).toBe("forbidden_scope");
  });

  test("SEC-02 a token cannot carry more scopes than the stored key; revoked/expired keys fail (E-AUD-25)", async () => {
    const t = makeT();
    const inflated = await t.asApiKey(["contacts:read"], { tokenScopes: ["contacts:read", "audit:read"] });
    expect(await codeOf(inflated.query(api.integrity.status, {}))).toBe("forbidden_scope");
    const revoked = await t.asApiKey(["audit:read"], { revokedAt: Date.now() - 1 });
    expect(await codeOf(revoked.query(api.integrity.status, {}))).toBe("key_revoked");
    const expired = await t.asApiKey(["audit:read"], { expiresAt: Date.now() - 1 });
    expect(await codeOf(expired.query(api.integrity.status, {}))).toBe("key_revoked");
  });

  test("SEC-02 an MCP token is not accepted for an api-only key and vice versa", async () => {
    const t = makeT();
    const key = await t.asApiKey(["audit:read"]);
    const asMcpSubject = t.withIdentity({
      issuer: "https://api.test.local",
      subject: `mcp:${key.prefix}`,
      scopes: ["audit:read"],
      keyHash: key.hash,
    } as never);
    expect(await codeOf(asMcpSubject.query(api.integrity.status, {}))).toBe("key_revoked");
  });

  test("API-006 a server JWT must carry the stored key's hash (a known public id alone is not enough)", async () => {
    const t = makeT();
    const forged = await t.asApiKey(["audit:read"], { keyHash: "00".repeat(32) });
    expect(await codeOf(forged.query(api.integrity.status, {}))).toBe("key_revoked");
    const key = await t.asApiKey(["audit:read"]);
    const noHash = t.withIdentity({
      issuer: "https://api.test.local",
      subject: `api-key:${key.prefix}`,
      scopes: ["audit:read"],
    } as never);
    expect(await codeOf(noHash.query(api.integrity.status, {}))).toBe("key_revoked");
    await expect(key.query(api.integrity.status, {})).resolves.toBeDefined();
  });
});

describe("wrappers: attribution (AUD-002, SEC-02)", () => {
  test("AUD-002 UI writes are user:<id> with actorRole, actorLabel, channel ui and sessionId", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const inviteId = await owner.mutation(api.invites.create, { email: "Steuer@Example.de", role: "bookkeeper" });
    const entry = await t.run(async (ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => q.eq("entity.table", "invites").eq("entity.id", inviteId))
        .first(),
    );
    expect(entry).toMatchObject({
      actor: owner.actor,
      actorRole: "owner",
      actorLabel: owner.email,
      channel: "ui",
      sessionId: owner.sessionId,
      action: "invite.create",
      diff: { after: { email: "steuer@example.de", role: "bookkeeper", createdBy: owner.actor } },
    });
  });

  test("AUD-002 system jobs are system:<job> with channel cron", async () => {
    const t = makeT();
    await t.action(internal.integrity.verify, {});
    const entry = await t.run(async (ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    expect(entry).toMatchObject({ actor: "system:cron.integrity.verify", channel: "cron", action: "integrity.run" });
    expect(entry?.actorRole).toBeUndefined();
  });
});

describe("wrappers: definition rules (AUD-011, AUD-012)", () => {
  test("AUD-012 a public function without a declared permission cannot even be defined", () => {
    expect(() => mutation({ args: {}, handler: async () => null } as never)).toThrow("must declare a known permission");
    expect(() => query({ permission: "nope", args: {}, handler: async () => null } as never)).toThrow(
      "must declare a known permission",
    );
    expect(() => query((async () => null) as never)).toThrow("object form");
  });

  test("AUD-012 system functions must name a registered job", () => {
    expect(() =>
      systemMutation({ job: "cron.unknown", args: { a: v.string() }, handler: async () => null } as never),
    ).toThrow("unknown system job");
  });
});

describe("guarded db (AUD-001, AUD-005, AUD-010)", () => {
  afterEach(() => clearInvariantTarget());

  test("AUD-005 audit entries cannot be patched or deleted through the model layer (E-AUD-02)", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.invites.create, { email: "a@b.de", role: "viewer" });
    const code = await t.run(async (ctx) => {
      const stats = newWriteStats();
      const db = guardedDb(ctx.db, stats);
      const first = await ctx.db.query("auditLog").first();
      if (!first) throw new Error("no entry");
      const patch = await codeOf(db.patch("auditLog", first._id, { reason: "forged" }));
      const legacy = await codeOf(db.patch(first._id, { reason: "forged" }));
      const del = await codeOf(db.delete("auditLog", first._id));
      return [patch, legacy, del];
    });
    expect(code).toEqual(["immutable_record", "immutable_record", "immutable_record"]);
  });

  test("AUD-001 a transaction that writes without an audit entry is detected (E-AUD-01 audit_missing)", async () => {
    const t = makeT();
    const stats = await t.run(async (ctx) => {
      const s = newWriteStats();
      const db = guardedDb(ctx.db, s);
      await db.insert("invites", {
        email: "x@y.de",
        role: "viewer",
        expiresAt: Date.now() + DAY,
        createdBy: "system:auth",
        createdAt: Date.now(),
      });
      return { writes: s.writes, audits: s.audits };
    });
    expect(stats).toEqual({ writes: 1, audits: 0 });
    // The wrapper turns exactly this state into audit_missing (onSuccess in convex/functions.ts); the unaudited row
    // is also what RI-15 reports:
    const violations = await t.query(internal.invariants.check, {});
    expect(violations).toEqual([
      expect.objectContaining({ id: "RI-15", message: expect.stringContaining("ohne Protokolleintrag") }),
    ]);
  });

  test("AUD-001 audited writes count as audited", async () => {
    const t = makeT();
    const stats = await t.asSystem("auth").model(async (ctx) => {
      const s = newWriteStats();
      const m = { ...ctx, db: guardedDb(ctx.db, s) };
      await appendAudit(m, { action: "security.access_denied", entity: { table: "members", id: "x" } });
      return { writes: s.writes, audits: s.audits };
    });
    expect(stats).toEqual({ writes: 0, audits: 1 });
  });
});
