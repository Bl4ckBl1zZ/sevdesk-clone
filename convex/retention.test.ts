import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearInvariantTarget } from "../test/invariants";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice } from "./invoices.fixtures";
import { appendAudit, auditedDelete } from "./model/audit";
import { checkInvariants } from "./model/invariants";
import { makeT } from "./test.setup";

/** F12 PRV-001/PRV-002, RI-20: stored retentionUntil, deletion guard on every path, invariant for audited deletes. */

const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};

describe("retention guard (PRV-001, PRV-002, RI-20)", () => {
  test("PRV-001 PRV-002 E-PRV-01 a finalised invoice stores retentionUntil and cannot be deleted on any model path", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const id = f.id as Id<"salesDocuments">;
    const doc = await t.run((ctx) => ctx.db.get(id));
    expect(doc?.retentionUntil).toBe("2034-12-31");
    let error: unknown;
    try {
      await t.model(OWNER, (ctx) => auditedDelete(ctx, "salesDocuments", id, { action: "document.delete_draft" }));
    } catch (e) {
      error = e;
    }
    expect(dataOf(error)).toMatchObject({
      code: "immutable_record",
      reason: "RETENTION_ACTIVE",
      message: `${f.number} ist bis 31.12.2034 aufbewahrungspflichtig und kann nicht gelöscht werden.`,
    });
    expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
  });

  test("PRV-002 class none records (notifications) carry no retentionUntil and stay deletable", async () => {
    const t = makeT();
    await t.asUser("owner");
    const id = await t.model(OWNER, async (ctx) => {
      const nid = await ctx.db.insert("notifications", {
        kind: "export.ready",
        severity: "info",
        title: "x",
        dedupeKey: "x",
        count: 1,
        createdAt: ctx.now(),
      });
      await appendAudit(ctx, { action: "notification.create", entity: { table: "notifications", id: nid } });
      return nid;
    });
    // class `none`: deletable
    await t.model(OWNER, (ctx) => auditedDelete(ctx, "notifications", id, { action: "notification.purge" }));
    expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
  });

  test("RI-20 an audited deletion of a record within retention is reported by the invariant check", async () => {
    const t = makeT();
    await t.asUser("owner");
    await t.model(OWNER, (ctx) =>
      appendAudit(ctx, {
        action: "document.delete_draft",
        entity: { table: "salesDocuments", id: "geloescht" },
        diff: { before: { number: "RE-9", retentionUntil: "2034-12-31" } },
      }),
    );
    const violations = await t.run((ctx) => checkInvariants(ctx));
    expect(violations).toContainEqual(
      expect.objectContaining({ id: "RI-20", message: expect.stringContaining("salesDocuments/geloescht") }),
    );
    clearInvariantTarget(); // tampered on purpose
  });
});
