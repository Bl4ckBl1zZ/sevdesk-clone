import { afterEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import type { RecurringTemplateValues } from "../src/domain/schemas/recurring";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { b2bBuyer, INVOICE_RANGE, settle, setupInvoicing } from "./invoices.fixtures";
import { auditedPatch } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";

/** F04 §3.4 recurring invoices (REC-01…16) and 10 EC-DOC-92…96 against convex-test. */

afterEach(() => {
  vi.useRealTimers();
});

/** Fake "now" (Europe/Berlin 10:00 in winter time). */
function at(date: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${date}T09:00:00Z`));
}

function templateValues(contactId: string, over: Partial<RecurringTemplateValues> = {}): RecurringTemplateValues {
  return {
    name: "Wartungsvertrag Beispiel",
    draft: {
      type: "invoice",
      contactId,
      currency: "EUR",
      priceMode: "net",
      paymentTerms: { dueDays: 14 },
      showEpcQr: true,
      language: "de",
      headText: "Vielen Dank für Ihr Vertrauen.",
      lines: [
        {
          kind: "item",
          productType: "service",
          name: "Wartungspauschale",
          quantityMilli: 1000,
          unitCode: "C62",
          unitPriceMicros: 5_000_000,
          vatRateKey: "standard",
        },
      ],
    },
    schedule: { interval: "P1M", firstDate: "2026-11-01", billing: "in_advance", periodTextEnabled: true },
    automation: { finalize: false },
    ...over,
  };
}

async function setup(t: TestT) {
  const s = await setupInvoicing(t);
  const { personId, orgId } = await b2bBuyer(s.owner);
  return { ...s, personId, orgId };
}

const runCron = (t: TestT) => t.action(internal.recurring.generateCron, { force: true });

async function docsOf(t: TestT, id: Id<"recurringTemplates">) {
  return t.run((ctx) =>
    ctx.db
      .query("salesDocuments")
      .withIndex("by_recurringOccurrence", (q) => q.eq("recurringOccurrence.templateId", id))
      .collect(),
  );
}

async function openTodos(t: TestT) {
  return t.run(async (ctx) =>
    (await ctx.db.query("notifications").collect()).filter((n) => n.resolvedAt === undefined),
  );
}

describe("REC-01/04/09 generation", () => {
  test("REC-01 REC-04 REC-09 ER-04 T-REC-001 monthly in advance from 01.11.2026: one invoice 01.11.–30.11., BT-12, period line", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, {
      values: templateValues(personId, { automation: { finalize: true } }),
      confirmAutomation: true,
    });
    expect(await runCron(t)).toMatchObject({ templates: 1, created: 1, finalized: 1 });
    await settle(t);
    const [doc] = await docsOf(t, id);
    expect(doc?.status).toBe("finalized");
    expect(doc?.number).toBe("RE-2026-0001");
    expect(doc?.supplyDate).toEqual({ kind: "period", from: "2026-11-01", to: "2026-11-30" });
    expect(doc?.recurringTemplateId).toBe(id);
    const detail = await owner.query(api.invoices.get, { id: doc?._id as Id<"salesDocuments"> });
    const snap = detail?.snapshot as DocumentSnapshot;
    expect(snap.references.contractReference).toBe("Wartungsvertrag Beispiel");
    expect(snap.texts.headText).toContain("Berechnung für den Zeitraum vom 01.11.2026 bis 30.11.2026");
    expect(snap.documentDate).toBe("2026-11-01");
    const tpl = await owner.query(api.recurring.get, { id });
    expect(tpl).toMatchObject({ generatedCount: 1, nextDate: "2026-12-01", state: "active" });
    expect(tpl?.documents).toHaveLength(1);
  });

  test("REC-03 T-REC-003 maxCount = 3: the 3rd invoice ends the template („Beendet“)", async () => {
    at("2027-01-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const values = templateValues(personId, {
      schedule: {
        interval: "P1M",
        firstDate: "2026-11-01",
        maxCount: 3,
        billing: "in_advance",
        periodTextEnabled: false,
      },
    });
    const { id } = await owner.mutation(api.recurring.create, { values });
    await runCron(t);
    expect(await docsOf(t, id)).toHaveLength(3);
    const tpl = await owner.query(api.recurring.get, { id });
    expect(tpl).toMatchObject({ state: "ended", generatedCount: 3, nextDate: null });
    expect((await owner.query(api.recurring.list, { tab: "ended" })).rows.map((r) => r._id)).toEqual([id]);
    await expect(owner.action(api.recurring.runNow, { id })).rejects.toThrow(/beendet/);
  });
});

describe("REC-05/06 idempotency and catch-up", () => {
  test("REC-05 EC-DOC-93 T-EC-093 the job executed twice the same day creates one invoice per occurrence", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    await runCron(t);
    await runCron(t);
    await t.action(internal.recurring.generateTemplate, { id });
    expect(await docsOf(t, id)).toHaveLength(1);
    expect((await owner.query(api.recurring.get, { id }))?.generatedCount).toBe(1);
  });

  test("REC-06 EC-DOC-92 T-EC-092 weekly + 20-day outage: 3 invoices auto-finalised with today's date, each with its period", async () => {
    at("2026-11-16");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, {
      values: templateValues(personId, {
        schedule: { interval: "P7D", firstDate: "2026-11-02", billing: "in_advance", periodTextEnabled: false },
        automation: { finalize: true },
      }),
      confirmAutomation: true,
    });
    expect(await runCron(t)).toMatchObject({ created: 3, finalized: 3 });
    await settle(t);
    const docs = (await docsOf(t, id)).sort((a, b) => (a.number ?? "").localeCompare(b.number ?? ""));
    expect(docs.map((d) => d.status)).toEqual(["finalized", "finalized", "finalized"]);
    expect(docs.map((d) => d.documentDate)).toEqual(["2026-11-16", "2026-11-16", "2026-11-16"]);
    expect(docs.map((d) => (d.supplyDate?.kind === "period" ? d.supplyDate.from : null))).toEqual([
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
    ]);
  });

  test("REC-06 EC-DOC-92 T-EC-092 a 30-day outage (> catchUpAutoMax): all drafts without automation + notification", async () => {
    at("2026-12-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, {
      values: templateValues(personId, {
        schedule: { interval: "P7D", firstDate: "2026-11-02", billing: "in_advance", periodTextEnabled: false },
        automation: { finalize: true },
      }),
      confirmAutomation: true,
    });
    expect(await runCron(t)).toMatchObject({ created: 5, finalized: 0 });
    const docs = await docsOf(t, id);
    expect(docs.every((d) => d.status === "draft")).toBe(true);
    const todos = await openTodos(t);
    expect(todos.filter((n) => n.kind === "recurring_catch_up")).toHaveLength(1);
    expect(todos.filter((n) => n.kind === "review_recurring_draft")).toHaveLength(5);
  });
});

describe("REC-07/16 automation and to-dos", () => {
  test("REC-16 REC-07 MAIL-02 T-REC-012 auto-finalised as system:cron.recurring.generate, never sent; mark sent closes the to-do", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, {
      values: templateValues(personId, { automation: { finalize: true } }),
      confirmAutomation: true,
    });
    await runCron(t);
    await settle(t);
    const [doc] = await docsOf(t, id);
    const docId = doc?._id as Id<"salesDocuments">;
    expect(doc?.finalizedBy).toBe("system:cron.recurring.generate");
    expect(doc?.status).toBe("finalized");
    expect(doc?.firstExportedAt).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("sendLog").collect())).toEqual([]);
    let todos = await openTodos(t);
    expect(todos.map((n) => n.kind)).toContain("export_and_send");
    expect(todos.find((n) => n.kind === "export_and_send")?.title).toBe(
      `Exportieren und versenden: RE-2026-0001 (${doc?.contactName})`,
    );
    expect(todos.some((n) => n.kind === "review_recurring_draft")).toBe(false);
    // the owner exports and marks it as sent → the to-do closes
    const detail = await owner.query(api.invoices.get, { id: docId });
    const artifactIds = (detail?.artifacts ?? []).filter((a) => a.kind !== "pdf").map((a) => a._id as string);
    await owner.mutation(api.invoices.markSent, {
      id: docId,
      values: { sentOn: "2026-11-01", channel: "email_manual", artifactIds },
    });
    todos = await openTodos(t);
    expect(todos.some((n) => n.kind === "export_and_send")).toBe(false);
  });

  test("REC-16 T-REC-012 without automation: a draft and the to-do „Entwurf prüfen und fertigstellen“; finalising it opens „Exportieren und versenden“", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    await runCron(t);
    const [doc] = await docsOf(t, id);
    expect(doc?.status).toBe("draft");
    expect(doc?.documentDate).toBeUndefined();
    expect((await openTodos(t)).find((n) => n.kind === "review_recurring_draft")?.title).toBe(
      "Entwurf prüfen und fertigstellen: Wartungsvertrag Beispiel (01.11.2026–30.11.2026)",
    );
    await owner.action(api.invoices.finalize, { id: doc?._id as Id<"salesDocuments">, version: doc?.version ?? 1 });
    await settle(t);
    const kinds = (await openTodos(t)).map((n) => n.kind);
    expect(kinds).toContain("export_and_send");
    expect(kinds).not.toContain("review_recurring_draft");
  });

  test("REC-16 INV-10 the Storno of an auto-finalised invoice closes „Exportieren und versenden“", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    await owner.mutation(api.settings.saveNumberRanges, {
      values: { ranges: [{ ...INVOICE_RANGE }] },
    });
    const { id } = await owner.mutation(api.recurring.create, {
      values: templateValues(personId, { automation: { finalize: true } }),
      confirmAutomation: true,
    });
    await runCron(t);
    await settle(t);
    const [doc] = await docsOf(t, id);
    await owner.mutation(api.corrections.cancel, {
      id: doc?._id as Id<"salesDocuments">,
      reason: "Vertrag beendet",
    } as never);
    expect((await openTodos(t)).some((n) => n.kind === "export_and_send")).toBe(false);
  });

  test("REC-07 ER-10 T-REC-005 auto-finalise with a missing company phone (E format): draft remains + seller_contact_missing", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, {
      values: templateValues(personId, { automation: { finalize: true } }),
      confirmAutomation: true,
    });
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, async (ctx) => {
      const p = await ctx.db.query("companyProfile").first();
      await patchCompanyProfile(
        ctx,
        { contact: { ...(p?.contact as { name: string; email: string; phone: string }), phone: "" } },
        { action: "settings.company.update" },
      );
    });
    expect(await runCron(t)).toMatchObject({ created: 1, finalized: 0 });
    const [doc] = await docsOf(t, id);
    expect(doc?.status).toBe("draft");
    expect(doc?.number).toBeUndefined();
    const failed = (await openTodos(t)).find((n) => n.kind === "recurring_finalize_failed");
    expect(failed?.body).toContain("Kontaktangaben des Unternehmens");
    expect(failed?.body).toContain("validation_failed");
  });

  test("REC-14 automation without the UI confirmation stays inactive (draft only)", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, {
      values: templateValues(personId, { automation: { finalize: true } }),
    });
    expect(await owner.query(api.recurring.get, { id })).toMatchObject({
      automationConfirmed: false,
      automationEffective: false,
    });
    expect(await runCron(t)).toMatchObject({ created: 1, finalized: 0 });
    await owner.mutation(api.recurring.confirmAutomation, { id });
    expect((await owner.query(api.recurring.get, { id }))?.automationEffective).toBe(true);
  });

  test("REC-14 SEC-02 T-REC-011 an API key without invoices:finalize cannot enable automation; with it the automation waits for the UI", async () => {
    at("2026-11-01");
    const t = makeT();
    const { personId } = await setup(t);
    const noScope = await t.asApiKey(["documents:write", "documents:read"]);
    await expect(
      noScope.mutation(api.recurring.create, { values: templateValues(personId, { automation: { finalize: true } }) }),
    ).rejects.toThrow(/invoices:finalize/);
    const withScope = await t.asApiKey(["documents:write", "documents:read", "invoices:finalize"]);
    const { id } = await withScope.mutation(api.recurring.create, {
      values: templateValues(personId, { automation: { finalize: true } }),
      confirmAutomation: true,
    });
    const tpl = await withScope.query(api.recurring.get, { id });
    expect(tpl).toMatchObject({ automationConfirmed: false, automationEffective: false });
    await expect(withScope.mutation(api.recurring.confirmAutomation, { id })).rejects.toThrow();
    await expect(
      withScope.mutation(api.recurring.create, {
        values: { ...templateValues(personId), automation: { finalize: true, send: true } },
      }),
    ).rejects.toThrow(/invalid_input|Unbekannt|unrecognized|Ungültig/i);
  });
});

describe("REC-10/11/12 pause, edit, run now", () => {
  test("REC-10 T-REC-007 paused with 2 past occurrences, resumed with catch_up false: nextDate = first future occurrence, skip audited", async () => {
    at("2026-12-15");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    await owner.mutation(api.recurring.pause, { id });
    expect(await runCron(t)).toMatchObject({ templates: 0 });
    const r = await owner.mutation(api.recurring.resume, { id, catchUp: false });
    expect(r.skipped).toEqual(["2026-11-01", "2026-12-01"]);
    const tpl = await owner.query(api.recurring.get, { id });
    expect(tpl).toMatchObject({
      nextDate: "2027-01-01",
      state: "active",
      skippedOccurrences: ["2026-11-01", "2026-12-01"],
    });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((a) => a.action === "recurring.skip" && a.reason?.includes("01.11.2026"))).toBe(true);
    await runCron(t);
    expect(await docsOf(t, id)).toHaveLength(0);
  });

  test("REC-10 resumed with catch_up true: the missed periods are generated right away (REC-06 rules)", async () => {
    at("2026-12-15");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    await owner.mutation(api.recurring.pause, { id });
    const r = await owner.mutation(api.recurring.resume, { id, catchUp: true });
    expect(r.due).toBe(2);
    await settle(t);
    expect(await docsOf(t, id)).toHaveLength(2);
  });

  test("REC-11 GOBD-06 T-REC-008 editing a template after 2 invoices leaves them unchanged; the anchor is fixed", async () => {
    at("2026-12-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const values = templateValues(personId);
    const { id } = await owner.mutation(api.recurring.create, { values });
    await runCron(t);
    const before = await docsOf(t, id);
    expect(before).toHaveLength(2);
    const tpl = await owner.query(api.recurring.get, { id });
    const changed = {
      ...values,
      draft: { ...values.draft, lines: [{ ...values.draft.lines[0], unitPriceMicros: 9_000_000 } as never] },
    };
    await owner.mutation(api.recurring.update, { id, version: tpl?.version ?? 1, values: changed });
    const after = await docsOf(t, id);
    expect(after.map((d) => d.totals.netCents)).toEqual(before.map((d) => d.totals.netCents));
    expect(after.map((d) => d.totals.netCents)).toEqual([50_000, 50_000]);
    const v2 = (await owner.query(api.recurring.get, { id }))?.version ?? 1;
    await expect(
      owner.mutation(api.recurring.update, {
        id,
        version: v2,
        values: { ...changed, schedule: { ...changed.schedule, interval: "P3M" } },
      }),
    ).rejects.toThrow(/fest/);
    // the next occurrence uses the new price
    await owner.action(api.recurring.runNow, { id });
    const third = (await docsOf(t, id)).find((d) => d.recurringOccurrence?.date === "2027-01-01");
    expect(third?.totals.netCents).toBe(90_000);
  });

  test("REC-12 T-REC-009 „Jetzt erzeugen“ generates the next occurrence and advances nextDate", async () => {
    at("2026-10-20");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    const r = await owner.action(api.recurring.runNow, { id });
    expect(r.created).toBe(1);
    const [doc] = await docsOf(t, id);
    expect(doc?.recurringOccurrence?.date).toBe("2026-11-01");
    expect((await owner.query(api.recurring.get, { id }))?.nextDate).toBe("2026-12-01");
    // the job on 01.11. does not generate the same occurrence again
    at("2026-11-01");
    await runCron(t);
    expect(await docsOf(t, id)).toHaveLength(1);
  });

  test("REC-01 delete only while nothing was generated, archive afterwards", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const a = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    expect(await owner.mutation(api.recurring.remove, { id: a.id })).toEqual({ result: "deleted" });
    const b = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    await runCron(t);
    expect(await owner.mutation(api.recurring.remove, { id: b.id })).toEqual({ result: "archived" });
    expect((await owner.query(api.recurring.list, {})).rows).toEqual([]);
    expect(await docsOf(t, b.id)).toHaveLength(1);
  });
});

describe("REC-13/15 preview and boundaries", () => {
  test("REC-13 ER-03 T-REC-010 12 occurrences with periods, amounts, rates and the ER-03 decision", async () => {
    at("2026-10-20");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    const rows = await owner.query(api.recurring.occurrences, { id });
    expect(rows).toHaveLength(12);
    expect(rows?.[0]).toMatchObject({
      date: "2026-11-01",
      period: { from: "2026-11-01", to: "2026-11-30" },
      netCents: 50_000,
      grossCents: 59_500,
      rates: [{ category: "S", rateBp: 1900 }],
      blocking: null,
    });
    expect(rows?.every((r) => typeof r.decision === "string")).toBe(true);
    expect((await owner.query(api.recurring.list, {})).rows[0]?.amount).toEqual({
      netCents: 50_000,
      grossCents: 59_500,
      currency: "EUR",
    });
  });

  test("REC-15 UST-15 EC-DOC-94 T-EC-094 a period across a rate change → split draft, no automation, notification", async () => {
    at("2026-01-02");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const values = templateValues(personId, {
      schedule: { interval: "P1M", firstDate: "2025-12-15", billing: "in_advance", periodTextEnabled: false },
      automation: { finalize: true },
    });
    values.draft.lines = [
      {
        kind: "item",
        productType: "service",
        name: "Kantine",
        quantityMilli: 31_000,
        unitCode: "C62",
        unitPriceMicros: 100_000,
        vatRateKey: "restaurant_food",
      },
    ];
    const { id } = await owner.mutation(api.recurring.create, { values, confirmAutomation: true });
    expect(await runCron(t)).toMatchObject({ created: 1, finalized: 0 });
    const [doc] = await docsOf(t, id);
    expect(doc?.status).toBe("draft");
    const lines = await t.run((ctx) =>
      ctx.db
        .query("documentLines")
        .withIndex("by_document", (q) => q.eq("documentId", doc?._id as Id<"salesDocuments">))
        .collect(),
    );
    expect(lines.map((l) => [l.quantityMilli, l.linePeriod, l.vatRateBp])).toEqual([
      [17_000, { from: "2025-12-15", to: "2025-12-31" }, 1900],
      [14_000, { from: "2026-01-01", to: "2026-01-14" }, 700],
    ]);
    expect((await openTodos(t)).some((n) => n.kind === "recurring_review_split")).toBe(true);
  });

  test("REC-05 an archived customer generates nothing; the owner is notified and the schedule waits", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      auditedPatch(ctx, "contacts", personId, { status: "archived" }, { action: "contact.archive" }),
    );
    await runCron(t);
    expect(await docsOf(t, id)).toHaveLength(0);
    expect((await openTodos(t)).some((n) => n.kind === "recurring_blocked")).toBe(true);
    expect((await owner.query(api.recurring.get, { id }))?.nextDate).toBe("2026-11-01");
  });
});
