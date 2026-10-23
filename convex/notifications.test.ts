import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { recordIntegrityRun } from "./model/integrity";
import { saveNotificationAddress } from "./model/notificationSettings";
import { notifyKind } from "./model/notifications";
import { makeT, type TestT } from "./test.setup";

/** F12 NTF-001…007: bell/list, dedupe + escalation, channel matrix, e-mail and ntfy delivery, event sources. */

const NOW = new Date("2026-10-12T10:00:00Z");
const HOUR = 60 * 60 * 1000;
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.NTFY_SENDER = "memory";
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.NTFY_SENDER;
});

async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}
const messageOf = (e: unknown) => String((e as { data?: { message?: string } }).data?.message ?? e);

const rows = (t: TestT) => t.run((ctx) => ctx.db.query("notifications").collect());
const mails = (t: TestT, kind: string) =>
  t.run(async (ctx) => (await ctx.db.query("devMailbox").collect()).filter((m) => m.kind === kind));

async function withChannels(t: TestT) {
  const owner = await t.asUser("owner");
  await t.model(OWNER, (ctx) => saveNotificationAddress(ctx, "alarm@example.test"));
  await owner.mutation(api.notifications.saveNtfy, {
    ntfy: { serverUrl: "https://ntfy.example.test", topic: "firma-alarm", token: "tk_geheim", sendDetails: false },
  });
  return owner;
}

describe("in-app notifications (NTF-001)", () => {
  test("NTF-001 the bell counts unread notifications; the list filters; read and „Alle als gelesen markieren“", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const sys = t.asSystem("cron.deadlines.notify");
    await sys.model((ctx) => notifyKind(ctx, "rules.stale", { title: "Regeln veraltet" }));
    await sys.model((ctx) => notifyKind(ctx, "export.ready", { title: "Export bereit" }));
    await sys.model((ctx) => notifyKind(ctx, "member.joined", { title: "Neues Mitglied" }));
    expect(await owner.query(api.notifications.unreadCount, {})).toBe(3);
    const warnings = await owner.query(api.notifications.list, { severity: "warning" });
    expect(warnings.map((n) => n.title)).toEqual(["Regeln veraltet"]);
    expect(warnings[0]).toMatchObject({ kind: "rules.stale", kindLabel: "Regeln veraltet", count: 1, readAt: null });

    await owner.mutation(api.notifications.markRead, { id: warnings[0]?.id as string });
    expect(await owner.query(api.notifications.unreadCount, {})).toBe(2);
    expect(await owner.query(api.notifications.list, { unreadOnly: true })).toHaveLength(2);
    expect(await owner.mutation(api.notifications.markAllRead, {})).toBe(2);
    expect(await owner.query(api.notifications.unreadCount, {})).toBe(0);

    const viewer = await t.asUser("viewer");
    expect(await viewer.query(api.notifications.list, {})).toHaveLength(3);
    expect(errorCode(await catching(viewer.mutation(api.notifications.markAllRead, {})))).toBe("forbidden_role");
    const auditor = await t.asUser("auditor");
    expect(errorCode(await catching(auditor.query(api.notifications.list, {})))).toBe("forbidden_role");
  });

  test("NTF-001 read notifications are purged after 90 days; unread ones stay", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const sys = t.asSystem("cron.notifications.maintain");
    await sys.model((ctx) => notifyKind(ctx, "export.ready", { title: "Export 1" }));
    await sys.model((ctx) => notifyKind(ctx, "import.finished", { title: "Import 1" }));
    const [first] = await owner.query(api.notifications.list, { kind: "export.ready" });
    await owner.mutation(api.notifications.markRead, { id: first?.id as string });
    expect(await t.mutation(internal.notifications.maintainCron, {})).toBeNull(); // IS_TEST: skipped unless forced
    vi.setSystemTime(new Date(NOW.getTime() + 89 * 24 * HOUR));
    expect(await t.mutation(internal.notifications.maintainCron, { force: true })).toEqual({ escalated: 0, purged: 0 });
    vi.setSystemTime(new Date(NOW.getTime() + 90 * 24 * HOUR));
    expect(await t.mutation(internal.notifications.maintainCron, { force: true })).toEqual({ escalated: 0, purged: 1 });
    expect((await rows(t)).map((n) => n.title)).toEqual(["Import 1"]);
  });
});

