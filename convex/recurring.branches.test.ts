import { afterEach, describe, expect, test, vi } from "vitest";
import type { RecurringTemplateValues } from "../src/domain/schemas/recurring";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { b2bBuyer, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedPatch } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { callerMayFinalize, recordFinalizeFailure, recordRunFailure } from "./model/recurring";
import { makeT, type TestT } from "./test.setup";

/** Branch coverage of convex/recurring.ts and convex/model/recurring.ts (F04 §3.4 REC-01…16). */

afterEach(() => {
  vi.useRealTimers();
});

function at(date: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${date}T09:00:00Z`));
}

const data = (e: unknown) => (e as { data?: { reason?: string; message?: string } }).data ?? {};
async function fail(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return { code: errorCode(e), ...data(e) };
  }
  throw new Error("expected an error");
}

type TemplateInput = Omit<RecurringTemplateValues, "schedule"> & {
  schedule: Omit<RecurringTemplateValues["schedule"], "firstDate" | "endDate"> & {
    firstDate: string;
    endDate?: string;
  };
};

function templateValues(contactId: string | undefined, over: Partial<TemplateInput> = {}): RecurringTemplateValues {
  const values: TemplateInput = {
    name: "Wartungsvertrag Beispiel",
    draft: {
      type: "invoice",
      ...(contactId ? { contactId } : {}),
      currency: "EUR",
      priceMode: "net",
      paymentTerms: { dueDays: 14 },
      showEpcQr: true,
      language: "de",
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
    } as TemplateInput["draft"],
    schedule: { interval: "P1M", firstDate: "2026-11-01", billing: "in_advance", periodTextEnabled: true },
    automation: { finalize: false },
    ...over,
  };
  return values as RecurringTemplateValues;
}

async function setup(t: TestT) {
  const s = await setupInvoicing(t);
  const { personId, orgId } = await b2bBuyer(s.owner);
  return { ...s, personId, orgId };
}
type Owner = Awaited<ReturnType<typeof setup>>["owner"];

const todos = (t: TestT) =>
  t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.resolvedAt === undefined));
const tplDoc = (t: TestT, id: Id<"recurringTemplates">) => t.run((ctx) => ctx.db.get(id));
const archiveContact = (t: TestT, owner: Owner, id: Id<"contacts">) =>
  t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
    auditedPatch(ctx, "contacts", id, { status: "archived" }, { action: "contact.archive" }),
  );

describe("template writes (REC-01, REC-11, REC-14)", () => {
  test("REC-01 a template without customer stores no contact; an unknown contact is refused", async () => {
    at("2026-10-20");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, {
      values: templateValues(undefined, { contractReference: "  V-17  " }),
    });
    const row = await owner.query(api.recurring.get, { id });
    expect(row).toMatchObject({ contactId: null, contactName: null, contractReference: "V-17" });
    const ghost = await t.run(async (ctx) => {
      const c = await ctx.db.get(personId);
      if (!c) throw new Error("x");
      return c._id;
    });
    await t.run(async (ctx) => {
      await ctx.db.delete(ghost);
    });
    const e = await fail(owner.mutation(api.recurring.create, { values: templateValues(personId) }));
    expect(e).toMatchObject({ code: "invalid_input", reason: "contact_missing", message: "Kontakt nicht gefunden." });
  });

  test("REC-11 update: version conflict, archived template and a moved anchor before the first run", async () => {
    at("2026-10-20");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const values = templateValues(personId);
    const { id } = await owner.mutation(api.recurring.create, { values });
    expect(await fail(owner.mutation(api.recurring.update, { id, version: 99, values }))).toMatchObject({
      code: "version_conflict",
    });
    // before anything was generated the anchor may move; contract reference cleared
    const moved = templateValues(personId, {
      schedule: { interval: "P3M", firstDate: "2026-12-01", billing: "in_arrears", periodTextEnabled: false },
    });
    expect(await owner.mutation(api.recurring.update, { id, version: 1, values: moved })).toEqual({ version: 2 });
    expect(await owner.query(api.recurring.get, { id })).toMatchObject({
      nextDate: "2026-12-01",
      interval: "P3M",
      contractReference: null,
    });
    // archive (after a generated draft) → update refused
    await owner.action(api.recurring.runNow, { id });
    expect(await owner.mutation(api.recurring.remove, { id })).toEqual({ result: "archived" });
    // a second remove keeps it archived
    expect(await owner.mutation(api.recurring.remove, { id })).toEqual({ result: "archived" });
    const v = (await tplDoc(t, id))?.version ?? 0;
    expect(await fail(owner.mutation(api.recurring.update, { id, version: v, values: moved }))).toMatchObject({
      code: "conflict",
      reason: "archived",
      message: "Die Vorlage ist archiviert.",
    });
    // the archived template is listed nowhere and cannot be resumed or run now
    const list = await owner.query(api.recurring.list, { tab: "paused" });
    expect(list.rows).toEqual([]);
    expect(await fail(owner.mutation(api.recurring.resume, { id, catchUp: false }))).toMatchObject({
      reason: "archived",
    });
    expect(await fail(owner.action(api.recurring.runNow, { id }))).toMatchObject({ reason: "archived" });
    // the scheduled run silently skips it
    expect(
      await t.mutation(internal.recurring.generate, {
        actorContext: { actor: "system:cron.recurring.generate", channel: "cron" },
        id,
        mode: "scheduled",
      }),
    ).toEqual([]);
  });

  test("REC-14 confirmAutomation: off → automation_off; already confirmed → no-op; from REST → UI only", async () => {
    at("2026-10-20");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const off = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    expect(await fail(owner.mutation(api.recurring.confirmAutomation, { id: off.id }))).toMatchObject({
      code: "conflict",
      reason: "automation_off",
    });
    const on = await owner.mutation(api.recurring.create, {
      values: templateValues(personId, { automation: { finalize: true } }),
      confirmAutomation: true,
    });
    const before = await tplDoc(t, on.id);
    await owner.mutation(api.recurring.confirmAutomation, { id: on.id });
    expect((await tplDoc(t, on.id))?.version).toBe(before?.version);
    // an unconfirmed automation via an API key
    const key = await t.asApiKey(["documents:write", "documents:read", "invoices:finalize"]);
    const api1 = await key.mutation(api.recurring.create, {
      values: templateValues(personId, { automation: { finalize: true } }),
    });
    expect(await fail(key.mutation(api.recurring.confirmAutomation, { id: api1.id }))).toMatchObject({
      code: "invalid_input",
      reason: "automation_confirm_ui_only",
    });
    // update via the UI with confirm arms it
    const v = (await tplDoc(t, api1.id))?.version ?? 1;
    await owner.mutation(api.recurring.update, {
      id: api1.id,
      version: v,
      values: templateValues(personId, { automation: { finalize: true } }),
      confirmAutomation: true,
    });
    expect((await owner.query(api.recurring.get, { id: api1.id }))?.automationEffective).toBe(true);
  });

  test("REC-10 pausing twice is a no-op; resuming without missed occurrences skips nothing", async () => {
    at("2026-10-20");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    await owner.mutation(api.recurring.pause, { id });
    const v = (await tplDoc(t, id))?.version;
    await owner.mutation(api.recurring.pause, { id });
    expect((await tplDoc(t, id))?.version).toBe(v);
    const paused = await owner.query(api.recurring.list, { tab: "paused" });
    expect(paused.counts).toEqual({ active: 0, paused: 1, ended: 0 });
    expect(paused.rows.map((r) => r._id)).toEqual([id]);
    expect(await owner.mutation(api.recurring.resume, { id, catchUp: false })).toEqual({ due: 0, skipped: [] });
    expect(await owner.mutation(api.recurring.resume, { id, catchUp: true })).toEqual({ due: 0, skipped: [] });
    const audits = await t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).map((a) => a.action));
    expect(audits.filter((a) => a === "recurring.skip")).toEqual([]);
  });
});

describe("reads (REC-13, §6.1)", () => {
  test("REC-13 occurrences: unsaved values, invalid values → null, no id → null, count clamped", async () => {
    at("2026-10-20");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const values = templateValues(personId);
    expect(await owner.query(api.recurring.occurrences, {})).toBeNull();
    expect(await owner.query(api.recurring.occurrences, { values: { name: "" } })).toBeNull();
    const fresh = await owner.query(api.recurring.occurrences, { values, count: 0 });
    expect(fresh).toHaveLength(1);
    expect(fresh?.[0]?.date).toBe("2026-11-01");
    expect(await owner.query(api.recurring.occurrences, { values, count: 500 })).toHaveLength(60);
    // a started template keeps its nextDate in the preview of edited values
    const { id } = await owner.mutation(api.recurring.create, { values });
    await owner.action(api.recurring.runNow, { id });
    const started = await owner.query(api.recurring.occurrences, { id, values, count: 2 });
    expect(started?.map((r) => r.date)).toEqual(["2026-12-01", "2027-01-01"]);
    // an ended schedule previews nothing
    const ended = await owner.query(api.recurring.occurrences, {
      values: templateValues(personId, {
        schedule: {
          interval: "P1M",
          firstDate: "2026-11-01",
          maxCount: 1,
          billing: "in_advance",
          periodTextEnabled: false,
        },
      }),
      id,
    });
    expect(ended).toEqual([]);
    expect(
      await owner.query(api.recurring.get, { id: (await tplDoc(t, id))?._id as Id<"recurringTemplates"> }),
    ).not.toBeNull();
  });

  test("REC-03 an ended template is listed under „Beendet“ without next date; get of a deleted template → null", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, {
      values: templateValues(personId, {
        schedule: {
          interval: "P1M",
          firstDate: "2026-11-01",
          maxCount: 1,
          billing: "in_advance",
          periodTextEnabled: false,
        },
      }),
    });
    const b = await owner.mutation(api.recurring.create, { values: templateValues(personId, { name: "B" }) });
    await owner.action(api.recurring.runNow, { id });
    const ended = await owner.query(api.recurring.list, { tab: "ended" });
    expect(ended.rows).toMatchObject([{ _id: id, state: "ended", nextDate: null, generatedCount: 1 }]);
    expect(ended.counts).toMatchObject({ active: 1, ended: 1 });
    // „Jetzt erzeugen“ on an ended template → template_ended
    expect(await fail(owner.action(api.recurring.runNow, { id }))).toMatchObject({
      code: "conflict",
      reason: "template_ended",
      message: "Die Vorlage ist beendet.",
    });
    const detail = await owner.query(api.recurring.get, { id });
    expect(detail?.documents).toHaveLength(1);
    expect(detail?.documents[0]).toMatchObject({ status: "draft", number: null, occurrence: "2026-11-01" });
    await owner.mutation(api.recurring.remove, { id: b.id });
    expect(await owner.query(api.recurring.get, { id: b.id })).toBeNull();
    expect(await fail(owner.query(api.recurring.occurrences, { id: b.id }))).toMatchObject({ code: "not_found" });
  });
});

describe("generation edge paths (REC-05, REC-07, REC-12)", () => {
  test("REC-12 „Jetzt erzeugen“ for an archived customer or a template without customer → contact_unusable", async () => {
    at("2026-10-20");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const none = await owner.mutation(api.recurring.create, { values: templateValues(undefined) });
    expect(await fail(owner.action(api.recurring.runNow, { id: none.id }))).toMatchObject({
      code: "conflict",
      reason: "contact_unusable",
      message: "Die Vorlage hat keinen (gültigen) Kunden.",
    });
    const { id } = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    await archiveContact(t, owner, personId);
    expect(await fail(owner.action(api.recurring.runNow, { id }))).toMatchObject({
      reason: "contact_unusable",
      message: "Der Kunde ist archiviert.",
    });
  });

  test("REC-05 the blocked notice is resolved once the customer is usable again; a paused template is skipped by the job", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    await archiveContact(t, owner, personId);
    const sys = { actor: "system:cron.recurring.generate", channel: "cron" } as const;
    expect(await t.mutation(internal.recurring.generate, { actorContext: sys, id, mode: "scheduled" })).toEqual([]);
    expect((await todos(t)).map((n) => n.kind)).toContain("recurring_blocked");
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      auditedPatch(ctx, "contacts", personId, { status: "active" }, { action: "contact.unarchive" }),
    );
    const drafts = await t.mutation(internal.recurring.generate, { actorContext: sys, id, mode: "scheduled" });
    expect(drafts).toHaveLength(1);
    expect((await todos(t)).map((n) => n.kind)).not.toContain("recurring_blocked");
    // nothing more due today → empty
    expect(await t.mutation(internal.recurring.generate, { actorContext: sys, id, mode: "scheduled" })).toEqual([]);
    await owner.mutation(api.recurring.pause, { id });
    expect(await t.mutation(internal.recurring.generate, { actorContext: sys, id, mode: "scheduled" })).toEqual([]);
  });

  test("REC-07 a failed run and a failed finalisation notify the owner with the error list", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    const [d] = await owner.action(api.recurring.runNow, { id }).then((r) => r.ids);
    const sys = { actor: "system:cron.recurring.generate", channel: "cron" } as const;
    await t.model(sys, (ctx) =>
      recordFinalizeFailure(ctx, d as Id<"salesDocuments">, {
        code: "validation_failed",
        message: "Fehler",
        findings: ["Telefon fehlt", "E-Mail fehlt"],
      }),
    );
    await t.model(sys, (ctx) => recordRunFailure(ctx, id, "Zeitüberschreitung"));
    const open = await todos(t);
    expect(open.find((n) => n.kind === "recurring_finalize_failed")).toMatchObject({
      title: "Wiederkehrende Rechnung „Wartungsvertrag Beispiel“ nicht automatisch fertiggestellt",
      body: "Der Entwurf bleibt zur Prüfung (validation_failed): Telefon fehlt · E-Mail fehlt",
    });
    expect(open.find((n) => n.kind === "recurring_run_failed")).toMatchObject({
      severity: "error",
      body: "Zeitüberschreitung",
    });
    // a manual draft (no template) and a deleted template still notify with „?“, the message as the list
    const { id: manual } = await owner.mutation(api.invoices.createDraft, {
      values: { ...templateValues(personId).draft, supplyDateMode: "document_date" } as never,
    });
    await t.model(sys, (ctx) =>
      recordFinalizeFailure(ctx, manual, { code: "dependency_unavailable", message: "KoSIT aus", findings: [] }),
    );
    expect((await todos(t)).find((n) => n.entity?.id === manual)?.body).toBe(
      "Der Entwurf bleibt zur Prüfung (dependency_unavailable): KoSIT aus",
    );
  });

  test("REC-07 the job finalises through the pipeline and keeps the draft on a finalisation error", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    // no unit price → blocking finding, the pipeline refuses
    const values = templateValues(personId, { automation: { finalize: true } });
    values.draft.lines = [{ ...values.draft.lines[0], name: "" } as never];
    const { id } = await owner.mutation(api.recurring.create, { values, confirmAutomation: true });
    const r = await t.action(internal.recurring.generateCron, { force: true });
    expect(r).toMatchObject({ templates: 1, created: 1, finalized: 0 });
    expect((await todos(t)).some((n) => n.kind === "recurring_finalize_failed")).toBe(true);
    expect(await t.action(internal.recurring.generateCron, {})).toEqual({ templates: 0, created: 0, finalized: 0 });
    expect((await tplDoc(t, id))?.generatedCount).toBe(1);
  });

  test("REC-05 one failing template never stops the others (run failure notified)", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const a = await owner.mutation(api.recurring.create, { values: templateValues(personId, { name: "A" }) });
    const b = await owner.mutation(api.recurring.create, { values: templateValues(personId, { name: "B" }) });
    // corrupt A's stored draft so that createDraft throws inside the run
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, async (ctx) => {
      const tpl = await ctx.db.get(a.id);
      await auditedPatch(
        ctx,
        "recurringTemplates",
        a.id,
        { draft: { ...(tpl?.draft as object), lines: "kaputt" } as never },
        { action: "recurring.update" },
      );
    });
    const r = await t.action(internal.recurring.generateCron, { force: true });
    expect(r.templates).toBe(2);
    expect(r.created).toBe(1);
    expect((await tplDoc(t, b.id))?.generatedCount).toBe(1);
    expect((await todos(t)).find((n) => n.kind === "recurring_run_failed")?.title).toContain("„A“");
  });

  test("REC-12 callerMayFinalize: system always, keys by scope, members by role", () => {
    expect(callerMayFinalize({ actor: "system:cron.recurring.generate", channel: "cron" })).toBe(true);
    expect(callerMayFinalize({ actor: "api-key:k", channel: "api", scopes: ["documents:write"] })).toBe(false);
    expect(callerMayFinalize({ actor: "mcp:k", channel: "mcp", scopes: ["invoices:finalize"] })).toBe(true);
    expect(callerMayFinalize({ actor: "api-key:k", channel: "api" })).toBe(false);
    expect(callerMayFinalize({ actor: "user:u", channel: "ui", role: "viewer" })).toBe(false);
    expect(callerMayFinalize({ actor: "user:u", channel: "ui", role: "bookkeeper" })).toBe(true);
    expect(callerMayFinalize({ actor: "user:u", channel: "ui" })).toBe(false);
  });

  test("REC-12 „Jetzt erzeugen“ via an API key without invoices:finalize leaves the automated draft unfinalised", async () => {
    at("2026-10-20");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, {
      values: templateValues(personId, { automation: { finalize: true } }),
      confirmAutomation: true,
    });
    const key = await t.asApiKey(["documents:write", "documents:read"]);
    expect(await key.action(api.recurring.runNow, { id })).toMatchObject({ created: 1, finalized: 0 });
  });
});

describe("KU boundary, end date and list order (REC-03, REC-15, §6.1)", () => {
  test("REC-15 KU-01 a period across a Kleinunternehmer change: the preview hints it and the generated draft is a split review", async () => {
    at("2026-11-01");
    const t = makeT();
    const { owner, personId } = await setup(t);
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      patchCompanyProfile(
        ctx,
        {
          kleinunternehmer: [
            { validFrom: "2020-01-01", isKU: false },
            { validFrom: "2026-11-15", isKU: true },
          ],
        },
        { action: "settings.company.update" },
      ),
    );
    const { id } = await owner.mutation(api.recurring.create, {
      values: templateValues(personId, { automation: { finalize: true } }),
      confirmAutomation: true,
    });
    const rows = await owner.query(api.recurring.occurrences, { id, count: 1 });
    expect(rows?.[0]?.hints).toContain("Wechsel der Kleinunternehmerregelung am 15.11.2026 – Entwurf zur Prüfung");
    expect(rows?.[0]?.blocking).toBeNull();
    const r = await t.action(internal.recurring.generateCron, { force: true });
    expect(r).toMatchObject({ created: 1, finalized: 0 });
    const split = (await todos(t)).find((n) => n.kind === "recurring_review_split");
    expect(split?.body).toContain("Wechsel der Kleinunternehmerregelung am 15.11.2026");
  });

  test("REC-03 an end date ends the template after its last occurrence; templates are listed by next date, then name", async () => {
    at("2026-10-20");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const ending = await owner.mutation(api.recurring.create, {
      values: templateValues(personId, {
        name: "B Wartung",
        schedule: {
          interval: "P1M",
          firstDate: "2026-11-01",
          endDate: "2026-11-30",
          billing: "in_advance",
          periodTextEnabled: false,
        },
      }),
    });
    await owner.mutation(api.recurring.create, { values: templateValues(personId, { name: "A Wartung" }) });
    const listed = await owner.query(api.recurring.list, {});
    expect(listed.rows.map((r) => r.name)).toEqual(["A Wartung", "B Wartung"]);
    expect(listed.rows[1]?.schedule.endDate).toBe("2026-11-30");
    expect(await owner.query(api.recurring.occurrences, { id: ending.id })).toHaveLength(1);
    await owner.action(api.recurring.runNow, { id: ending.id });
    expect((await owner.query(api.recurring.get, { id: ending.id }))?.state).toBe("ended");
  });

  test("REC-07 a run failure of a deleted template is still notified („?“)", async () => {
    at("2026-10-20");
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await owner.mutation(api.recurring.create, { values: templateValues(personId) });
    await owner.mutation(api.recurring.remove, { id });
    await t.model({ actor: "system:cron.recurring.generate", channel: "cron" }, (ctx) =>
      recordRunFailure(ctx, id, "Fehler"),
    );
    expect((await todos(t)).find((n) => n.kind === "recurring_run_failed")?.title).toBe(
      "Wiederkehrende Rechnung „?“: Erzeugung fehlgeschlagen",
    );
  });
});
