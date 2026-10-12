import { describe, expect, test } from "vitest";
import { computeEntryHash, genesisHash } from "../src/domain/audit/chain";
import { isEncryptedValue } from "../src/domain/audit/personal";
import { api, internal } from "./_generated/api";
import { appendAudit, auditedInsert, auditedPatch } from "./model/audit";
import { decryptPersonal, getContactKeyRow, shredContactKey } from "./model/contactKeys";
import { makeT, TEST_ENV } from "./test.setup";

describe("audit log (AUD-002, AUD-004)", () => {
  test("AUD-004 entries are gapless from seq 1, start at the genesis hash and chain prevHash → hash", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    for (const email of ["a@example.test", "b@example.test", "c@example.test"]) {
      await owner.mutation(api.invites.create, { email, role: "viewer" });
    }
    const log = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").collect());
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    expect(log[0]?.prevHash).toBe(await genesisHash(TEST_ENV.INSTANCE_NAME));
    for (let i = 0; i < log.length; i++) {
      const e = log[i] as (typeof log)[number];
      if (i > 0) expect(e.prevHash).toBe(log[i - 1]?.hash);
      expect(await computeEntryHash(e.prevHash, e as unknown as Record<string, unknown>)).toBe(e.hash);
    }
  });

  test("AUD-002 updates store only the changed fields; creates store the full content", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const inviteId = await owner.mutation(api.invites.create, { email: "x@example.test", role: "viewer" });
    await owner.mutation(api.invites.revoke, { inviteId });
    const entries = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => q.eq("entity.table", "invites").eq("entity.id", inviteId))
        .collect(),
    );
    expect(entries.map((e) => e.action)).toEqual(["invite.create", "invite.revoke"]);
    expect(entries[0]?.diff?.after).toMatchObject({ email: "x@example.test", role: "viewer" });
    expect(entries[0]?.diff?.before).toBeUndefined();
    expect(entries[1]?.diff).toEqual({ before: {}, after: { revokedAt: expect.any(Number) } });
  });

  test("AUD-003 secrets are redacted before hashing and storage (API key hash)", async () => {
    const t = makeT();
    const key = await t.asApiKey(["audit:read"]);
    const entry = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).find((e) => e.action === "api_key.create"),
    );
    expect(entry?.diff?.after).toMatchObject({ prefix: key.prefix, hash: "[redacted]" });
    expect(JSON.stringify(entry)).not.toContain(`sha256-${key.prefix}`);
    expect(await computeEntryHash(entry?.prevHash ?? "", entry as unknown as Record<string, unknown>)).toBe(
      entry?.hash,
    );
  });

  test("AUD-002 unknown actions and invalid actors are rejected", async () => {
    const t = makeT();
    await expect(
      t
        .asSystem("auth")
        .model((ctx) => appendAudit(ctx, { action: "document.explode", entity: { table: "x", id: "1" } })),
    ).rejects.toThrow("unknown_audit_action");
    await expect(
      t.model({ actor: "owner:owner" as never, channel: "ui" }, (ctx) =>
        appendAudit(ctx, { action: "member.create", entity: { table: "x", id: "1" } }),
      ),
    ).rejects.toThrow();
  });
});

