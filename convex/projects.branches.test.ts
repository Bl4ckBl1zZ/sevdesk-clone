import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { emptyProjectForm, emptyTimeEntryForm, type ProjectFormValues } from "../src/domain/schemas/projects";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { productForm } from "./catalog.fixtures";
import { b2bBuyer, consumerBuyer, invoiceValues, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { getCompanyProfile, patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";
import { header, line, setupCompany, upload } from "./vouchers.fixtures";

/**
 * Branch coverage of F11 projects (convex/model/projects.ts) and „Zeiten abrechnen“ (convex/model/timeInvoicing.ts):
 * reference guards, optional fields, status changes, the fixed-price amount budget, profitability over line-level
 * documents, Stornos and vouchers, and the invoicing options (draft append, rounding, gross prices, timesheet flag).
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

const projectDoc = (t: TestT, id: Id<"projects">) =>
  t.run(async (ctx) => {
    const p = await ctx.db.get(id);
    if (!p) throw new Error("missing");
    return p;
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
const item = (over: Record<string, unknown> = {}) => ({
  kind: "item" as const,
  productType: "service" as const,
  name: "Beratung",
  quantityMilli: 1000,
  unitCode: "HUR",
  unitPriceMicros: 1_000_000,
  vatRateKey: "standard",
  ...over,
});

describe("PRJ-001 project master data branches", () => {
  test("PRJ-001 unknown contact or default product is refused with field reasons", async () => {
    const t = makeT();
    const { owner } = await setup(t);
    const c = await fail(owner.mutation(api.projects.create, { values: projectForm({ contactId: "kein-kontakt" }) }));
    expect(errorCode(c)).toBe("invalid_input");
    expect(reasonOf(c)).toBe("CONTACT_UNKNOWN");
    expect(messageOf(c)).toBe("Unbekannter Kontakt.");
    const p = await fail(
      owner.mutation(api.projects.create, { values: projectForm({ defaultProductId: "kein-produkt" }) }),
    );
    expect(reasonOf(p)).toBe("PRODUCT_UNKNOWN");
    expect(messageOf(p)).toBe("Unbekanntes Produkt.");
    expect(await t.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);
  });

  test("PRJ-001 optional fields are stored and cleared on update; unknown projects are not found", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const product = await owner.mutation(api.products.create, {
      values: productForm("Beratung Webdesign", { type: "service", unitCode: "HUR", price: "80,00" }),
    });
    const id = await project(owner, personId, {
      description: "Neue Website mit Shop",
      internalCostRate: "30,00",
      budgetKind: "amount",
      budgetValue: "5000,00",
      startDate: "2026-10-01",
      endDate: "2026-12-31",
      roundingIncrement: "15",
      roundingMode: "nearest",
      roundingMinimum: "30",
      defaultProductId: product.id,
      attachTimesheetDefault: true,
    });
    expect(await projectDoc(t, id)).toMatchObject({
      description: "Neue Website mit Shop",
      internalCostRateMicros: 300_000,
      budget: { kind: "amount", value: 500_000 },
      startDate: "2026-10-01",
      endDate: "2026-12-31",
      rounding: { incrementMinutes: 15, mode: "nearest", minimumMinutes: 30 },
      defaultProductId: product.id,
      attachTimesheetDefault: true,
      contactId: personId,
    });
    const r = await owner.mutation(api.projects.update, { id, values: projectForm({ name: "Website 2.0" }) });
    expect(r).toEqual({ openEntriesWithOldRate: 0 });
    const cleared = await projectDoc(t, id);
    expect(cleared).toMatchObject({ name: "Website 2.0", hourlyRateMicros: 900_000, currency: "EUR" });
    for (const k of [
      "description",
      "contactId",
      "internalCostRateMicros",
      "budget",
      "startDate",
      "endDate",
      "defaultProductId",
      "rounding",
      "attachTimesheetDefault",
    ] as const) {
      expect(cleared[k]).toBeUndefined();
    }
    await owner.mutation(api.projects.remove, { id });
    const upd = await fail(owner.mutation(api.projects.update, { id, values: projectForm() }));
    expect(errorCode(upd)).toBe("not_found");
    expect(messageOf(upd)).toBe("Projekt nicht gefunden.");
    const prof = await fail(owner.query(api.projects.profitability, { id, basis: "accrual" }));
    expect(errorCode(prof)).toBe("not_found");
    expect(await owner.query(api.projects.get, { id })).toBeNull();
  });

  test("PRJ-001 E-PRJ-30 setting the same status changes nothing; „abgeschlossen“ is audited as a status change without warning", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const id = await project(owner, personId);
    await logEntry(owner, id, "2026-10-01", "1h");
    expect(await owner.mutation(api.projects.setStatus, { id, status: "active" })).toEqual({});
    expect(await owner.mutation(api.projects.setStatus, { id, status: "done" })).toEqual({});
    expect((await projectDoc(t, id)).status).toBe("done");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    const actions = audit.filter((a) => a.entity.table === "projects").map((a) => a.action);
    expect(actions).toContain("project.status");
    expect(actions).not.toContain("project.archive");
    // archiving a project whose entries are all non-billable: no warning
    const internalProject = await project(owner, personId, { name: "Intern", billingMode: "non_billable" });
    await owner.mutation(api.timeEntries.create, {
      values: { ...entryForm(internalProject, "2026-10-01", "1h"), billable: false },
    });
    expect(await owner.mutation(api.projects.setStatus, { id: internalProject, status: "archived" })).toEqual({});
  });

  test("PRJ-001 the project list searches by text and status „all“; options list active projects", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const a = await project(owner, personId);
    const b = await project(owner, personId, { name: "Wartung Server" });
    await owner.mutation(api.projects.setStatus, { id: b, status: "archived" });
    expect((await owner.query(api.projects.list, { status: "all" })).map((p) => p._id).sort()).toEqual([a, b].sort());
    expect((await owner.query(api.projects.options, {})).map((p) => p._id)).toEqual([a]);
  });
});

describe("PRJ-003 fixed-price amount budget", () => {
  test("PRJ-003 a fixed-price amount budget counts finalised, non-cancelled invoices of the project (drafts and quotes do not)", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const id = await project(owner, personId, { billingMode: "fixed", budgetKind: "amount", budgetValue: "2000,00" });
    const draft = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { projectId: id } as never),
    });
    const inv = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { projectId: id } as never),
    });
    await owner.action(api.invoices.finalize, { id: inv.id, version: 1 });
    const cancelled = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { projectId: id } as never),
    });
    await owner.action(api.invoices.finalize, { id: cancelled.id, version: 1 });
    await owner.mutation(api.corrections.cancel, { id: cancelled.id, reason: "Doppelt gestellt" });
    const [row] = await owner.query(api.projects.list, {});
    // 10 h × 100 € = 1.000 € net of the one valid invoice (draft and the cancelled invoice do not count)
    expect(row?.budget).toMatchObject({ ratioBp: 5000 });
    expect((await doc(t, draft.id)).status).toBe("draft");
  });
});

describe("PRJ-002 PRJ-004 profitability branches", () => {
  test("PRJ-004 line-level project assignment counts only the project's lines; the Storno counts negative; drafts do not count", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const id = await project(owner, personId, { internalCostRate: "30,00" });
    const other = await project(owner, personId, { name: "Anderes" });
    // header without project, one of two lines on the project
    const mixed = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, {
        lines: [
          item({ name: "Konzept", quantityMilli: 2000, projectId: id }),
          item({ name: "Hosting", quantityMilli: 3000, projectId: other }),
        ],
      } as never),
    });
    await owner.action(api.invoices.finalize, { id: mixed.id, version: 1 });
    // a header invoice of the project, cancelled → invoice + Storno
    const header = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { projectId: id, lines: [item({ quantityMilli: 1000 })] } as never),
    });
    await owner.action(api.invoices.finalize, { id: header.id, version: 1 });
    await owner.mutation(api.corrections.cancel, { id: header.id, reason: "Falscher Betrag" });
    // a draft and a quote of the project do not count
    await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, {
        type: "quote",
        projectId: id,
        lines: [item({ quantityMilli: 5000 })],
      } as never),
    });
    await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { projectId: id, lines: [item({ quantityMilli: 7000 })] } as never),
    });
    const p = await owner.query(api.projects.profitability, { id, basis: "accrual" });
    const kinds = p.revenueRows.map((r) => [r.kind, r.netCents]).sort();
    expect(kinds).toEqual([
      ["cancellation", -10_000],
      ["invoice", 10_000],
      ["invoice", 20_000],
    ]);
    expect(p.revenueCents).toBe(20_000);
    const cash = await owner.query(api.projects.profitability, { id, basis: "cash" });
    expect(cash.revenueRows.find((r) => r.id === mixed.id)?.netCents).toBe(0);
    const page = await owner.query(api.projects.get, { id });
    expect(page?.documents.map((d) => d.typeLabel).sort()).toEqual([
      "Angebot",
      "Rechnung",
      "Rechnung",
      "Rechnung",
      "Stornorechnung",
    ]);
  });

  test("PRJ-004 vouchers of the project count as costs (net + non-deductible VAT); drafts are ignored; cash basis weights by payment", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const created = await owner.mutation(api.projects.create, {
      values: projectForm({ name: "Messestand", internalCostRate: "20,00" }),
    });
    const id = created.id as Id<"projects">;
    const booked = (await upload(t, owner)).voucherId;
    await owner.mutation(api.vouchers.updateDraft, {
      id: booked,
      input: header({ projectId: id, documentDate: "2026-10-01", lines: [line({ nonDeductibleShareBp: 3000 })] }),
    });
    await owner.mutation(api.vouchers.finalize, { id: booked });
    const draft = (await upload(t, owner)).voucherId;
    await owner.mutation(api.vouchers.updateDraft, {
      id: draft,
      input: header({
        projectId: id,
        documentDate: "2026-10-01",
        supplierName: "Telekom Deutschland GmbH",
        supplierVatId: "DE811907980",
      }),
    });
    const accrual = await owner.query(api.projects.profitability, { id, basis: "accrual" });
    // 119,00 gross @19 % → 100,00 net, 19,00 VAT of which 30 % non-deductible = 5,70
    expect(accrual.costRows).toEqual([{ id: booked, netCents: 10_000, nonDeductibleVatCents: 570 }]);
    const cash = await owner.query(api.projects.profitability, { id, basis: "cash" });
    expect(cash.costRows).toEqual([{ id: booked, netCents: 0, nonDeductibleVatCents: 0 }]);
    const page = await owner.query(api.projects.get, { id });
    expect(page?.vouchers.map((v) => v._id).sort()).toEqual([booked, draft].sort());
  });
});

describe("PRJ-010…014 invoicing options", () => {
  test("PRJ-010 unknown entry ids and non-draft targets are refused", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const id = await logEntry(owner, p, "2026-10-01", "1h");
    const bad = await fail(
      owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: ["kein-eintrag"], grouping: "summary" } }),
    );
    expect(reasonOf(bad)).toBe("TIME_ENTRY_UNKNOWN");
    expect(messageOf(bad)).toBe("Unbekannter Zeiteintrag.");
    const notDraft = await fail(
      owner.mutation(api.timeEntries.createInvoice, {
        values: { entryIds: [id], grouping: "summary", draftId: "kein-entwurf" },
      }),
    );
    expect(reasonOf(notDraft)).toBe("DRAFT_REQUIRED");
    expect(messageOf(notDraft)).toBe("Bitte einen Rechnungsentwurf wählen.");
    const preview = await owner.query(api.timeEntries.previewInvoice, {
      values: { entryIds: [id], grouping: "summary" },
    });
    expect(preview).toMatchObject({ ok: true, timesheetDefault: false });
    // E-PRJ-23 the preview reports the blocking issue instead of throwing
    const noRate = await owner.mutation(api.timeEntries.create, {
      values: { ...emptyTimeEntryForm("2026-10-01"), duration: "1h", description: "Abstimmung", contactId: personId },
    });
    const blocked = await owner.query(api.timeEntries.previewInvoice, {
      values: { entryIds: [noRate.id], grouping: "summary" },
    });
    expect(blocked).toMatchObject({ ok: false, error: { code: "time_entries_rate_missing" } });
  });

  test("PRJ-009 PRJ-011 the project rounding and default product apply; product names are looked up once per product", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const product = await owner.mutation(api.products.create, {
      values: productForm("Beratung Webdesign", { type: "service", unitCode: "HUR", price: "80,00" }),
    });
    const p = await project(owner, personId, {
      defaultProductId: product.id,
      roundingIncrement: "30",
      roundingMode: "up",
    });
    const ids = [await logEntry(owner, p, "2026-10-01", "10m"), await logEntry(owner, p, "2026-10-02", "40m")];
    const r = await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: ids, grouping: "per_entry" },
    });
    const lines = await linesOf(t, r.id);
    expect(lines.map((l) => [l.quantityMilli, l.productId])).toEqual([
      [500, product.id],
      [1000, product.id],
    ]);
    expect(lines[0]?.timeRounding).toMatchObject({ incrementMinutes: 30, mode: "up" });
  });

  test("PRJ-010 PRJ-013 appending to a draft with an explicit supply date widens it to cover the entries", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId);
    const draft = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { supplyDate: { kind: "date", date: "2026-10-05" as CalendarDate } }),
    });
    const early = await logEntry(owner, p, "2026-10-01", "1h");
    const r = await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: [early], grouping: "summary", draftId: draft.id },
    });
    expect(r.id).toBe(draft.id);
    expect((await doc(t, draft.id)).supplyDate).toEqual({ kind: "period", from: "2026-10-01", to: "2026-10-05" });
    // a second entry inside the period keeps it; one on the same day as a single-date draft gives a date
    const inside = await logEntry(owner, p, "2026-10-03", "1h");
    const v = (await doc(t, draft.id)).version;
    await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: [inside], grouping: "summary", draftId: draft.id },
    });
    expect((await doc(t, draft.id)).supplyDate).toEqual({ kind: "period", from: "2026-10-01", to: "2026-10-05" });
    expect((await doc(t, draft.id)).version).toBeGreaterThan(v);
    const single = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { supplyDate: { kind: "date", date: "2026-10-07" as CalendarDate } }),
    });
    const same = await logEntry(owner, p, "2026-10-07", "1h");
    await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: [same], grouping: "summary", draftId: single.id },
    });
    expect((await doc(t, single.id)).supplyDate).toEqual({ kind: "date", date: "2026-10-07" });
  });

  test("PRJ-014 an explicit „kein Leistungsnachweis“ overrides the project default", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const p = await project(owner, personId, { attachTimesheetDefault: true });
    const a = await logEntry(owner, p, "2026-10-01", "1h");
    const preview = await owner.query(api.timeEntries.previewInvoice, {
      values: { entryIds: [a], grouping: "summary" },
    });
    expect(preview).toMatchObject({ ok: true, timesheetDefault: true });
    const r = await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: [a], grouping: "summary", attachTimesheet: false },
    });
    expect((await doc(t, r.id)).attachTimesheet).toBeFalsy();
    // appending to a draft that has the option already set keeps it when not given
    const b = await logEntry(owner, p, "2026-10-02", "1h");
    const withOption = await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: [b], grouping: "summary", attachTimesheet: true },
    });
    const c = await logEntry(owner, p, "2026-10-03", "1h");
    await owner.mutation(api.timeEntries.createInvoice, {
      values: { entryIds: [c], grouping: "summary", draftId: withOption.id },
    });
    expect((await doc(t, withOption.id)).attachTimesheet).toBe(true);
  });

  test("PRJ-010 an entry without contact goes on a draft without customer using the company defaults", async () => {
    const t = makeT();
    const { owner } = await setup(t);
    const consumer = await consumerBuyer(owner);
    const p = await project(owner, "", { name: "Ohne Kunde" });
    const a = await logEntry(owner, p, "2026-10-01", "1h");
    const r = await owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: [a], grouping: "summary" } });
    const d = await doc(t, r.id);
    expect(d.contactId).toBeUndefined();
    expect(d).toMatchObject({ priceMode: "net", language: "de", projectId: p });
    // E-PRJ-24 consumer → gross prices at the period start's rate
    const cp = await project(owner, consumer, { name: "Privat" });
    const b = await logEntry(owner, cp, "2026-10-01", "1h");
    const g = await owner.mutation(api.timeEntries.createInvoice, { values: { entryIds: [b], grouping: "summary" } });
    expect((await doc(t, g.id)).priceMode).toBe("gross");
    expect((await linesOf(t, g.id))[0]?.unitPriceMicros).toBe(1_071_000);
  });

  test("E-PRJ-16 without Kleinunternehmer history the lines are not split; the company's rounding default applies", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, async (ctx) => {
      const profile = await getCompanyProfile(ctx);
      if (!profile) throw new Error("no profile");
      await patchCompanyProfile(
        ctx,
        {
          kleinunternehmer: [],
          defaults: { ...profile.defaults, time: { unitCode: "HUR", rounding: { incrementMinutes: 15, mode: "up" } } },
        } as never,
        { action: "settings.company.update" },
      );
    });
    const p = await project(owner, personId);
    const a = await logEntry(owner, p, "2026-10-01", "10m");
    const preview = await owner.query(api.timeEntries.previewInvoice, {
      values: { entryIds: [a], grouping: "summary" },
    });
    expect(preview.ok && preview.plan.lines.map((l) => l.quantityMilli)).toEqual([250]);
  });
});
