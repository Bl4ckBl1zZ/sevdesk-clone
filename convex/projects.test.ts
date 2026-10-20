import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { emptyProjectForm, emptyTimeEntryForm, type ProjectFormValues } from "../src/domain/schemas/projects";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { productForm } from "./catalog.fixtures";
import { b2bBuyer, consumerBuyer, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";

/**
 * F11 projects and time tracking (PRJ-001…019): projects, entries, the timer, invoicing from entries with entry
 * locking, budget alerts, profitability and the UST-01 monitor.
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

describe("PRJ-001 projects", () => {
  test("PRJ-001 SET-064 projects get numbers from their own range (created on first use); E-PRJ-31 used projects can only be archived", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const a = await owner.mutation(api.projects.create, { values: projectForm({ contactId: personId }) });
    expect(a.number).toBe("PRJ-00001");
    const b = await owner.mutation(api.projects.create, { values: projectForm({ name: "Wartung" }) });
    expect(b.number).toBe("PRJ-00002");
    const p = await t.run((ctx) => ctx.db.get(a.id));
    expect(p).toMatchObject({ status: "active", billingMode: "hourly", hourlyRateMicros: 900_000, currency: "EUR" });
    expect(p?.budgetAlerts).toEqual([{ thresholdBp: 8000 }, { thresholdBp: 10000 }]);
    // unused → deletable; used → archive only
    await owner.mutation(api.projects.remove, { id: b.id });
    await logEntry(owner, a.id, "2026-10-12", "1h");
    const e = await fail(owner.mutation(api.projects.remove, { id: a.id }));
    expect(messageOf(e)).toBe("Projekte mit Zeiten oder Belegen können nur archiviert werden.");
    const archived = await owner.mutation(api.projects.setStatus, { id: a.id, status: "archived" });
    expect(archived.warning).toBe("Es gibt noch 1 nicht abgerechnete Einträge (90,00 €).");
    // E-PRJ-21: no more logging to an archived project
    const blocked = await fail(owner.mutation(api.timeEntries.create, { values: entryForm(a.id, "2026-10-12", "1h") }));
    expect(messageOf(blocked)).toBe("Projekt Website-Relaunch ist archiviert.");
    const list = await owner.query(api.projects.list, { status: "archived" });
    expect(list.map((r) => r.number)).toEqual(["PRJ-00001"]);
  });
});

describe("PRJ-005…008 entries and timer", () => {
  test("PRJ-007 PRJ-008 TST-PRJ-05 manual entries resolve the rate: override → project → customer price → product → default", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const product = await owner.mutation(api.products.create, {
      values: productForm("Beratung Webdesign", { type: "service", unitCode: "HUR", price: "80,00" }),
    });
    const withRate = await project(owner, personId);
    const noRate = await project(owner, personId, { name: "Intern", hourlyRate: "", defaultProductId: product.id });
    const rateOf = async (id: Id<"timeEntries">) => (await entry(t, id)).hourlyRateMicros;
    expect(await rateOf(await logEntry(owner, withRate, "2026-10-12", "1:30"))).toBe(900_000);
    const override = await owner.mutation(api.timeEntries.create, {
      values: { ...entryForm(withRate, "2026-10-12", "1h"), rate: "120,00" },
    });
    expect(await rateOf(override.id)).toBe(1_200_000);
    expect(await rateOf(await logEntry(owner, noRate, "2026-10-12", "1h"))).toBe(800_000);
    await owner.mutation(api.products.saveCustomerPrice, {
      productId: product.id,
      values: { contactId: personId, price: "70,00", priceMode: "net", validFrom: "" },
    });
    expect(await rateOf(await logEntry(owner, noRate, "2026-10-12", "1h"))).toBe(700_000);
    // nothing at all → 0 („kein Stundensatz“, blocked at invoicing)
    const bare = await owner.mutation(api.timeEntries.create, {
      values: { ...emptyTimeEntryForm("2026-10-12"), duration: "1h", description: "Abstimmung", contactId: personId },
    });
    expect(await rateOf(bare.id)).toBe(0);
    // E-PRJ-06 future, E-PRJ-08 unparseable, E-PRJ-09 generic warning
    const future = await fail(
      owner.mutation(api.timeEntries.create, { values: entryForm(withRate, "2026-10-13", "1h") }),
    );
    expect(messageOf(future)).toBe("Zeiten können nicht für die Zukunft erfasst werden.");
    const bad = await fail(
      owner.mutation(api.timeEntries.create, { values: entryForm(withRate, "2026-10-12", "lang") }),
    );
    expect(messageOf(bad)).toBe("Dauer nicht erkannt. Beispiele: 1:30, 1,5, 90m, 2h 15m.");
    const generic = await owner.mutation(api.timeEntries.create, {
      values: entryForm(withRate, "2026-10-12", "1h", "Arbeit"),
    });
    expect(generic.warnings).toContain("Die Beschreibung ist sehr allgemein und erscheint so auf der Rechnung.");
    const e = await entry(t, generic.id);
    expect(e).toMatchObject({ source: "manual", status: "open", billable: true, retentionClass: "none" });
    expect(e.actor).toBe(owner.actor);
  });

  test("PRJ-005 PRJ-006 TST-PRJ-01/02 one server-side timer: start on one device, stop on another; a second start needs confirmation", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    await owner.mutation(api.timeEntries.start, {
      projectId: p,
      description: "Workshop-Vorbereitung",
      deviceId: "phone",
    });
    expect(await owner.query(api.timeEntries.timer, {})).toMatchObject({
      projectName: "Website-Relaunch",
      deviceId: "phone",
    });
    vi.setSystemTime(new Date(NOW.getTime() + 45 * 60_000));
    const e = await fail(owner.mutation(api.timeEntries.start, { description: "Anderes" }));
    expect(reasonOf(e)).toBe("TIMER_RUNNING");
    expect(messageOf(e)).toBe(
      "Es läuft bereits ein Timer (Website-Relaunch, 0:45 h). Stoppen und neuen Timer starten?",
    );
    const r = await owner.mutation(api.timeEntries.start, { description: "Telefonat", confirmStop: true });
    expect(r.stoppedEntryIds).toHaveLength(1);
    const first = await entry(t, r.stoppedEntryIds[0] as Id<"timeEntries">);
    expect(first).toMatchObject({ durationMinutes: 45, date: "2026-10-12", source: "timer", projectId: p });
    // the second timer has no project/contact → stopped as „unvollständig“ (E-PRJ-02)
    vi.setSystemTime(new Date(NOW.getTime() + 60 * 60_000));
    const stopped = await owner.mutation(api.timeEntries.stop, {});
    expect(stopped.warnings).toContain("Bitte Beschreibung und Projekt oder Kunde ergänzen.");
    expect(await entry(t, stopped.entryIds[0] as Id<"timeEntries">)).toMatchObject({
      durationMinutes: 15,
      incomplete: true,
    });
    expect(await owner.query(api.timeEntries.timer, {})).toBeNull();
    // discard writes no entry
    await owner.mutation(api.timeEntries.start, { description: "Versehen" });
    await owner.mutation(api.timeEntries.discard, {});
    expect(await t.run((ctx) => ctx.db.query("timeEntries").collect())).toHaveLength(2);
  });

  test("PRJ-005 E-PRJ-03 the timer warns after 10 h and stops itself at 24 h, flagging the entry for review", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    await owner.mutation(api.timeEntries.start, { projectId: p, description: "Serverumzug" });
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 3_600_000));
    expect(await t.mutation(internal.timeEntries.checkTimer, {})).toBe("warned");
    expect(await t.mutation(internal.timeEntries.checkTimer, {})).toBe("none");
    expect((await notificationsOf(t, "timer.long")).map((n) => n.title)).toEqual(["Timer läuft seit 10 Stunden"]);
    vi.setSystemTime(new Date(NOW.getTime() + 30 * 3_600_000));
    expect(await t.mutation(internal.timeEntries.checkTimer, {})).toBe("stopped");
    const [e] = await t.run((ctx) => ctx.db.query("timeEntries").collect());
    expect(e).toMatchObject({ durationMinutes: 1440, flaggedForReview: true, actor: "system:cron.deadlines.notify" });
  });
});

describe("PRJ-010…013 invoicing from time entries", () => {
  test("PRJ-010 PRJ-012 TST-PRJ-07/09 per_product_rate → one HUR line; entries in_draft and locked; removing the line or deleting the draft releases them", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const ids = [
      await logEntry(owner, p, "2026-10-01", "30m"),
      await logEntry(owner, p, "2026-10-02", "45m"),
      await logEntry(owner, p, "2026-10-05", "15m"),
    ];
    const preview = await owner.query(api.timeEntries.previewInvoice, {
      values: { entryIds: ids, grouping: "per_product_rate" },
    });
    expect(preview.ok && preview.plan.lines[0]?.quantityMilli).toBe(1500);
    const r = await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: ids, grouping: "per_product_rate" },
    });
    const d = await doc(t, r.id);
    expect(d).toMatchObject({ status: "draft", type: "invoice", contactId: personId, projectId: p });
    expect(d.supplyDate).toEqual({ kind: "period", from: "2026-10-01", to: "2026-10-05" });
    const [line] = await linesOf(t, r.id);
    expect(line).toMatchObject({ quantityMilli: 1500, unitCode: "HUR", unitPriceMicros: 900_000, timeEntryIds: ids });
    for (const id of ids) expect(await entry(t, id)).toMatchObject({ status: "in_draft", draftDocumentId: r.id });
    // E-PRJ-10: locked while in the draft; not selectable for another invoice
    const locked = await fail(
      owner.mutation(api.timeEntries.update, {
        id: ids[0] as Id<"timeEntries">,
        values: entryForm(p, "2026-10-01", "1h"),
      }),
    );
    expect(messageOf(locked)).toBe(
      "Dieser Eintrag ist in Rechnungsentwurf Entwurf enthalten. Entfernen Sie ihn dort zuerst.",
    );
    const again = await fail(
      owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: ids, grouping: "summary" } }),
    );
    expect(reasonOf(again)).toBe("time_entry_locked");
    const selectable = await owner.query(api.timeEntries.list, { forInvoicing: true });
    expect(selectable).toHaveLength(0);
    // the owner removes the line → entries back to open (the editor saves the remaining lines)
    const values = await owner.query(api.invoices.get, { id: r.id });
    const draft = (values as { values: Record<string, unknown> }).values;
    await owner.mutation(api.invoices.updateDraft, {
      id: r.id,
      version: d.version,
      values: {
        ...draft,
        lines: [
          {
            kind: "item",
            name: "Pauschale Hosting",
            quantityMilli: 1000,
            unitCode: "C62",
            unitPriceMicros: 100_000,
            vatRateKey: "standard",
            productType: "service",
          },
        ],
      },
    });
    for (const id of ids) expect((await entry(t, id)).status).toBe("open");
    // append to the existing draft, then delete the draft → open again
    const appended = await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: ids.slice(0, 2), grouping: "per_entry", draftId: r.id },
    });
    expect(appended.id).toBe(r.id);
    expect((await linesOf(t, r.id)).map((l) => l.name)).toEqual([
      "Pauschale Hosting",
      "01.10.2026: Konzeption Startseite",
      "02.10.2026: Konzeption Startseite",
    ]);
    expect((await entry(t, ids[0] as Id<"timeEntries">)).status).toBe("in_draft");
    await owner.mutation(api.invoices.deleteDraft, { id: r.id });
    for (const id of ids) {
      const e = await entry(t, id);
      expect(e.status).toBe("open");
      expect(e.draftDocumentId).toBeUndefined();
    }
  });

  test("PRJ-013 UST-08 E-PRJ-18 the supply period may be widened but not narrowed below the billed entries", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const ids = [await logEntry(owner, p, "2026-09-03", "1h"), await logEntry(owner, p, "2026-09-28", "1h")];
    const r = await owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: ids, grouping: "summary" } });
    const d = await doc(t, r.id);
    const values = ((await owner.query(api.invoices.get, { id: r.id })) as { values: Record<string, unknown> }).values;
    const narrow = await fail(
      owner.mutation(api.invoices.updateDraft, {
        id: r.id,
        version: d.version,
        values: { ...values, supplyDate: { kind: "period", from: "2026-09-10", to: "2026-09-28" } },
      }),
    );
    expect(messageOf(narrow)).toBe(
      "Der Leistungszeitraum muss alle abgerechneten Zeiten umfassen (03.09.2026–28.09.2026).",
    );
    await owner.mutation(api.invoices.updateDraft, {
      id: r.id,
      version: d.version,
      values: { ...values, supplyDate: { kind: "month", month: "2026-09" } },
    });
    expect((await doc(t, r.id)).supplyDate).toEqual({ kind: "month", month: "2026-09" });
  });

  test("PRJ-012 PRJ-019 GOBD-06 TST-PRJ-10/11/21 finalising locks the entries with the invoice retention; the Storno offers them again", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const ids = [await logEntry(owner, p, "2026-10-01", "2h"), await logEntry(owner, p, "2026-10-02", "1:30")];
    const r = await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: ids, grouping: "per_entry", rounding: { incrementMinutes: 15, mode: "up" } },
    });
    const fin = await owner.action(api.invoices.finalize, { id: r.id, version: (await doc(t, r.id)).version });
    await settle(t);
    const d = await doc(t, r.id);
    const lines = await linesOf(t, r.id);
    for (const [i, id] of ids.entries()) {
      expect(await entry(t, id)).toMatchObject({
        status: "invoiced",
        invoicedLineId: lines[i]?._id,
        invoicedDocumentId: r.id,
        retentionClass: "vouchers8",
        retentionUntil: d.retentionUntil,
        roundedMinutes: [120, 90][i],
      });
      expect((await entry(t, id)).lockedAt).toBeTypeOf("number");
    }
    expect(lines[0]?.timeRounding).toEqual({ incrementMinutes: 15, mode: "up", perGroup: false });
    // E-PRJ-11: frozen
    const e = await fail(owner.mutation(api.timeEntries.remove, { ids: [ids[0] as Id<"timeEntries">] }));
    expect(messageOf(e)).toBe(
      `Dieser Eintrag wurde mit Rechnung ${fin.number} abgerechnet und kann nicht mehr geändert werden.`,
    );
    const direct = await fail(
      t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
        ctx.db.patch(ids[0] as Id<"timeEntries">, { durationMinutes: 1 }),
      ),
    );
    expect(errorCode(direct)).toBe("immutable_record");
    // Storno → offer (E-PRJ-25) → „wieder abrechenbar“
    await owner.mutation(api.corrections.cancel, { id: r.id, reason: "Falscher Kunde" });
    const offers = await owner.query(api.timeEntries.reopenOffers, {});
    expect(offers).toEqual([{ invoiceId: r.id, number: fin.number, count: 2 }]);
    const [offer] = await notificationsOf(t, "time_reopen_offer");
    expect(offer?.title).toBe(
      `Die Rechnung ${fin.number} wurde storniert. 2 Zeiteinträge wieder als abrechenbar markieren?`,
    );
    expect(await owner.mutation(api.timeEntries.reopen, { invoiceId: r.id })).toEqual({ reopened: 2 });
    const reopened = await entry(t, ids[0] as Id<"timeEntries">);
    expect(reopened).toMatchObject({
      status: "open",
      invoicedLineHistory: [lines[0]?._id],
      retentionUntil: d.retentionUntil,
    });
    expect(reopened.invoicedLineId).toBeUndefined();
    expect(await owner.query(api.timeEntries.reopenOffers, {})).toEqual([]);
    // the retention of the cancelled invoice still protects the entry from deletion (RI-20)
    const del = await fail(owner.mutation(api.timeEntries.remove, { ids: [ids[0] as Id<"timeEntries">] }));
    expect(errorCode(del)).toBeDefined();
  });

  test("PRJ-016 E-PRJ-12 non-billable entries are not offered by default; entries of two customers are refused", async () => {
    const t = makeT();
    const { owner, personId, orgId } = await setup(t);
    const p = await project(owner, personId);
    const other = await project(owner, orgId, { name: "Shop" });
    const billable = await logEntry(owner, p, "2026-10-01", "1h");
    const internalEntry = await owner.mutation(api.timeEntries.create, {
      values: { ...entryForm(p, "2026-10-01", "1h", "Interne Abstimmung"), billable: false },
    });
    const ids = (await owner.query(api.timeEntries.list, { forInvoicing: true })).map((e) => e._id);
    expect(ids).toEqual([billable]);
    const all = await owner.query(api.timeEntries.list, { forInvoicing: true, includeNonBillable: true });
    expect(all.map((e) => e._id).sort()).toEqual([billable, internalEntry.id].sort());
    const foreign = await logEntry(owner, other, "2026-10-01", "1h");
    const e = await fail(
      owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: [billable, foreign], grouping: "summary" } }),
    );
    expect(messageOf(e)).toBe("Zeiten verschiedener Kunden können nicht in einer Rechnung abgerechnet werden.");
  });
});

describe("PRJ-002…004, PRJ-015 project monitoring", () => {
  test("PRJ-003 TST-PRJ-16 a 10 h budget notifies once at 8 h and once at 10 h", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId, { budgetKind: "hours", budgetValue: "10" });
    await logEntry(owner, p, "2026-10-01", "6h");
    expect(await notificationsOf(t, "project.budget")).toHaveLength(0);
    await logEntry(owner, p, "2026-10-02", "2h");
    await logEntry(owner, p, "2026-10-03", "1h");
    await logEntry(owner, p, "2026-10-04", "1h");
    await logEntry(owner, p, "2026-10-05", "1h");
    const titles = (await notificationsOf(t, "project.budget")).map((n) => n.title).sort();
    expect(titles).toEqual([
      "Projekt Website-Relaunch: 100 % des Budgets verbraucht (10:00 h von 10:00 h).",
      "Projekt Website-Relaunch: 80 % des Budgets verbraucht (8:00 h von 10:00 h).",
    ]);
    const list = await owner.query(api.projects.list, {});
    expect(list[0]?.budget).toMatchObject({ level: "exceeded", ratioBp: 11_000 });
  });

  test("PRJ-002 PRJ-004 the project page lists documents and vouchers; profitability from finalised documents and time cost", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId, { internalCostRate: "30,00" });
    const ids = [await logEntry(owner, p, "2026-10-01", "2h")];
    const r = await owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: ids, grouping: "summary" } });
    await owner.action(api.invoices.finalize, { id: r.id, version: (await doc(t, r.id)).version });
    await settle(t);
    const page = await owner.query(api.projects.get, { id: p });
    expect(page?.documents.map((d) => [d.typeLabel, d.netCents])).toEqual([["Rechnung", 18_000]]);
    expect(page?.profitability).toMatchObject({
      revenueCents: 18_000,
      timeCostCents: 6_000,
      marginCents: 12_000,
      marginBp: 6667,
    });
    const cash = await owner.query(api.projects.profitability, { id: p, basis: "cash" });
    expect(cash.revenueCents).toBe(0); // nothing paid yet
  });

  test("PRJ-015 UST-01 EC-026 deadlines.notify warns about billable entries older than 150 days", async () => {
    const t = makeT();
    const { owner } = await setup(t);
    const consumer = await consumerBuyer(owner);
    const p = await project(owner, consumer);
    await logEntry(owner, p, "2026-05-10", "1h"); // 155 days
    await logEntry(owner, p, "2026-04-01", "1h"); // 194 days, consumer → warning only (no six-month duty)
    await logEntry(owner, p, "2026-10-01", "1h");
    await t.mutation(internal.invoices.notifyDeadlinesCron, { force: true });
    const [warning] = await notificationsOf(t, "time_ust01_warning");
    expect(warning?.title).toBe(
      "2 abrechenbare Zeiteinträge sind älter als 150 Tage. Rechnungen müssen spätestens 6 Monate nach der Leistung gestellt werden (§ 14 Abs. 2 UStG).",
    );
    expect(await notificationsOf(t, "time_ust01_escalation")).toHaveLength(0);
    expect(await owner.query(api.timeEntries.unbilled, {})).toMatchObject({ openCount: 3, warning: 2, escalation: 0 });
  });

  test("PRJ-015 escalation for business customers after 180 days", async () => {
    const t = makeT();
    const { owner, orgId } = await setup(t);
    const p = await project(owner, orgId);
    await logEntry(owner, p, "2026-04-01", "1h");
    await t.mutation(internal.invoices.notifyDeadlinesCron, { force: true });
    const [esc] = await notificationsOf(t, "time_ust01_escalation");
    expect(esc).toMatchObject({ severity: "error" });
    expect(esc?.title).toContain("Rechnungsfrist überschritten");
  });
});
