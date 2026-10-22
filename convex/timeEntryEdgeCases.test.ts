import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { emptyProjectForm, emptyTimeEntryForm, type ProjectFormValues } from "../src/domain/schemas/projects";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { b2bBuyer, consumerBuyer, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";

/**
 * F11 §5 edge cases (E-PRJ-02…31) and PRJ-021 attribution against the Convex functions: every case exercises the
 * public mutation the UI/REST/MCP call and checks the specified German message or outcome.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
vi.setConfig({ testTimeout: 60_000 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;
const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message;
const fail = <T>(p: Promise<T>) => p.then(() => expect.unreachable("expected an error")).catch((e: unknown) => e);

async function setup(t: TestT) {
  const s = await setupInvoicing(t);
  const buyer = await b2bBuyer(s.owner);
  return { ...s, ...buyer };
}
type Owner = Awaited<ReturnType<typeof setup>>["owner"];

const projectForm = (over: Partial<ProjectFormValues> = {}): ProjectFormValues => ({
  ...emptyProjectForm(),
  name: "Website-Relaunch",
  hourlyRate: "90,00",
  ...over,
});

async function project(owner: Owner, contactId: string, over: Partial<ProjectFormValues> = {}) {
  const r = await owner.mutation(api.projects.create, { values: projectForm({ contactId, ...over }) });
  return r.id as Id<"projects">;
}

const entryForm = (projectId: string, date: string, duration: string, description = "Konzeption Startseite") => ({
  ...emptyTimeEntryForm(date),
  duration,
  description,
  projectId,
});

async function logEntry(owner: Owner, projectId: string, date: string, duration: string, description?: string) {
  const r = await owner.mutation(api.timeEntries.create, { values: entryForm(projectId, date, duration, description) });
  return r.id as Id<"timeEntries">;
}

const entry = (t: TestT, id: Id<"timeEntries">) =>
  t.run(async (ctx) => {
    const e = await ctx.db.get(id);
    if (!e) throw new Error("missing");
    return e;
  });
const doc = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => {
    const d = await ctx.db.get(id);
    if (!d) throw new Error("missing");
    return d;
  });
const linesOf = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("documentLines")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect()
    ).sort((a, b) => a.position - b.position),
  );
const notificationsOf = (t: TestT, kind: string) =>
  t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.kind === kind));

describe("F11 §5 timer and entry edge cases", () => {
  test("E-PRJ-02 a timer stopped without description and project/contact is saved open as „unvollständig“ and cannot be invoiced until completed", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    await owner.mutation(api.timeEntries.start, {});
    vi.setSystemTime(new Date(NOW.getTime() + 30 * 60_000));
    const stopped = await owner.mutation(api.timeEntries.stop, {});
    expect(stopped.warnings).toContain("Bitte Beschreibung und Projekt oder Kunde ergänzen.");
    const id = stopped.entryIds[0] as Id<"timeEntries">;
    expect(await entry(t, id)).toMatchObject({
      status: "open",
      incomplete: true,
      durationMinutes: 30,
      source: "timer",
    });
    // description only (no project/contact) is still incomplete
    await owner.mutation(api.timeEntries.start, { description: "Telefonat Kunde" });
    vi.setSystemTime(new Date(NOW.getTime() + 45 * 60_000));
    const second = await owner.mutation(api.timeEntries.stop, {});
    expect(await entry(t, second.entryIds[0] as Id<"timeEntries">)).toMatchObject({ incomplete: true });

    const blocked = await fail(
      owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: [id], grouping: "per_entry" } }),
    );
    expect(reasonOf(blocked)).toBe("time_entry_incomplete");
    // completed → the flag is gone and the entry can be invoiced
    await owner.mutation(api.timeEntries.update, {
      id,
      values: entryForm(p, "2026-10-12", "30m", "Abstimmung Startseite"),
    });
    expect((await entry(t, id)).incomplete).toBeUndefined();
    const r = await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: [id], grouping: "per_entry" },
    });
    expect((await entry(t, id)).status).toBe("in_draft");
    expect((await doc(t, r.id)).status).toBe("draft");
  });

  test("E-PRJ-11 an invoiced entry cannot be edited, deleted or re-flagged (message names the invoice)", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const id = await logEntry(owner, p, "2026-10-01", "2h");
    const r = await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: [id], grouping: "per_entry" },
    });
    const fin = await owner.action(api.invoices.finalize, { id: r.id, version: (await doc(t, r.id)).version });
    await settle(t);
    const text = `Dieser Eintrag wurde mit Rechnung ${fin.number} abgerechnet und kann nicht mehr geändert werden.`;
    const edit = await fail(
      owner.mutation(api.timeEntries.update, { id, values: entryForm(p, "2026-10-01", "1h", "Andere Tätigkeit") }),
    );
    expect(messageOf(edit)).toBe(text);
    expect(reasonOf(edit)).toBe("time_entry_locked");
    const del = await fail(owner.mutation(api.timeEntries.remove, { ids: [id] }));
    expect(messageOf(del)).toBe(text);
    const flag = await fail(owner.mutation(api.timeEntries.setBillableFlag, { ids: [id], billable: false }));
    expect(messageOf(flag)).toBe(text);
    expect(await entry(t, id)).toMatchObject({ status: "invoiced", durationMinutes: 120, billable: true });
  });
});

describe("F11 §5 invoicing edge cases", () => {
  test("E-PRJ-14 appending entries to an invoice draft of another contact is blocked like E-PRJ-12", async () => {
    const t = makeT();
    const { owner, personId, orgId } = await setup(t);
    const p = await project(owner, personId);
    const id = await logEntry(owner, p, "2026-10-01", "1h");
    const other = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(orgId) });
    const e = await fail(
      owner.mutation(api.timeEntries.createInvoice, {
        values: { entryIds: [id], grouping: "per_entry", draftId: other.id },
      }),
    );
    expect(messageOf(e)).toBe("Zeiten verschiedener Kunden können nicht in einer Rechnung abgerechnet werden.");
    expect(reasonOf(e)).toBe("time_entries_contacts");
    expect(await entry(t, id)).toMatchObject({ status: "open" });
    expect(await linesOf(t, other.id as Id<"salesDocuments">)).toHaveLength(1);
    // the same contact's draft accepts them
    const own = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: [id], grouping: "per_entry", draftId: own.id },
    });
    expect(await entry(t, id)).toMatchObject({ status: "in_draft", draftDocumentId: own.id });
  });

  test("E-PRJ-23 a billable entry without any rate (no project, product or default rate) is blocked at invoicing", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const bare = await owner.mutation(api.timeEntries.create, {
      values: { ...emptyTimeEntryForm("2026-10-05"), duration: "1h", description: "Abstimmung", contactId: personId },
    });
    expect(await entry(t, bare.id)).toMatchObject({ hourlyRateMicros: 0, billable: true });
    const preview = await owner.query(api.timeEntries.previewInvoice, {
      values: { entryIds: [bare.id], grouping: "per_entry" },
    });
    expect(preview).toMatchObject({
      ok: false,
      error: { code: "time_entries_rate_missing", message: "Für 1 Einträge ist kein Stundensatz hinterlegt." },
    });
    const e = await fail(
      owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: [bare.id], grouping: "per_entry" } }),
    );
    expect(messageOf(e)).toBe("Für 1 Einträge ist kein Stundensatz hinterlegt.");
    expect((await entry(t, bare.id)).status).toBe("open");
  });

  test("E-PRJ-24 MISC-03 a consumer customer gets gross unit prices on the invoice; the net amount stays the entries' value", async () => {
    const t = makeT();
    const { owner } = await setup(t);
    const consumer = await consumerBuyer(owner);
    const p = await project(owner, consumer);
    const ids = [await logEntry(owner, p, "2026-10-01", "1h"), await logEntry(owner, p, "2026-10-02", "1h")];
    const r = await owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: ids, grouping: "summary" } });
    const d = await doc(t, r.id);
    expect(d.priceMode).toBe("gross");
    const [line] = await linesOf(t, r.id);
    // 90,00 €/h net at 19 % → 107,10 €/h gross on the line
    expect(line).toMatchObject({ unitPriceMicros: 1_071_000, quantityMilli: 2000, unitCode: "HUR" });
    expect(d.totals.netCents).toBe(18_000);
    expect(d.totals.grossCents).toBe(21_420);
  });
});

describe("F11 §5 rule changes and billing modes at invoicing", () => {
  test("E-PRJ-16 EC-025 entries spanning the end of the Kleinunternehmer status are split into two lines with the info", async () => {
    const t = makeT();
    const s = await setupInvoicing(t, { seller: "ku" });
    const { personId } = await b2bBuyer(s.owner);
    await t.model({ actor: s.owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      patchCompanyProfile(
        ctx,
        {
          kleinunternehmer: [
            { validFrom: "2020-01-01", isKU: true },
            { validFrom: "2026-10-05", isKU: false },
          ],
        },
        { action: "settings.company.update" },
      ),
    );
    const p = await project(s.owner, personId);
    const ids = [
      await logEntry(s.owner, p, "2026-10-01", "1h"),
      await logEntry(s.owner, p, "2026-10-02", "1h"),
      await logEntry(s.owner, p, "2026-10-06", "2h"),
    ];
    const preview = await s.owner.query(api.timeEntries.previewInvoice, {
      values: { entryIds: ids, grouping: "summary" },
    });
    expect(preview.ok && preview.plan.notices).toContain(
      "Wegen Änderung der Kleinunternehmerregelung am 05.10.2026 wurden die Zeiten auf zwei Positionen aufgeteilt.",
    );
    const r = await s.owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: ids, grouping: "summary" } });
    expect(r.lines).toBe(2);
    const lines = await linesOf(t, r.id);
    expect(lines.map((l) => [l.linePeriod ?? null, l.quantityMilli, l.timeEntryIds])).toEqual([
      [{ from: "2026-10-01", to: "2026-10-02" }, 2000, ids.slice(0, 2)],
      [null, 2000, ids.slice(2)],
    ]);
  });

  test("E-PRJ-32 invoicing entries of a fixed-price project warns that time is not billed individually", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const fixed = await project(owner, personId, { name: "Festpreis-Shop", billingMode: "fixed" });
    const id = await logEntry(owner, fixed, "2026-10-01", "3h");
    const preview = await owner.query(api.timeEntries.previewInvoice, {
      values: { entryIds: [id], grouping: "summary" },
    });
    expect(preview.ok && preview.plan.notices).toEqual(["Festpreisprojekt – Zeiten werden nicht einzeln abgerechnet."]);
    const r = await owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: [id], grouping: "summary" } });
    expect(r.notices).toContain("Festpreisprojekt – Zeiten werden nicht einzeln abgerechnet.");
    // hourly projects get no such warning
    const hourly = await project(owner, personId);
    const other = await logEntry(owner, hourly, "2026-10-01", "1h");
    const plain = await owner.query(api.timeEntries.previewInvoice, {
      values: { entryIds: [other], grouping: "summary" },
    });
    expect(plain.ok && plain.plan.notices).toEqual([]);
  });
});

describe("F11 §5 project edge cases", () => {
  test("E-PRJ-19 changing the project rate reports the open entries with the old rate; applying it leaves in_draft and invoiced entries untouched", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const open1 = await logEntry(owner, p, "2026-10-01", "1h");
    const open2 = await logEntry(owner, p, "2026-10-02", "1h");
    const drafted = await logEntry(owner, p, "2026-10-03", "1h");
    await owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: [drafted], grouping: "per_entry" } });
    const r = await owner.mutation(api.projects.update, {
      id: p,
      values: projectForm({ contactId: personId, hourlyRate: "100,00" }),
    });
    expect(r).toEqual({ openEntriesWithOldRate: 2 });
    // nothing changes until the owner confirms
    expect((await entry(t, open1)).hourlyRateMicros).toBe(900_000);
    expect(await owner.mutation(api.projects.applyRateToOpenEntries, { id: p })).toEqual({ updated: 2 });
    expect((await entry(t, open1)).hourlyRateMicros).toBe(1_000_000);
    expect((await entry(t, open2)).hourlyRateMicros).toBe(1_000_000);
    expect(await entry(t, drafted)).toMatchObject({ status: "in_draft", hourlyRateMicros: 900_000 });
    // unchanged rate → no question
    expect(
      await owner.mutation(api.projects.update, {
        id: p,
        values: projectForm({ contactId: personId, hourlyRate: "100,00", name: "Website" }),
      }),
    ).toEqual({ openEntriesWithOldRate: 0 });
  });

  test("E-PRJ-20 an amount budget notifies at 80 % and 100 % with the amounts; logging stays allowed beyond 100 %", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId, { budgetKind: "amount", budgetValue: "450,00" });
    await logEntry(owner, p, "2026-10-01", "4h"); // 360,00 € = 80 %
    expect((await notificationsOf(t, "project.budget")).map((n) => n.title)).toEqual([
      "Projekt Website-Relaunch: 80 % des Budgets verbraucht (360,00 € von 450,00 €).",
    ]);
    await logEntry(owner, p, "2026-10-02", "1h"); // 450,00 € = 100 %
    const extra = await owner.mutation(api.timeEntries.create, { values: entryForm(p, "2026-10-03", "2h") });
    expect(extra.id).toBeDefined();
    const titles = (await notificationsOf(t, "project.budget")).map((n) => n.title).sort();
    expect(titles).toEqual([
      "Projekt Website-Relaunch: 100 % des Budgets verbraucht (450,00 € von 450,00 €).",
      "Projekt Website-Relaunch: 80 % des Budgets verbraucht (360,00 € von 450,00 €).",
    ]);
    const [row] = await owner.query(api.projects.list, {});
    expect(row?.budget).toMatchObject({ kind: "amount", consumed: 63_000, level: "exceeded" });
  });

  test("E-PRJ-21 logging to an archived project is blocked on every channel (UI and MCP)", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    await owner.mutation(api.projects.setStatus, { id: p, status: "archived" });
    const ui = await fail(owner.mutation(api.timeEntries.create, { values: entryForm(p, "2026-10-12", "1h") }));
    expect(messageOf(ui)).toBe("Projekt Website-Relaunch ist archiviert.");
    const mcp = await t.asMcp(["time:write", "projects:read"]);
    const viaMcp = await fail(mcp.mutation(api.timeEntries.create, { values: entryForm(p, "2026-10-12", "2h") }));
    expect(messageOf(viaMcp)).toBe("Projekt Website-Relaunch ist archiviert.");
    expect(reasonOf(viaMcp)).toBe("PROJECT_ARCHIVED");
    expect(await t.run((ctx) => ctx.db.query("timeEntries").collect())).toHaveLength(0);
  });

  test("E-PRJ-30 archiving a project with open billable entries warns with count and value; none → no warning", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    await logEntry(owner, p, "2026-10-01", "1:30");
    await logEntry(owner, p, "2026-10-02", "1h");
    await owner.mutation(api.timeEntries.create, {
      values: { ...entryForm(p, "2026-10-02", "3h", "Interne Abstimmung"), billable: false },
    });
    const drafted = await logEntry(owner, p, "2026-10-03", "5h");
    await owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: [drafted], grouping: "per_entry" } });
    const r = await owner.mutation(api.projects.setStatus, { id: p, status: "archived" });
    expect(r.warning).toBe("Es gibt noch 2 nicht abgerechnete Einträge (225,00 €).");
    expect((await t.run((ctx) => ctx.db.get(p)))?.status).toBe("archived");
    const clean = await project(owner, personId, { name: "Leer" });
    expect(await owner.mutation(api.projects.setStatus, { id: clean, status: "archived" })).toEqual({});
  });

  test("E-PRJ-31 projects with entries or documents cannot be deleted (archive instead); unused projects can", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const withDoc = await project(owner, personId, { name: "Mit Rechnung" });
    await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId, { projectId: withDoc }) });
    const e1 = await fail(owner.mutation(api.projects.remove, { id: withDoc }));
    expect(messageOf(e1)).toBe("Projekte mit Zeiten oder Belegen können nur archiviert werden.");
    expect(reasonOf(e1)).toBe("PROJECT_IN_USE");
    const withEntry = await project(owner, personId, { name: "Mit Zeiten" });
    await logEntry(owner, withEntry, "2026-10-01", "1h");
    const e2 = await fail(owner.mutation(api.projects.remove, { id: withEntry }));
    expect(messageOf(e2)).toBe("Projekte mit Zeiten oder Belegen können nur archiviert werden.");
    expect((await owner.mutation(api.projects.setStatus, { id: withEntry, status: "archived" })).warning).toBeDefined();
    const unused = await project(owner, personId, { name: "Leer" });
    await owner.mutation(api.projects.remove, { id: unused });
    expect(await t.run((ctx) => ctx.db.get(unused))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(withDoc))).not.toBeNull();
  });
});

describe("PRJ-021 attribution", () => {
  test("PRJ-021 SEC-02 entries carry the canonical actor and source per channel (user, api-key, mcp, timer, cron)", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const ui = await logEntry(owner, p, "2026-10-01", "1h");
    const key = await t.asApiKey(["time:write", "projects:read"]);
    const viaApi = await key.mutation(api.timeEntries.create, { values: entryForm(p, "2026-10-02", "1h") });
    const mcp = await t.asMcp(["time:write", "projects:read"]);
    const viaMcp = await mcp.mutation(api.timeEntries.create, { values: entryForm(p, "2026-10-03", "1h") });
    await owner.mutation(api.timeEntries.start, { projectId: p, description: "Serverumzug" });
    vi.setSystemTime(new Date(NOW.getTime() + 20 * 60_000));
    const timer = await owner.mutation(api.timeEntries.stop, {});
    await owner.mutation(api.timeEntries.start, { projectId: p, description: "Nachtschicht" });
    vi.setSystemTime(new Date(NOW.getTime() + 25 * 3_600_000));
    expect(await t.mutation(internal.timeEntries.checkTimer, {})).toBe("stopped");

    expect(await entry(t, ui)).toMatchObject({ actor: owner.actor, source: "manual" });
    expect(owner.actor).toMatch(/^user:/);
    expect(await entry(t, viaApi.id)).toMatchObject({ actor: key.actor, source: "api" });
    expect(key.actor).toMatch(/^api-key:/);
    expect(await entry(t, viaMcp.id)).toMatchObject({ actor: mcp.actor, source: "mcp" });
    expect(mcp.actor).toMatch(/^mcp:/);
    expect(await entry(t, timer.entryIds[0] as Id<"timeEntries">)).toMatchObject({
      actor: owner.actor,
      source: "timer",
    });
    const cron = (await t.run((ctx) => ctx.db.query("timeEntries").collect())).find(
      (e) => e.description === "Nachtschicht",
    );
    expect(cron).toMatchObject({ actor: "system:cron.deadlines.notify", source: "timer" });

    // the audit trail attributes every write with the same actor (role for users only)
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    const creates = audit.filter((a) => a.action === "time_entry.create");
    const actorOf = (id: string) => creates.find((a) => a.entity.id === id);
    expect(actorOf(ui)).toMatchObject({ actor: owner.actor, actorRole: "owner", channel: "ui" });
    expect(actorOf(viaApi.id)).toMatchObject({ actor: key.actor, channel: "api" });
    expect(actorOf(viaMcp.id)).toMatchObject({ actor: mcp.actor, channel: "mcp" });
    expect(actorOf(String(cron?._id))).toMatchObject({ actor: "system:cron.deadlines.notify" });
    for (const a of audit) expect(a.actor).toMatch(/^(user|api-key|mcp|system):[^:]/);
  });
});

describe("PRJ-017 time reports", () => {
  test("PRJ-017 the report query groups the period's entries by project with unbilled value and weekly utilisation", async () => {
    const t = makeT();
    const { owner, personId, orgId } = await setup(t);
    const web = await project(owner, personId);
    const shop = await project(owner, orgId, { name: "Shop", hourlyRate: "100,00" });
    await logEntry(owner, web, "2026-10-05", "2h");
    await owner.mutation(api.timeEntries.create, {
      values: { ...entryForm(web, "2026-10-06", "1h", "Interne Abstimmung"), billable: false },
    });
    const billed = await logEntry(owner, shop, "2026-10-07", "3h");
    await owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: [billed], grouping: "summary" } });
    await logEntry(owner, shop, "2026-09-30", "5h"); // before the period
    const r = await owner.query(api.timeEntries.report, { from: "2026-10-01", to: "2026-10-31", groupBy: "project" });
    expect(
      r.rows.map((x) => [
        x.label,
        x.minutes,
        x.billableMinutes,
        x.nonBillableMinutes,
        x.unbilledValueCents,
        x.billedValueCents,
      ]),
    ).toEqual([
      ["Shop", 180, 180, 0, 0, 30_000], // same hours → alphabetical
      ["Website-Relaunch", 180, 120, 60, 18_000, 0],
    ]);
    expect(r.weeks).toEqual([
      { weekStart: "2026-10-05", label: "KW 41/2026", minutes: 360, billableMinutes: 300, utilisationBp: 8333 },
    ]);
    const byCustomer = await owner.query(api.timeEntries.report, {
      from: "2026-09-01",
      to: "2026-10-31",
      groupBy: "customer",
      projectId: shop,
    });
    expect(byCustomer.rows.map((x) => [x.key, x.minutes])).toEqual([[orgId, 480]]);
    const viewer = await t.asUser("viewer");
    const weekly = await viewer.query(api.timeEntries.report, {
      from: "2026-10-01",
      to: "2026-10-31",
      groupBy: "week",
    });
    expect(weekly.rows.map((x) => [x.label, x.minutes])).toEqual([["KW 41/2026", 360]]);
  });
});

describe("time_entry_log (MCP)", () => {
  test("PRJ-021 E-PRJ-22 TST-PRJ-18 an ambiguous project name returns candidates; with the ID the entry is logged as mcp:<keyId> with the budget status", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const relaunch = await project(owner, personId, {
      name: "Website Relaunch",
      budgetKind: "hours",
      budgetValue: "10",
    });
    const care = await project(owner, personId, { name: "Website Wartung" });
    const mcp = await t.asMcp(["time:write"]);
    const e = await fail(
      mcp.mutation(api.timeEntries.log, { project: "Website", duration: "2h", description: "Workshop" }),
    );
    expect(reasonOf(e)).toBe("project_ambiguous");
    expect(messageOf(e)).toBe(
      "Projekt „Website“ ist nicht eindeutig: PRJ-00001 Website Relaunch, PRJ-00002 Website Wartung. Bitte project_id angeben.",
    );
    expect((e as { data: { candidates: unknown } }).data.candidates).toEqual([
      { id: relaunch, number: "PRJ-00001", name: "Website Relaunch" },
      { id: care, number: "PRJ-00002", name: "Website Wartung" },
    ]);
    expect(await t.run((ctx) => ctx.db.query("timeEntries").collect())).toHaveLength(0);

    const r = await mcp.mutation(api.timeEntries.log, { project: relaunch, duration: "2h", description: "Workshop" });
    expect(r.project).toEqual({ id: relaunch, number: "PRJ-00001", name: "Website Relaunch" });
    expect(r.entry).toMatchObject({ date: "2026-10-12", durationMinutes: 120, billable: true, source: "mcp" });
    expect(r.budget).toMatchObject({ kind: "hours", consumed: 120, ratioBp: 2000, label: "2:00 h von 10:00 h" });
    expect(await entry(t, r.id)).toMatchObject({ actor: mcp.actor, source: "mcp", projectId: relaunch });
    expect(mcp.actor).toMatch(/^mcp:/);
    // by number, with an explicit date
    const byNumber = await mcp.mutation(api.timeEntries.log, {
      project: "prj-00002",
      duration: "1:30",
      description: "Updates einspielen",
      date: "2026-10-09",
    });
    expect(byNumber.entry).toMatchObject({ date: "2026-10-09", durationMinutes: 90 });
    const unknown = await fail(
      mcp.mutation(api.timeEntries.log, { project: "Buchhaltung", duration: "1h", description: "Belege" }),
    );
    expect(reasonOf(unknown)).toBe("project_not_found");
  });

  test("E-PRJ-21 time_entry_log to an archived project is blocked", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId, { name: "Altkunde Shop" });
    await owner.mutation(api.projects.setStatus, { id: p, status: "archived" });
    const mcp = await t.asMcp(["time:write"]);
    const e = await fail(
      mcp.mutation(api.timeEntries.log, { project: "Altkunde", duration: "1h", description: "Support" }),
    );
    expect(messageOf(e)).toBe("Projekt Altkunde Shop ist archiviert.");
    expect(reasonOf(e)).toBe("PROJECT_ARCHIVED");
  });
});

describe("RPT-007 revenue by project", () => {
  test("RPT-007 PRJ-002 the revenue report groups finalised invoices by project (number and name)", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const ids = [await logEntry(owner, p, "2026-10-01", "2h")];
    const r = await owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: ids, grouping: "summary" } });
    await owner.action(api.invoices.finalize, { id: r.id, version: (await doc(t, r.id)).version });
    await settle(t);
    const plain = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id: plain.id, version: 1 });
    await settle(t);
    const report = await owner.query(api.reports.revenue, {
      groupBy: "project",
      basis: "document_date",
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(report.groups.map((g) => [g.label, g.netCents, g.documents])).toEqual([
      ["ohne Projekt", 100_000, 1],
      ["PRJ-00001 Website-Relaunch", 18_000, 1],
    ]);
    expect(report.totals.netCents).toBe(118_000);
  });
});

describe("PRJ-018 offline queue", () => {
  const MIN = 60_000;
  const at = (minutes: number) => NOW.getTime() + minutes * MIN;

  test("PRJ-018 queued manual entries and an offline timer run sync with server IDs; a replay applies nothing twice", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    vi.setSystemTime(new Date(at(120)));
    const ops = [
      {
        id: "op-1",
        kind: "manual" as const,
        at: at(5),
        values: entryForm(p, "2026-10-12", "1:30", "Angebot erstellt"),
      },
      {
        id: "op-2",
        kind: "timer_start" as const,
        at: at(10),
        fields: { projectId: p, description: "Zugfahrt Konzept" },
      },
      { id: "op-3", kind: "timer_stop" as const, at: at(55) },
    ];
    const r = await owner.mutation(api.timeEntries.syncOffline, { deviceId: "phone", ops });
    expect(r).toMatchObject({ applied: ["op-1", "op-2", "op-3"], skipped: [], conflict: false });
    expect(r.entryIds).toHaveLength(2);
    const [manual, run] = await Promise.all(r.entryIds.map((id) => entry(t, id)));
    expect(manual).toMatchObject({
      source: "offline",
      durationMinutes: 90,
      offlineOpIds: ["op-1"],
      actor: owner.actor,
    });
    expect(run).toMatchObject({
      source: "offline",
      durationMinutes: 45,
      startedAt: at(10),
      endedAt: at(55),
      offlineOpIds: ["op-2", "op-3"],
    });
    expect(await owner.query(api.timeEntries.timer, {})).toBeNull();
    // the client retries after a lost response → nothing is applied twice
    const again = await owner.mutation(api.timeEntries.syncOffline, { deviceId: "phone", ops });
    expect(again).toMatchObject({ applied: [], skipped: ["op-1", "op-2", "op-3"], entryIds: [] });
    expect(await t.run((ctx) => ctx.db.query("timeEntries").collect())).toHaveLength(2);
  });

  test("PRJ-018 an offline start with no running timer becomes the running timer with its offline start instant", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    vi.setSystemTime(new Date(at(30)));
    await owner.mutation(api.timeEntries.syncOffline, {
      deviceId: "phone",
      ops: [{ id: "op-1", kind: "timer_start", at: at(10), fields: { projectId: p, description: "Vor-Ort-Termin" } }],
    });
    expect(await owner.query(api.timeEntries.timer, {})).toMatchObject({
      startedAt: at(10),
      deviceId: "phone",
      offlineOpId: "op-1",
      projectName: "Website-Relaunch",
    });
    vi.setSystemTime(new Date(at(70)));
    const stopped = await owner.mutation(api.timeEntries.stop, {});
    expect(await entry(t, stopped.entryIds[0] as Id<"timeEntries">)).toMatchObject({
      durationMinutes: 60,
      offlineOpIds: ["op-1"],
    });
  });

  test("E-PRJ-29 TST-PRJ-20 the later offline start wins: the other device's timer is saved flagged „Konflikt“", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    await owner.mutation(api.timeEntries.start, { projectId: p, description: "Desktop-Arbeit", deviceId: "desktop" });
    vi.setSystemTime(new Date(at(40)));
    const r = await owner.mutation(api.timeEntries.syncOffline, {
      deviceId: "phone",
      ops: [{ id: "op-1", kind: "timer_start", at: at(20), fields: { projectId: p, description: "Unterwegs" } }],
    });
    expect(r.conflict).toBe(true);
    expect(r.warnings).toContain("Zeitkonflikt: Ein Timer wurde auf zwei Geräten gestartet.");
    expect(await entry(t, r.entryIds[0] as Id<"timeEntries">)).toMatchObject({
      description: "Desktop-Arbeit",
      durationMinutes: 20,
      conflict: true,
      source: "timer",
    });
    expect(await owner.query(api.timeEntries.timer, {})).toMatchObject({
      startedAt: at(20),
      deviceId: "phone",
      description: "Unterwegs",
    });
    const [n] = await notificationsOf(t, "time_offline_conflict");
    expect(n).toMatchObject({
      title: "Zeitkonflikt: Ein Timer wurde auf zwei Geräten gestartet.",
      severity: "warning",
    });
  });

  test("E-PRJ-29 an earlier offline start loses: the offline run becomes the conflict entry up to the other start", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    await owner.mutation(api.timeEntries.start, { projectId: p, description: "Desktop-Arbeit", deviceId: "desktop" });
    vi.setSystemTime(new Date(at(15)));
    const r = await owner.mutation(api.timeEntries.syncOffline, {
      deviceId: "phone",
      ops: [{ id: "op-1", kind: "timer_start", at: at(-30), fields: { projectId: p, description: "Frühstart" } }],
    });
    expect(r.conflict).toBe(true);
    expect(await entry(t, r.entryIds[0] as Id<"timeEntries">)).toMatchObject({
      description: "Frühstart",
      durationMinutes: 30,
      conflict: true,
      source: "offline",
      startedAt: at(-30),
      endedAt: at(0),
    });
    expect(await owner.query(api.timeEntries.timer, {})).toMatchObject({ deviceId: "desktop", startedAt: at(0) });
  });
});