describe("dedupe and escalation (NTF-006, E-NTF-03)", () => {
  test("NTF-006 the same backup-stale event hourly gives one notification with a counter, re-sent once after 24 h", async () => {
    const t = makeT();
    await withChannels(t);
    const sys = t.asSystem("cron.notifications.maintain");
    const stale = (h: number) =>
      sys.model((ctx) =>
        notifyKind(ctx, "backup.stale", {
          title: `Letzte Datenbanksicherung vor ${h} Stunden.`,
          dedupeKey: "backup.stale",
        }),
      );
    await stale(26);
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));
    await stale(27);
    await stale(28);
    const [n, ...rest] = await rows(t);
    expect(rest).toHaveLength(0);
    expect(n).toMatchObject({
      kind: "backup.stale",
      severity: "error",
      count: 3,
      title: "Letzte Datenbanksicherung vor 28 Stunden.",
    });
    await t.finishAllScheduledFunctions(() => {});
    expect(await mails(t, "notification")).toHaveLength(1);
    expect(await mails(t, "ntfy")).toHaveLength(1);

    vi.setSystemTime(new Date(NOW.getTime() + 23 * HOUR));
    expect(await t.mutation(internal.notifications.maintainCron, { force: true })).toMatchObject({ escalated: 0 });
    vi.setSystemTime(new Date(NOW.getTime() + 24 * HOUR));
    expect(await t.mutation(internal.notifications.maintainCron, { force: true })).toMatchObject({ escalated: 1 });
    vi.setSystemTime(new Date(NOW.getTime() + 48 * HOUR));
    expect(await t.mutation(internal.notifications.maintainCron, { force: true })).toMatchObject({ escalated: 0 });
    await t.finishAllScheduledFunctions(() => {});
    expect(await mails(t, "notification")).toHaveLength(2);
  });
});