describe("crypto-shredding of personal data in audit diffs (F02 §5.12, DSGVO-02 vs GOBD-06)", () => {
  test("GOBD-06 personal contact fields are stored encrypted with a per-contact key; business ids stay readable", async () => {
    const t = makeT();
    const ctxActor = { actor: "user:u1" as const, role: "owner" as const, channel: "ui" as const };
    const entry = await t.model(ctxActor, (ctx) =>
      appendAudit(ctx, {
        action: "contact.update",
        entity: { table: "contacts", id: "c1" },
        diff: { before: { firstName: "Max", number: "K-1" }, after: { firstName: "Moritz", number: "K-1" } },
      }),
    );
    expect(isEncryptedValue(entry.diff?.after?.firstName)).toBe(true);
    expect(entry.diff?.after?.number).toBe("K-1");
    expect(JSON.stringify(entry)).not.toContain("Moritz");
    const plain = await t.run((ctx) => decryptPersonal(ctx, entry.diff?.after?.firstName));
    expect(plain).toBe("Moritz");
    expect(await t.run((ctx) => getContactKeyRow(ctx, "c1"))).toMatchObject({
      contactId: "c1",
      wrappedKey: expect.any(String),
    });
  });

  test("GOBD-06 shredding the key makes the values unreadable while the hash chain still verifies", async () => {
    const t = makeT();
    const actor = { actor: "user:u1" as const, role: "owner" as const, channel: "ui" as const };
    const entry = await t.model(actor, async (ctx) => {
      const e = await appendAudit(ctx, {
        action: "contact.create",
        entity: { table: "contacts", id: "c2" },
        diff: { after: { lastName: "Muster", notes: "privat" } },
      });
      await appendAudit(ctx, { action: "dsgvo.erasure", entity: { table: "contacts", id: "c2" }, reason: "Art. 17" });
      expect(await shredContactKey(ctx, "c2")).toBe(true);
      return e;
    });
    expect(await t.run((ctx) => decryptPersonal(ctx, entry.diff?.after?.lastName))).toBeNull();
    const row = await t.run((ctx) => getContactKeyRow(ctx, "c2"));
    expect(row?.wrappedKey).toBeUndefined();
    expect(row?.shreddedAt).toBeTypeOf("number");
    const res = await t.action(internal.integrity.verify, {});
    expect(res.findings).toEqual([]);
    // a shredded contact cannot get new personal audit data
    await expect(
      t.model(actor, (ctx) =>
        appendAudit(ctx, {
          action: "contact.update",
          entity: { table: "contacts", id: "c2" },
          diff: { after: { firstName: "X" } },
        }),
      ),
    ).rejects.toThrow();
  });

  test("AUD-010 a shredded key cannot be restored (contactKeys matrix row)", async () => {
    const t = makeT();
    const actor = { actor: "system:auth" as const, channel: "system" as const };
    await t.model(actor, async (ctx) => {
      await appendAudit(ctx, {
        action: "contact.create",
        entity: { table: "contacts", id: "c3" },
        diff: { after: { firstName: "A" } },
      });
      await shredContactKey(ctx, "c3");
    });
    const code = await t.model(actor, async (ctx) => {
      const row = await getContactKeyRow(ctx, "c3");
      if (!row) throw new Error("no key row");
      try {
        await ctx.db.patch("contactKeys", row._id, { wrappedKey: "restored" });
        return "patched";
      } catch (e) {
        return (e as { data?: { code?: string } }).data?.code;
      }
    });
    expect(code).toBe("immutable_record");
  });
});

describe("audited model helpers", () => {
  test("AUD-001 auditedPatch without a change writes nothing", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const before = await t.run((ctx) => ctx.db.query("auditLog").collect());
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, async (ctx) => {
      if (!owner.memberId) throw new Error("no member");
      await auditedPatch(ctx, "members", owner.memberId, { role: "owner" }, { action: "member.role_change" });
    });
    expect((await t.run((ctx) => ctx.db.query("auditLog").collect())).length).toBe(before.length);
  });

  test("AUD-001 RI-15 replaying the audit diffs reproduces every record", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const id = await owner.mutation(api.invites.create, {
      email: "r@example.test",
      role: "auditor",
      memberExpiresAt: Date.now() + 86_400_000,
      auditor: { purpose: "Az 7", fiscalYears: [2025] },
    });
    await owner.mutation(api.invites.revoke, { inviteId: id });
    await t.model({ actor: "system:auth", channel: "system" }, (ctx) =>
      auditedInsert(
        ctx,
        "integrations",
        { kind: "r2_checkpoint", config: { bucket: "cp" }, enabled: true },
        { action: "settings.integrations.update" },
      ),
    );
    expect(await t.query(internal.invariants.check, {})).toEqual([]);
  });
});
