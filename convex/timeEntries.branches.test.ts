import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { emptyProjectForm, emptyTimeEntryForm, type ProjectFormValues } from "../src/domain/schemas/projects";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { productForm } from "./catalog.fixtures";
import { b2bBuyer, invoiceValues, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import {
  createEntry,
  createOfflineRunEntry,
  notifyOfflineConflict,
  processedOfflineOps,
  recordTimesheet,
  runUnbilledTimeDeadlines,
  stopTimer,
  updateOpenEntryRates,
} from "./model/timeEntries";
import { makeT, type TestT } from "./test.setup";

/**
 * Branch coverage of the F11 time tracking functions (convex/timeEntries.ts, convex/model/timeEntries.ts): list
 * filters, guards and optional fields of entries, the timer, offline replay, timesheet input and the UST-01 monitor.
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
const ownerCtx = (owner: Owner) => ({ actor: owner.actor, role: "owner", channel: "ui" }) as const;

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
const notificationsOf = (t: TestT, kind: string) =>
  t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.kind === kind));
const at = (minutes: number) => NOW.getTime() + minutes * 60_000;

describe("PRJ-007 entries: list filters, labels and guards", () => {
  test("PRJ-016 PRJ-007 list filters by contact, status, billable flag and date range; labels name project, contact, product and document", async () => {
    const t = makeT();
    const { owner, personId, orgId } = await setup(t);
    const product = await owner.mutation(api.products.create, {
      values: productForm("Beratung Webdesign", { type: "service", unitCode: "HUR", price: "80,00" }),
    });
    const p = await project(owner, personId);
    const a = await logEntry(owner, p, "2026-10-01", "1h");
    const b = await owner.mutation(api.timeEntries.create, {
      values: { ...entryForm(p, "2026-10-05", "2h", "Abstimmung Texte"), billable: false, productId: product.id },
    });
    // an entry with only a contact (no project) and one with neither (incomplete)
    const c = await owner.mutation(api.timeEntries.create, {
      values: { ...emptyTimeEntryForm("2026-10-07"), duration: "30m", description: "Telefonat Shop", contactId: orgId },
    });
    const bare = await owner.mutation(api.timeEntries.create, {
      values: { ...emptyTimeEntryForm("2026-10-08"), duration: "15m", description: "Recherche Hosting" },
    });
    expect(bare.warnings).toContain("Bitte Beschreibung und Projekt oder Kunde ergänzen.");

    const byContact = await owner.query(api.timeEntries.list, { contactId: orgId });
    expect(byContact.map((e) => e._id)).toEqual([c.id]);
    expect(byContact[0]).toMatchObject({ projectName: null, contactName: expect.any(String), productName: null });

    const open = await owner.query(api.timeEntries.list, { status: "open", billable: false });
    expect(open.map((e) => e._id)).toEqual([b.id]);
    expect(open[0]).toMatchObject({ productName: "Beratung Webdesign", projectName: "Website-Relaunch" });

    const ranged = await owner.query(api.timeEntries.list, { from: "2026-10-02", to: "2026-10-07" });
    expect(ranged.map((e) => e._id)).toEqual([c.id, b.id]);
    const all = await owner.query(api.timeEntries.list, {});
    expect(all.map((e) => e._id)).toEqual([bare.id, c.id, b.id, a]);
    const bareRow = all[0];
    expect(bareRow).toMatchObject({ projectName: null, contactName: null, productName: null, document: null });

    // project + contact filter combined (contact mismatch filters everything out)
    expect(await owner.query(api.timeEntries.list, { projectId: p, contactId: orgId })).toEqual([]);

    // the document of an entry in a draft is labelled „no number yet“
    const inv = await owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: [a], grouping: "summary" } });
    const labelled = await owner.query(api.timeEntries.get, { id: a });
    expect(labelled?.document).toEqual({ _id: inv.id, number: null });
    expect(labelled?.valueCents).toBe(9000);
  });

  test("PRJ-007 get returns null for a deleted entry; update and delete of an unknown entry fail with „Zeiteintrag nicht gefunden.“", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const id = await logEntry(owner, p, "2026-10-01", "1h");
    expect(await owner.mutation(api.timeEntries.remove, { ids: [id] })).toEqual({ deleted: 1 });
    expect(await owner.query(api.timeEntries.get, { id })).toBeNull();
    const upd = await fail(owner.mutation(api.timeEntries.update, { id, values: entryForm(p, "2026-10-01", "2h") }));
    expect(errorCode(upd)).toBe("not_found");
    expect(messageOf(upd)).toBe("Zeiteintrag nicht gefunden.");
    const del = await fail(owner.mutation(api.timeEntries.remove, { ids: [id] }));
    expect(errorCode(del)).toBe("not_found");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((a) => a.action === "time_entry.delete" && a.entity.id === id)).toBeDefined();
  });

  test("E-PRJ-04 E-PRJ-07 start/end entries store the instants; end before start is blocked; overlapping entries only warn", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const span = (startTime: string, endTime: string, description = "Workshop Startseite") => ({
      ...entryForm(p, "2026-10-01", "", description),
      mode: "start_end" as const,
      startTime,
      endTime,
    });
    const first = await owner.mutation(api.timeEntries.create, { values: span("09:00", "11:00") });
    expect(first.warnings).toEqual([]);
    const e = await entry(t, first.id);
    expect(e).toMatchObject({ durationMinutes: 120, date: "2026-10-01" });
    expect(e.endedAt).toBe((e.startedAt ?? 0) + 120 * 60_000);
    const overlap = await owner.mutation(api.timeEntries.create, {
      values: span("10:00", "12:00", "Abstimmung Texte"),
    });
    expect(overlap.warnings).toContain("Diese Zeit überschneidet sich mit 1 anderen Einträgen.");
    const bad = await fail(owner.mutation(api.timeEntries.create, { values: span("11:00", "09:00") }));
    expect(errorCode(bad)).toBe("invalid_input");
    expect(reasonOf(bad)).toBe("end_before_start");
    expect(messageOf(bad)).toBe("Das Ende liegt vor dem Beginn.");
    // editing the overlapping entry to a free slot: no warning (the entry itself is not counted)
    const moved = await owner.mutation(api.timeEntries.update, {
      id: overlap.id,
      values: span("13:00", "14:00", "Abstimmung Texte"),
    });
    expect(moved.warnings).toEqual([]);
  });

  test("PRJ-007 E-PRJ-05 E-PRJ-06 the model refuses invalid dates, future dates, out-of-range durations and end before start", async () => {
    const t = makeT();
    const { owner } = await setup(t);
    const base = { durationMinutes: 60, description: "Konzeption Startseite", source: "api" as const };
    const cases: [Record<string, unknown>, string, string | undefined][] = [
      [{ date: "2026-02-30" }, "Ungültiges Datum.", undefined],
      [{ date: "2026-10-13" }, "Zeiten können nicht für die Zukunft erfasst werden.", "date_future"],
      [
        { date: "2026-10-01", durationMinutes: 0 },
        "Die Dauer muss zwischen 1 Minute und 24 Stunden liegen.",
        undefined,
      ],
      [{ date: "2026-10-01", startedAt: at(60), endedAt: at(0) }, "Das Ende liegt vor dem Beginn.", "end_before_start"],
    ];
    for (const [over, message, reason] of cases) {
      const e = await fail(t.model(ownerCtx(owner), (ctx) => createEntry(ctx, { ...base, ...over } as never)));
      expect(errorCode(e)).toBe("invalid_input");
      expect(messageOf(e)).toBe(message);
      if (reason) expect(reasonOf(e)).toBe(reason);
    }
    expect(await t.run((ctx) => ctx.db.query("timeEntries").collect())).toEqual([]);
  });

  test("PRJ-008 unknown project, contact or product references are refused with field errors", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const gone = await project(owner, personId, { name: "Weg" });
    await owner.mutation(api.projects.remove, { id: gone });
    const cases: [Record<string, string>, string][] = [
      [{ projectId: gone }, "Projekt nicht gefunden."],
      [{ projectId: "kein-projekt" }, "Projekt nicht gefunden."],
      [{ projectId: p, contactId: "kein-kontakt" }, "Unbekannter Kontakt."],
      [{ projectId: p, productId: "kein-produkt" }, "Unbekanntes Produkt."],
      [{ projectId: p, productId: String(p) }, "Unbekanntes Produkt."],
    ];
    for (const [over, message] of cases) {
      const e = await fail(
        owner.mutation(api.timeEntries.create, { values: { ...entryForm(p, "2026-10-01", "1h"), ...over } }),
      );
      expect(errorCode(e)).toBe("invalid_input");
      expect(messageOf(e)).toBe(message);
    }
  });

  test("PRJ-008 E-PRJ-19 updating an entry re-resolves the rate when its references change; an override wins; billable is kept", async () => {
    const t = makeT();
    const { owner, personId, orgId } = await setup(t);
    const p = await project(owner, personId);
    const cheap = await project(owner, orgId, { name: "Shop", hourlyRate: "60,00" });
    const id = await owner.mutation(api.timeEntries.create, {
      values: { ...entryForm(p, "2026-10-01", "1h"), billable: false },
    });
    expect((await entry(t, id.id)).hourlyRateMicros).toBe(900_000);
    // project changes → the new project's rate; billable taken from the form
    await owner.mutation(api.timeEntries.update, { id: id.id, values: entryForm(cheap, "2026-10-01", "1h") });
    expect(await entry(t, id.id)).toMatchObject({ projectId: cheap, contactId: orgId, hourlyRateMicros: 600_000 });
    // same references, explicit rate
    await owner.mutation(api.timeEntries.update, {
      id: id.id,
      values: { ...entryForm(cheap, "2026-10-01", "1h"), rate: "75,00" },
    });
    expect((await entry(t, id.id)).hourlyRateMicros).toBe(750_000);
    // same references, no rate → the stored rate stays
    await owner.mutation(api.timeEntries.update, { id: id.id, values: entryForm(cheap, "2026-10-01", "2h") });
    expect(await entry(t, id.id)).toMatchObject({ hourlyRateMicros: 750_000, durationMinutes: 120 });
    // clearing project and contact → flagged incomplete
    const r = await owner.mutation(api.timeEntries.update, {
      id: id.id,
      values: { ...emptyTimeEntryForm("2026-10-01"), duration: "2h", description: "Konzeption Startseite" },
    });
    expect(r.warnings).toEqual([]);
    expect(await entry(t, id.id)).toMatchObject({ incomplete: true, hourlyRateMicros: 0 });
  });

  test("E-PRJ-21 an entry already on an archived project can still be edited while it keeps that project", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const id = await logEntry(owner, p, "2026-10-01", "1h");
    await owner.mutation(api.projects.setStatus, { id: p, status: "archived" });
    await owner.mutation(api.timeEntries.update, { id, values: entryForm(p, "2026-10-01", "90m", "Workshop Texte") });
    expect(await entry(t, id)).toMatchObject({ durationMinutes: 90, description: "Workshop Texte" });
    const other = await project(owner, personId, { name: "Neu" });
    const moved = await logEntry(owner, other, "2026-10-01", "1h");
    const e = await fail(
      owner.mutation(api.timeEntries.update, { id: moved, values: entryForm(p, "2026-10-01", "1h") }),
    );
    expect(reasonOf(e)).toBe("PROJECT_ARCHIVED");
  });

  test("PRJ-007 setBillableFlag skips entries that already have the flag; E-PRJ-19 projects without a rate update nothing", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const a = await logEntry(owner, p, "2026-10-01", "1h");
    const b = await logEntry(owner, p, "2026-10-02", "1h");
    expect(await owner.mutation(api.timeEntries.setBillableFlag, { ids: [a, b], billable: true })).toEqual({
      updated: 0,
    });
    expect(await owner.mutation(api.timeEntries.setBillableFlag, { ids: [a], billable: false })).toEqual({
      updated: 1,
    });
    const noRate = await project(owner, personId, { name: "Ohne Satz", hourlyRate: "" });
    await logEntry(owner, noRate, "2026-10-01", "1h");
    expect(await owner.mutation(api.projects.applyRateToOpenEntries, { id: noRate })).toEqual({ updated: 0 });
    expect(await t.model(ownerCtx(owner), (ctx) => updateOpenEntryRates(ctx, noRate))).toBe(0);
  });
});

describe("PRJ-005 timer branches", () => {
  test("PRJ-005 the timer keeps contact, product and billable; editing it while running; stopping without a timer is refused", async () => {
    const t = makeT();
    const { owner, personId, orgId } = await setup(t);
    const product = await owner.mutation(api.products.create, {
      values: productForm("Beratung Webdesign", { type: "service", unitCode: "HUR", price: "80,00" }),
    });
    const noTimer = await fail(owner.mutation(api.timeEntries.stop, {}));
    expect(reasonOf(noTimer)).toBe("TIMER_NOT_RUNNING");
    expect(messageOf(noTimer)).toBe("Es läuft kein Timer.");
    const noEdit = await fail(owner.mutation(api.timeEntries.updateRunning, { description: "x" }));
    expect(reasonOf(noEdit)).toBe("TIMER_NOT_RUNNING");
    // discarding without a timer is a no-op
    expect(await owner.mutation(api.timeEntries.discard, {})).toBeNull();

    await owner.mutation(api.timeEntries.start, {
      contactId: personId,
      productId: product.id,
      billable: false,
      description: "  ",
    });
    const running = await owner.query(api.timeEntries.timer, {});
    expect(running).toMatchObject({ contactId: personId, productId: product.id, billable: false, projectName: null });
    expect(running?.description).toBeUndefined();

    // E-PRJ-01 without a project: the confirm text has no project name
    vi.setSystemTime(new Date(at(5)));
    const again = await fail(owner.mutation(api.timeEntries.start, {}));
    expect(reasonOf(again)).toBe("TIMER_RUNNING");

    // edit while running: switch to the organisation, drop the product, keep billable
    await owner.mutation(api.timeEntries.updateRunning, { contactId: orgId, description: " Telefonat Shop " });
    const edited = await owner.query(api.timeEntries.timer, {});
    expect(edited).toMatchObject({ contactId: orgId, description: "Telefonat Shop", billable: false });
    expect(edited?.productId).toBeUndefined();
    await owner.mutation(api.timeEntries.updateRunning, { billable: true });
    const cleared = await owner.query(api.timeEntries.timer, {});
    expect(cleared).toMatchObject({ billable: true });
    expect(cleared?.contactId).toBeUndefined();
    expect(cleared?.description).toBeUndefined();

    await owner.mutation(api.timeEntries.updateRunning, { contactId: orgId, productId: product.id });
    vi.setSystemTime(new Date(at(30)));
    const stopped = await owner.mutation(api.timeEntries.stop, { description: "Telefonat Shop", billable: false });
    const e = await entry(t, stopped.entryIds[0] as Id<"timeEntries">);
    expect(e).toMatchObject({
      contactId: orgId,
      productId: product.id,
      billable: false,
      durationMinutes: 30,
      source: "timer",
      hourlyRateMicros: 800_000,
    });
  });

  test("PRJ-005 a timer stopped within the first minute writes no entry; E-PRJ-03 a stop after > 24 h is capped and flagged", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    await owner.mutation(api.timeEntries.start, { projectId: p, description: "Kurz" });
    vi.setSystemTime(new Date(NOW.getTime() + 20_000));
    expect(await owner.mutation(api.timeEntries.stop, {})).toEqual({ entryIds: [], warnings: [] });
    expect(await owner.query(api.timeEntries.timer, {})).toBeNull();

    await owner.mutation(api.timeEntries.start, { projectId: p, description: "Serverumzug" });
    vi.setSystemTime(new Date(NOW.getTime() + 20_000 + 30 * 3_600_000));
    const r = await owner.mutation(api.timeEntries.stop, {});
    expect(r.warnings).toContain("Timer lief über 24 Stunden und wurde angehalten. Bitte Dauer prüfen.");
    expect(await entry(t, r.entryIds[0] as Id<"timeEntries">)).toMatchObject({
      durationMinutes: 1440,
      flaggedForReview: true,
    });
  });

  test("E-PRJ-03 checkTimer returns none without a timer, for another timer's schedule and before 10 h", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    expect(await t.mutation(internal.timeEntries.checkTimer, {})).toBe("none");
    await owner.mutation(api.timeEntries.start, { projectId: p, description: "Serverumzug" });
    const first = await owner.query(api.timeEntries.timer, {});
    await owner.mutation(api.timeEntries.discard, {});
    await owner.mutation(api.timeEntries.start, { projectId: p, description: "Zweiter Lauf" });
    // the job scheduled for the discarded timer finds another timer → none
    expect(await t.mutation(internal.timeEntries.checkTimer, { timerId: first?._id })).toBe("none");
    expect(await t.mutation(internal.timeEntries.checkTimer, {})).toBe("none");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((a) => a.action === "timer.discard")?.entity.label).toBe("Serverumzug");
  });

  test("E-PRJ-03 an auto-stopped timer with no description is discarded under the label „Timer“ in the audit trail", async () => {
    const t = makeT();
    const { owner } = await setup(t);
    await owner.mutation(api.timeEntries.start, {});
    await owner.mutation(api.timeEntries.discard, {});
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((a) => a.action === "timer.start")?.entity.label).toBe("Timer");
    expect(audit.find((a) => a.action === "timer.discard")?.entity.label).toBe("Timer");
  });

  test("PRJ-005 stopTimer with explicit fields and offline op ids (model) writes them on every entry", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    await owner.mutation(api.timeEntries.start, { projectId: p, description: "Vor-Ort" });
    vi.setSystemTime(new Date(at(40)));
    const r = await t.model(ownerCtx(owner), (ctx) =>
      stopTimer(ctx, { endedAt: at(30), source: "offline", conflict: true, offlineOpIds: ["op-9"] }),
    );
    expect(await entry(t, r.entryIds[0] as Id<"timeEntries">)).toMatchObject({
      durationMinutes: 30,
      source: "offline",
      conflict: true,
      offlineOpIds: ["op-9"],
    });
  });
});

describe("PRJ-018 offline replay branches", () => {
  test("PRJ-018 more than 500 queued operations are refused; an empty queue applies nothing", async () => {
    const t = makeT();
    const { owner } = await setup(t);
    const ops = Array.from({ length: 501 }, (_, i) => ({ id: `op-${i}`, kind: "timer_stop" as const, at: at(0) }));
    const e = await fail(owner.mutation(api.timeEntries.syncOffline, { deviceId: "phone", ops }));
    expect(errorCode(e)).toBe("invalid_input");
    expect(messageOf(e)).toBe("Zu viele Offline-Einträge in einem Abgleich.");
    expect(await owner.mutation(api.timeEntries.syncOffline, { deviceId: "phone", ops: [] })).toEqual({
      applied: [],
      skipped: [],
      entryIds: [],
      conflict: false,
      warnings: [],
    });
    expect(await t.run(async (ctx) => [...(await processedOfflineOps(ctx, []))])).toEqual([]);
  });

  test("PRJ-018 a manual op dated days before the sync is recognised as applied on replay (its own date is searched)", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const ops = [{ id: "op-old", kind: "manual" as const, at: at(-5), values: entryForm(p, "2026-10-01", "1h") }];
    const first = await owner.mutation(api.timeEntries.syncOffline, { deviceId: "phone", ops });
    expect(first.entryIds).toHaveLength(1);
    const again = await owner.mutation(api.timeEntries.syncOffline, { deviceId: "phone", ops });
    expect(again).toMatchObject({ applied: [], skipped: ["op-old"] });
  });

  test("PRJ-018 an offline start while the same device's timer runs replaces it; the running timer's op counts as applied", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    vi.setSystemTime(new Date(at(30)));
    await owner.mutation(api.timeEntries.syncOffline, {
      deviceId: "phone",
      ops: [{ id: "op-1", kind: "timer_start", at: at(10), fields: { projectId: p, description: "Zugfahrt" } }],
    });
    const replay = await owner.mutation(api.timeEntries.syncOffline, {
      deviceId: "phone",
      ops: [{ id: "op-1", kind: "timer_start", at: at(10), fields: { projectId: p, description: "Zugfahrt" } }],
    });
    expect(replay).toMatchObject({ applied: [], skipped: ["op-1"] });
    const done = await t.run(async (ctx) => [
      ...(await processedOfflineOps(ctx, [{ id: "x", at: at(0), date: "kein-datum" }])),
    ]);
    expect(done).toEqual(["op-1"]);
  });

  test("E-PRJ-29 offline run entries: capped at 24 h and flagged, shorter than a minute skipped, optional fields kept", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const long = await t.model(ownerCtx(owner), (ctx) =>
      createOfflineRunEntry(ctx, {
        projectId: p,
        contactId: personId,
        billable: false,
        startedAt: at(-30 * 60),
        endedAt: at(0),
        conflict: false,
        opId: "op-long",
      }),
    );
    expect(long).not.toBeNull();
    const e = await entry(t, long?.id as Id<"timeEntries">);
    expect(e).toMatchObject({
      durationMinutes: 1440,
      flaggedForReview: true,
      billable: false,
      contactId: personId,
      description: "",
      incomplete: true,
      source: "offline",
    });
    expect(e.conflict).toBeUndefined();
    const short = await t.model(ownerCtx(owner), (ctx) =>
      createOfflineRunEntry(ctx, { startedAt: at(0), endedAt: at(0) + 10_000, conflict: true, opId: "op-short" }),
    );
    expect(short).toBeNull();
  });

  test("E-PRJ-29 the conflict notification without entries is keyed by time", async () => {
    const t = makeT();
    const { owner } = await setup(t);
    await t.model(ownerCtx(owner), (ctx) => notifyOfflineConflict(ctx, []));
    const [n] = await notificationsOf(t, "time_offline_conflict");
    expect(n?.dedupeKey).toBe(`time_offline_conflict:${NOW.getTime()}`);
    expect(n?.entity).toBeUndefined();
  });
});

describe("PRJ-012 draft locks and PRJ-014 timesheet branches", () => {
  test("PRJ-012 a draft line referencing an unknown entry is refused; entries of another customer cannot be put into the draft", async () => {
    const t = makeT();
    const { owner, personId, orgId } = await setup(t);
    const p = await project(owner, personId);
    const shop = await project(owner, orgId, { name: "Shop" });
    const mine = await logEntry(owner, p, "2026-10-01", "1h");
    const foreign = await logEntry(owner, shop, "2026-10-01", "1h");
    const gone = await logEntry(owner, p, "2026-10-02", "1h");
    await owner.mutation(api.timeEntries.remove, { ids: [gone] });
    const draft = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { supplyDate: { kind: "date", date: "2026-10-01" } as never }),
    });
    const lineWith = (ids: string[]) => ({
      kind: "item" as const,
      productType: "service" as const,
      name: "Beratung",
      quantityMilli: 1000,
      unitCode: "HUR",
      unitPriceMicros: 900_000,
      vatRateKey: "standard",
      timeEntryIds: ids,
    });
    const unknown = await fail(
      owner.mutation(api.invoices.updateDraft, {
        id: draft.id,
        version: 1,
        values: invoiceValues(personId, { lines: [lineWith([gone])] }),
      }),
    );
    expect(reasonOf(unknown)).toBe("TIME_ENTRY_UNKNOWN");
    expect(messageOf(unknown)).toBe("Ein Zeiteintrag der Position existiert nicht mehr.");
    const other = await fail(
      owner.mutation(api.invoices.updateDraft, {
        id: draft.id,
        version: 1,
        values: invoiceValues(personId, { lines: [lineWith([foreign])] }),
      }),
    );
    expect(reasonOf(other)).toBe("time_entries_contacts");
    // the own entry is locked into the draft (supply date covers it)
    await owner.mutation(api.invoices.updateDraft, {
      id: draft.id,
      version: 1,
      values: invoiceValues(personId, {
        supplyDate: { kind: "date", date: "2026-10-01" } as never,
        lines: [lineWith([mine])],
      }),
    });
    expect(await entry(t, mine)).toMatchObject({ status: "in_draft", draftDocumentId: draft.id });
    const drafts = await owner.query(api.timeEntries.draftsOfContact, { contactId: personId });
    expect(drafts).toEqual([{ _id: draft.id, subject: null, netCents: expect.any(Number), version: 2 }]);
    expect(await owner.query(api.timeEntries.draftsOfContact, { contactId: orgId })).toEqual([]);
  });

  test("PRJ-014 timesheetInput is null for drafts, invoices without the option and invoices without invoiced entries", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const id = await logEntry(owner, p, "2026-10-01", "1h");
    const inv = await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: [id], grouping: "summary", attachTimesheet: true },
    });
    expect(await t.query(internal.timeEntries.timesheetInput, { documentId: inv.id })).toBeNull();
    const plain = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id: plain.id, version: 1 });
    expect(await t.query(internal.timeEntries.timesheetInput, { documentId: plain.id })).toBeNull();
    // with the option but without entries
    await t.run(async (ctx) => ctx.db.patch(plain.id, { attachTimesheet: true }));
    expect(await t.query(internal.timeEntries.timesheetInput, { documentId: plain.id })).toBeNull();
    await t.run(async (ctx) => ctx.db.patch(plain.id, { attachTimesheet: undefined })); // restore (RI-15 replay)
  });

  test("PRJ-014 timesheetInput without a project: customer name from the billing address, no project label", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const a = await owner.mutation(api.timeEntries.create, {
      values: {
        ...emptyTimeEntryForm("2026-10-01"),
        duration: "50m",
        description: "Abstimmung",
        contactId: personId,
        rate: "60,00",
      },
    });
    const inv = await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: [a.id], grouping: "summary", attachTimesheet: true },
    });
    const version = (await t.run((ctx) => ctx.db.get(inv.id)))?.version ?? 1;
    const fin = await owner.action(api.invoices.finalize, { id: inv.id, version });
    const input = await t.query(internal.timeEntries.timesheetInput, { documentId: inv.id });
    expect(input).toMatchObject({ invoiceNumber: fin.number, artifactsReady: false, sellerName: expect.any(String) });
    expect(input?.customerName).not.toBe("");
    expect(input && "projectLabel" in input).toBe(false);
    expect(input?.entries).toEqual([
      {
        date: "2026-10-01",
        description: "Abstimmung",
        durationMinutes: 50,
        roundedMinutes: 50,
        hourlyRateMicros: 600_000,
      },
    ]);
  });

  test("PRJ-014 a second rendered timesheet is dropped (file deleted); the first is archived once", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const id = await logEntry(owner, p, "2026-10-01", "1h");
    const inv = await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: [id], grouping: "summary" },
    });
    const version = (await t.run((ctx) => ctx.db.get(inv.id)))?.version ?? 1;
    await owner.action(api.invoices.finalize, { id: inv.id, version });
    const bytes = new TextEncoder().encode("%PDF-1.4 timesheet");
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
    const store = () => t.run((ctx) => ctx.storage.store(new Blob([bytes], { type: "application/pdf" })));
    const file = async (storageId: Id<"_storage">) => ({ storageId, sha256, bytes: bytes.length, name: "x.pdf" });
    const first = await store();
    const a = await t
      .asSystem("documents.pipeline")
      .model((ctx) => file(first).then((f) => recordTimesheet(ctx, inv.id, f)));
    expect(a).not.toBeNull();
    const second = await store();
    const b = await t.mutation(internal.timeEntries.storeTimesheet, { documentId: inv.id, ...(await file(second)) });
    expect(b).toBeNull();
    expect(await t.run(async (ctx) => (await ctx.storage.get(second)) === null)).toBe(true);
    expect(await t.run(async (ctx) => (await ctx.storage.get(first)) === null)).toBe(false);
  });
});

describe("E-PRJ-25 reopen and PRJ-015 UST-01 branches", () => {
  test("E-PRJ-25 only entries of cancelled invoices can be reopened; offers list only cancelled invoices", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const id = await logEntry(owner, p, "2026-10-01", "1h");
    const inv = await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: [id], grouping: "summary" },
    });
    const e = await fail(owner.mutation(api.timeEntries.reopen, { invoiceId: inv.id }));
    expect(errorCode(e)).toBe("conflict");
    expect(reasonOf(e)).toBe("invoice_not_cancelled");
    expect(messageOf(e)).toBe("Nur Zeiten stornierter Rechnungen können wieder abrechenbar werden.");
    const version = (await t.run((ctx) => ctx.db.get(inv.id)))?.version ?? 1;
    await owner.action(api.invoices.finalize, { id: inv.id, version });
    expect(await owner.query(api.timeEntries.reopenOffers, {})).toEqual([]);
    await owner.mutation(api.corrections.cancel, { id: inv.id, reason: "Falscher Kunde" });
    await owner.mutation(api.timeEntries.reopen, { invoiceId: inv.id });
    expect((await notificationsOf(t, "time_reopen_offer"))[0]?.resolvedAt).toBe(NOW.getTime());
    // a second reopen finds nothing to do and leaves the resolved offer alone
    expect(await owner.mutation(api.timeEntries.reopen, { invoiceId: inv.id })).toEqual({ reopened: 0 });
  });

  test("PRJ-015 E-PRJ-26 the UST-01 to-do is updated when the count changes, kept when unchanged and resolved when none are left", async () => {
    const t = makeT();
    const { owner, orgId } = await setup(t);
    const p = await project(owner, orgId);
    const old = await logEntry(owner, p, "2026-04-01", "1h");
    // an entry without a customer is treated conservatively like a business customer (six-month duty)
    const internalEntry = await owner.mutation(api.timeEntries.create, {
      values: { ...emptyTimeEntryForm("2026-04-01"), duration: "1h", description: "Interne Doku" },
    });
    const run = () => t.asSystem("cron.deadlines.notify").model((ctx) => runUnbilledTimeDeadlines(ctx));
    expect(await run()).toEqual({ warning: 0, escalation: 2 });
    expect(await run()).toEqual({ warning: 0, escalation: 2 });
    expect(await notificationsOf(t, "time_ust01_escalation")).toHaveLength(1);
    await owner.mutation(api.timeEntries.setBillableFlag, { ids: [old], billable: false });
    expect(await run()).toEqual({ warning: 0, escalation: 1 });
    const [updated] = await notificationsOf(t, "time_ust01_escalation");
    expect(updated?.title).toContain("1 ");
    await owner.mutation(api.timeEntries.setBillableFlag, { ids: [internalEntry.id], billable: false });
    expect(await run()).toEqual({ warning: 0, escalation: 0 });
    const [esc] = await notificationsOf(t, "time_ust01_escalation");
    expect(esc?.resolvedAt).toBe(NOW.getTime());
  });
});

describe("PRJ-017 report branches", () => {
  test("PRJ-017 an invalid or reversed period is refused", async () => {
    const t = makeT();
    const { owner } = await setup(t);
    for (const [from, to] of [
      ["2026-13-01", "2026-12-31"],
      ["2026-10-01", "x"],
      ["2026-10-31", "2026-10-01"],
    ] as const) {
      const e = await fail(owner.query(api.timeEntries.report, { from, to, groupBy: "month" }));
      expect(errorCode(e)).toBe("invalid_input");
      expect(messageOf(e)).toBe("Bitte einen gültigen Zeitraum wählen.");
    }
  });

  test("PRJ-017 grouping by customer and product names contacts, products and entries without them", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const product = await owner.mutation(api.products.create, {
      values: productForm("Beratung Webdesign", { type: "service", unitCode: "HUR", price: "80,00" }),
    });
    const p = await project(owner, personId);
    await owner.mutation(api.timeEntries.create, {
      values: { ...entryForm(p, "2026-10-01", "1h"), productId: product.id },
    });
    await owner.mutation(api.timeEntries.create, {
      values: { ...entryForm(p, "2026-10-02", "2h"), productId: product.id },
    });
    await owner.mutation(api.timeEntries.create, {
      values: { ...emptyTimeEntryForm("2026-10-03"), duration: "30m", description: "Interne Doku" },
    });
    const byProduct = await owner.query(api.timeEntries.report, {
      from: "2026-10-01",
      to: "2026-10-31",
      groupBy: "product",
    });
    const byCustomer = await owner.query(api.timeEntries.report, {
      from: "2026-10-01",
      to: "2026-10-31",
      groupBy: "customer",
    });
    const scoped = await owner.query(api.timeEntries.report, {
      from: "2026-10-01",
      to: "2026-10-31",
      groupBy: "project",
      projectId: p,
    });
    const json = JSON.stringify([byProduct, byCustomer]);
    expect(json).toContain("Beratung Webdesign");
    expect(json).toContain("Max Beispiel");
    expect(JSON.stringify(scoped)).toContain("Website-Relaunch");
    expect(JSON.stringify(scoped)).not.toContain("Interne Doku");
  });
});

describe("PRJ-021 log via MCP branches", () => {
  test("PRJ-021 time_entry_log defaults the date to today and billable from the project; a product id is passed through", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const product = await owner.mutation(api.products.create, {
      values: productForm("Beratung Webdesign", { type: "service", unitCode: "HUR", price: "80,00" }),
    });
    const p = await project(owner, personId, { name: "Intern", billingMode: "non_billable" });
    const r = await owner.mutation(api.timeEntries.log, {
      project: "Intern",
      duration: "1,5",
      description: "Teammeeting Planung",
      productId: product.id,
    });
    expect(r.entry).toMatchObject({ date: "2026-10-12", durationMinutes: 90, billable: false, source: "manual" });
    expect(r.project).toMatchObject({ id: p, name: "Intern" });
    expect(r.budget).toBeNull();
    expect((await entry(t, r.id)).productId).toBe(product.id);
  });
});