describe("channel matrix and delivery (NTF-002, NTF-003, NTF-004)", () => {
  test("NTF-002 NTF-003 NTF-004 an integrity failure goes to in-app, e-mail and ntfy (priority 5) and cannot be switched off", async () => {
    const t = makeT();
    const owner = await withChannels(t);
    const e = await catching(
      owner.mutation(api.notifications.setChannels, {
        kind: "integrity.failed",
        channels: { inApp: true, email: false, ntfy: false, digest: false },
      }),
    );
    expect(messageOf(e)).toBe("Kritische Meldungen können nicht abbestellt werden.");
    await owner.mutation(api.notifications.setChannels, {
      kind: "integrity.failed",
      channels: { inApp: true, email: true, ntfy: true, digest: false },
    });
    const matrix = await owner.query(api.notifications.settings, {});
    expect(matrix.rows.find((r) => r.kind === "integrity.failed")).toMatchObject({
      locked: true,
      severity: "critical",
    });
    expect(matrix.ntfy).toMatchObject({ topic: "firma-alarm", hasToken: true, sendDetails: false });
    expect(matrix.ntfyIsPublic).toBe(false);

    // NTF-007: raised by the integrity run (cron), not by UI code
    await t.asSystem("cron.integrity.verify").model((ctx) =>
      recordIntegrityRun(ctx, {
        scope: "incremental",
        lastVerifiedSeq: 10,
        findings: [{ kind: "hash_mismatch", severity: "error", detail: "Protokolleintrag seq 7 wurde verändert." }],
      }),
    );
    const [n] = await owner.query(api.notifications.list, { kind: "integrity.failed" });
    expect(n).toMatchObject({ severity: "critical", title: "Integritätsprüfung fehlgeschlagen" });
    await t.finishAllScheduledFunctions(() => {});
    const [mail] = await mails(t, "notification");
    expect(mail).toMatchObject({ to: "alarm@example.test" });
    expect(mail?.subject).toMatch(/^\[.+\] Integritätsprüfung fehlgeschlagen – Details in der App$/);
    expect(mail?.text).toContain("https://app.test.local/einstellungen/system/integritaet");
    expect(mail?.text).not.toContain("seq 7");
    const [push] = await mails(t, "ntfy");
    expect(push).toMatchObject({
      to: "ntfy@firma-alarm",
      subject: "Integritätsprüfung fehlgeschlagen – Details in der App",
    });
    expect(push?.text.startsWith("5\n")).toBe(true);
  });

  test("NTF-002 a non-critical kind follows the matrix: in-app off marks it read, e-mail off sends nothing", async () => {
    const t = makeT();
    const owner = await withChannels(t);
    await owner.mutation(api.notifications.setChannels, {
      kind: "backup.stale",
      channels: { inApp: false, email: false, ntfy: false, digest: false },
    });
    await t.asSystem("cron.notifications.maintain").model((ctx) => notifyKind(ctx, "backup.stale", { title: "Alt" }));
    await t.finishAllScheduledFunctions(() => {});
    expect(await owner.query(api.notifications.unreadCount, {})).toBe(0);
    expect(await mails(t, "notification")).toHaveLength(0);
    expect(await mails(t, "ntfy")).toHaveLength(0);
  });

  test("NTF-004 the ntfy token is stored encrypted; the server must be https (or a tailnet host); E-NTF-01 after 3 failures", async () => {
    const t = makeT();
    const owner = await withChannels(t);
    const s = await t.run((ctx) => ctx.db.query("notificationSettings").first());
    expect(s?.ntfy?.encryptedToken).toBeDefined();
    expect(JSON.stringify(s)).not.toContain("tk_geheim");
    const bad = await catching(
      owner.mutation(api.notifications.saveNtfy, {
        ntfy: { serverUrl: "http://ntfy.example.org", topic: "x", sendDetails: false },
      }),
    );
    expect(messageOf(bad)).toBe("Die ntfy-Server-Adresse muss mit https:// beginnen.");
    await owner.mutation(api.notifications.saveNtfy, {
      ntfy: { serverUrl: "http://ntfy.tail1234.ts.net", topic: "x", sendDetails: false },
    });
    expect((await t.run((ctx) => ctx.db.query("notificationSettings").first()))?.ntfy?.encryptedToken).toBeDefined();

    for (let i = 0; i < 3; i++) await t.mutation(internal.notifications.recordNtfy, { ok: false });
    const [warn] = await owner.query(api.notifications.list, { kind: "ntfy.failed" });
    expect(warn?.title).toBe("ntfy-Benachrichtigungen konnten nicht zugestellt werden.");
    expect(
      errorCode(await catching((await t.asUser("bookkeeper")).mutation(api.notifications.saveNtfy, { ntfy: null }))),
    ).toBe("forbidden_role");
  });
});

