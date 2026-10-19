import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { verifyChainPage } from "../src/domain/audit/chain";
import { api } from "./_generated/api";
import { BERLIN, createValues, orgForm, setupCatalog } from "./catalog.fixtures";
import { finalizedInvoice, invoiceValues } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";

/** F12 AUD-006…009 and F04 DOC-41: viewer, per-record history, export, logged reads, attributed MCP changes. */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

const entriesOf = (t: TestT, action: string) =>
  t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).filter((e) => e.action === action));

describe("audit viewer (AUD-006, DOC-41)", () => {
  test("AUD-006 DOC-41 TST-AUD-19 „Was hat Claude heute geändert?“ shows only MCP entries of today with the Claude badge", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    vi.setSystemTime(new Date("2026-10-11T21:30:00Z")); // 23:30 Berlin on the day before
    const mcp = await t.asMcp(["contacts:read", "contacts:write"]);
    const yesterday = await mcp.mutation(api.contacts.create, {
      values: createValues(orgForm("Gestern GmbH"), { address: BERLIN }),
    });
    vi.setSystemTime(NOW);
    await owner.mutation(api.contacts.create, { values: createValues(orgForm("Inhaber GmbH"), { address: BERLIN }) });
    const today = await mcp.mutation(api.contacts.create, {
      values: createValues(orgForm("Claude GmbH"), { address: BERLIN }),
    });

    const res = await owner.query(api.auditLog.search, { preset: "claude_today" });
    expect(res.entries.length).toBeGreaterThan(0);
    for (const e of res.entries) {
      expect(e.actor).toMatch(/^mcp:/);
      expect(e.channel).toBe("mcp");
      expect(e.badge).toEqual({ kind: "mcp", label: "Claude (MCP)" });
      expect(e.at).toBeGreaterThanOrEqual(Date.parse("2026-10-11T22:00:00Z"));
    }
    expect(res.entries.some((e) => e.entity.id === today.id)).toBe(true);
    expect(res.entries.some((e) => e.entity.id === yesterday.id)).toBe(false);
    expect(res.head?.seq).toBeGreaterThan(0);

    const mine = await owner.query(api.auditLog.search, { actorKind: "user", entityTable: "contacts" });
    expect(mine.entries.every((e) => e.badge.label === "Du")).toBe(true);
    const viewer = await t.asUser("viewer");
    const byId = await viewer.query(api.auditLog.search, { entityTable: "contacts", entityId: today.id });
    expect(byId.entries[0]?.badge.label).toBe("Claude (MCP)");
    const actors = await owner.query(api.auditLog.actors, {});
    expect(actors.find((a) => a.actor === res.entries[0]?.actor)?.name).toBe("Claude (MCP)");
  });

  test("AUD-006 paging: the cursor continues below the last seq; text and action filters narrow the list", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    for (const n of ["Alpha", "Beta", "Gamma"]) {
      await owner.mutation(api.contacts.create, { values: createValues(orgForm(`${n} GmbH`), { address: BERLIN }) });
    }
    const first = await owner.query(api.auditLog.search, {
      actions: ["contact.create"],
      entityTable: "contacts",
      limit: 2,
    });
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await owner.query(api.auditLog.search, {
      actions: ["contact.create"],
      entityTable: "contacts",
      limit: 2,
      beforeSeq: first.nextCursor ?? undefined,
    });
    expect(second.entries.length).toBeGreaterThan(0);
    expect(Math.max(...second.entries.map((e) => e.seq))).toBeLessThan(Math.min(...first.entries.map((e) => e.seq)));
  });
});

describe("actor toast (DOC-41)", () => {
  test("DOC-41 T-DOC-027 an MCP draft change is attributed (actor mcp:<id>, channel mcp) and feeds the actor toast", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    expect(await f.owner.query(api.auditLog.latestExternalChange, {})).toBeNull();
    const mcp = await t.asMcp(["documents:write", "documents:read", "contacts:read"]);
    const values = invoiceValues(f.personId);
    const draft = await f.owner.mutation(api.invoices.createDraft, { values });
    await mcp.mutation(api.invoices.updateDraft, {
      id: draft.id,
      version: 1,
      values: { ...values, headText: "Von Claude" },
    });
    const [entry] = (await entriesOf(t, "document.update_draft")).filter((e) => e.actor.startsWith("mcp:"));
    expect(entry).toMatchObject({ channel: "mcp", entity: { table: "salesDocuments", id: draft.id } });
    expect(entry?.diff).toBeDefined();
    const latest = await f.owner.query(api.auditLog.latestExternalChange, {});
    expect(latest).toMatchObject({
      seq: entry?.seq,
      text: "Aktualisiert durch Claude (MCP)",
      description: "Entwurf bearbeitet",
    });
  });
});

describe("per-record history (AUD-007)", () => {
  test("AUD-007 the invoice „Verlauf“ includes its payments", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    await f.owner.mutation(api.payments.recordForInvoice, {
      documentId: f.id,
      source: { kind: "clearing", accountId: f.bankAccount },
      date: "2026-10-12",
      amountCents: 10_000,
    });
    const history = await f.owner.query(api.auditLog.entityHistory, { table: "salesDocuments", id: f.id });
    const actions = history.map((e) => e.action);
    expect(actions).toContain("document.finalize");
    expect(actions).toContain("payment.record");
    expect(history.find((e) => e.action === "document.finalize")?.link).toBe(`/rechnungen/${f.id}`);
    expect(history[0]?.seq).toBeGreaterThan(history.at(-1)?.seq ?? 0);
  });
});

describe("audit export (AUD-008, AUD-009)", () => {
  test("AUD-008 AUD-009 the JSON export re-verifies against the chain and is itself logged", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    await owner.mutation(api.contacts.create, { values: createValues(orgForm("Export GmbH"), { address: BERLIN }) });
    const out = await owner.mutation(api.auditLog.exportLog, { format: "json" });
    expect(out.filename).toBe("audit-log-2026-10-12.json");
    expect(out.contiguous).toBe(true);
    const parsed = JSON.parse(out.content);
    const first = parsed.entries[0];
    const res = await verifyChainPage(parsed.entries, { nextSeq: first.seq, prevHash: first.prevHash });
    expect(res.findings).toEqual([]);
    expect(res.lastVerifiedSeq).toBe(parsed.entries.at(-1).seq);
    const [logged] = await entriesOf(t, "export.audit");
    expect(logged?.actor).toMatch(/^user:/);
    expect(logged?.diff?.after).toMatchObject({ format: "json", contiguous: true });
    const csv = await owner.mutation(api.auditLog.exportLog, { format: "csv", actions: ["contact.create"] });
    expect(csv.content.split("\r\n")[0]).toContain("seq;at;actor");
    expect(csv.count).toBeGreaterThan(0);
  });

  test("AUD-009 auditor requests are logged (first access notifies the owner); owner page views are not, secret screens are", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const auditor = await t.asUser("auditor");
    expect(await auditor.mutation(api.auditLog.recordAccess, { path: "/rechnungen" })).toBe(true);
    expect(await auditor.mutation(api.auditLog.recordAccess, { path: "/buchhaltung/journal" })).toBe(true);
    expect((await entriesOf(t, "auditor.access")).map((e) => e.entity.id)).toEqual([
      "/rechnungen",
      "/buchhaltung/journal",
    ]);
    const ntf = await owner.query(api.notifications.list, { kind: "auditor.first_access" });
    expect(ntf).toHaveLength(1);
    expect(ntf[0]?.count).toBe(1);

    expect(await owner.mutation(api.auditLog.recordAccess, { path: "/rechnungen" })).toBe(false);
    expect(
      await owner.mutation(api.auditLog.recordAccess, { path: "/einstellungen/api", secretScreen: "API-Schlüssel" }),
    ).toBe(true);
    expect(await entriesOf(t, "security.secret_screen")).toHaveLength(1);
    expect(errorCode(await catching(t.mutation(api.auditLog.recordAccess, { path: "/" })))).toBe("unauthenticated");
  });
});