describe("F12 §5.5 notification edge cases", () => {
  test("E-NTF-01 an unreachable ntfy server leaves in-app and e-mail untouched; the warning comes after the 3rd failure", async () => {
    const t = makeT();
    const owner = await withChannels(t);
    delete process.env.NTFY_SENDER; // the real HTTP transport …
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND ntfy.example.test"); // … to a server that is down
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const sys = t.asSystem("cron.backups.verify");
      const raise = async (i: number) => {
        await sys.model((ctx) => notifyKind(ctx, "backup.stale", { title: `Alt ${i}`, dedupeKey: `stale-${i}` }));
        await t.finishAllScheduledFunctions(() => {});
      };
      await raise(1);
      await raise(2);
      expect(await owner.query(api.notifications.list, { kind: "ntfy.failed" })).toHaveLength(0);
      await raise(3);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const [warn, ...more] = await owner.query(api.notifications.list, { kind: "ntfy.failed" });
      expect(more).toHaveLength(0);
      expect(warn).toMatchObject({
        severity: "warning",
        title: "ntfy-Benachrichtigungen konnten nicht zugestellt werden.",
      });
      // in-app and e-mail were delivered for every event
      expect(await owner.query(api.notifications.list, { kind: "backup.stale" })).toHaveLength(3);
      expect(await mails(t, "notification")).toHaveLength(3);
      expect(await mails(t, "ntfy")).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("E-NTF-02 disabling e-mail (or in-app) for a critical kind is refused with the F12 text; the matrix is unchanged", async () => {
    const t = makeT();
    const owner = await withChannels(t);
    for (const kind of [
      "integrity.failed",
      "checkpoint.upload_failed",
      "access.misconfigured",
      "clock.skew_critical",
    ]) {
      for (const off of [{ email: false }, { inApp: false }]) {
        const e = await catching(
          owner.mutation(api.notifications.setChannels, {
            kind,
            channels: { inApp: true, email: true, ntfy: true, digest: false, ...off },
          }),
        );
        expect(messageOf(e)).toBe("Kritische Meldungen können nicht abbestellt werden.");
      }
    }
    const stored = await t.run((ctx) => ctx.db.query("notificationSettings").first());
    expect(stored?.channelsByKind?.["integrity.failed"]).toBeUndefined();
    const matrix = await owner.query(api.notifications.settings, {});
    expect(matrix.rows.find((r) => r.kind === "integrity.failed")).toMatchObject({ locked: true });
  });

  test("E-NTF-03 the same event repeated hourly is deduplicated: one notification, the counter increments, delivered once", async () => {
    const t = makeT();
    await withChannels(t);
    const sys = t.asSystem("cron.backups.verify");
    for (let h = 0; h < 5; h++) {
      vi.setSystemTime(new Date(NOW.getTime() + h * HOUR));
      await sys.model((ctx) =>
        notifyKind(ctx, "backup.stale", {
          title: `Letzte Datenbanksicherung vor ${27 + h} Stunden.`,
          entity: { table: "system", id: "backups" },
        }),
      );
    }
    const all = await rows(t);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      kind: "backup.stale",
      count: 5,
      title: "Letzte Datenbanksicherung vor 31 Stunden.",
    });
    await t.finishAllScheduledFunctions(() => {});
    expect(await mails(t, "notification")).toHaveLength(1);
  });
});

describe("event sources (NTF-007)", () => {
  test("NTF-007 a payment recorded via MCP creates the payment.received and invoice.paid notifications", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const id = f.id as Id<"salesDocuments">;
    const mcp = await t.asMcp(["payments:write", "payments:read"]);
    const args = {
      documentId: id,
      source: { kind: "clearing" as const, accountId: f.bankAccount },
      date: "2026-10-12",
      amountCents: 119_000,
    };
    const token = "ct_test-ntf-007";
    await mcp.mutation(api.confirmTokens.issue, {
      intent: "payment_record",
      args,
      entities: [{ table: "salesDocuments", id }],
      tokenHash: await sha256Hex(token),
    });
    await mcp.mutation(api.payments.recordForInvoice, { ...args, confirmToken: token });
    const list = await f.owner.query(api.notifications.list, {});
    expect(list.map((n) => n.kind).sort()).toEqual(["invoice.paid", "payment.received"]);
    expect(list.find((n) => n.kind === "payment.received")?.title).toMatch(/^Zahlung über 1\.190,00\s€ erfasst$/);
    expect(list.find((n) => n.kind === "invoice.paid")?.link).toBe(`/rechnungen/${id}`);
  });
});
