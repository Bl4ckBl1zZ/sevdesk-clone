import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { emptyProjectForm, emptyTimeEntryForm } from "../src/domain/schemas/projects";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { invoiceEvent, post, setupBooks } from "./bookkeeping.fixtures";
import { CONTACT_RANGE, createValues, orgForm, productForm, setupCatalog } from "./catalog.fixtures";
import { b2bBuyer, finalizedInvoice, setupInvoicing } from "./invoices.fixtures";
import { recordCashTransfer } from "./model/cash";
import { patchCompanyProfile } from "./model/companyProfile";
import { recordIntegrityRun } from "./model/integrity";
import { advanceJob, createJob, failJob, finishJob } from "./model/jobs";
import { seedUnits } from "./model/lookups";
import { seedCategories } from "./model/products";
import { bookedTransaction } from "./payments.fixtures";
import { makeT } from "./test.setup";
import { objectOf, outbox, outboxOf, outboxTypes, stubHookFetch, subscribeHook } from "./webhooks.fixtures";

/**
 * 05 §5.3 event catalog, part 2: bank/cash (BNK-080), contacts, products, settings, periods and filings, jobs, time,
 * and the F12 security/privacy events (AUD-015, EC-186). The outbox rows are checked; deliveries go to a stub.
 */

vi.mock("./lib/webhookDns", () => ({ resolveHost: async () => ["93.184.216.34"] }));
vi.setConfig({ testTimeout: 60_000 });

const NOW = new Date("2026-10-12T10:00:00Z");
const OWNER_CTX = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  stubHookFetch();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const changedFields = (e: { previous?: unknown } | undefined) =>
  ((e?.previous ?? {}) as { changed_fields?: string[] }).changed_fields ?? [];

describe("F07 banking and cash (BNK-080)", () => {
  test("BNK-080 a confirmed allocation emits bank_transaction.matched with amounts and IDs only, no counterparty", async () => {
    const t = makeT();
    const { owner, id, bankAccount, number } = await finalizedInvoice(t);
    await subscribeHook(owner, ["bank_transaction.matched"]);
    const txId = await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-12",
      amountCents: 119_000,
      purpose: `Rechnung ${number}`,
      counterpartyName: "Erika Muster",
      counterpartyIban: "DE02120300000000202051",
    });
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "bank", transactionId: txId },
      date: "2026-10-12",
      amountCents: 119_000,
    });
    const [ev] = await outboxOf(t, "bank_transaction.matched");
    expect(objectOf(ev)).toMatchObject({
      id: `btx_${txId}`,
      object: "bank_transaction",
      bank_account_id: `bac_${bankAccount}`,
      amount_cents: 119_000,
      status: "matched",
      allocated_cents: 119_000,
    });
    expect(ev?.previous).toEqual({ status: "open", allocated_cents: 0 });
    expect(JSON.stringify(ev)).not.toMatch(/Erika|DE02/);
  });

  test("BNK-080 a cash transfer emits cash_movement.recorded", async () => {
    const t = makeT();
    const { id, bankAccount, owner } = await finalizedInvoice(t);
    await subscribeHook(owner, ["cash_movement.recorded"]);
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id,
      source: { kind: "cash" },
      date: "2026-10-12",
      amountCents: 119_000,
    });
    const transfer = await t.model(OWNER_CTX, (ctx) =>
      recordCashTransfer(ctx, {
        kind: "deposit_to_bank",
        date: "2026-10-12",
        amountCents: 50_000,
        bankAccountId: bankAccount,
      }),
    );
    const evs = await outboxOf(t, "cash_movement.recorded");
    expect(evs).toHaveLength(1);
    expect(objectOf(evs[0])).toMatchObject({
      id: `csh_${transfer.id}`,
      object: "cash_movement",
      kind: "deposit_to_bank",
      amount_cents: 50_000,
      bank_account_id: `bac_${bankAccount}`,
    });
  });
});

describe("F02 contacts and F03 products (05 §5.3)", () => {
  test("API-030 contact events carry the ID and changed field names, never personal values", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    await subscribeHook(owner);
    const c = await owner.mutation(api.contacts.create, { values: createValues(orgForm("Muster Handel GmbH")) });
    await owner.mutation(api.contacts.update, { id: c.id, version: 1, values: orgForm("Muster Handel KG") });
    await owner.mutation(api.contacts.archive, { id: c.id });
    expect(await outboxTypes(t)).toEqual(["contact.created", "contact.updated", "contact.archived"]);
    const [updated] = await outboxOf(t, "contact.updated");
    expect(objectOf(updated)).toMatchObject({ id: `con_${c.id}`, object: "contact" });
    expect(changedFields(updated)).toContain("organizationName");
    expect(JSON.stringify(await outbox(t))).not.toContain("Muster Handel");
  });

  test("API-030 product events: created, updated with field names, archived, deleted", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, async (ctx) => {
      await seedUnits(ctx);
      await seedCategories(ctx);
    });
    await subscribeHook(owner, ["product.created", "product.updated", "product.archived", "product.deleted"]);
    const p = await owner.mutation(api.products.create, { values: productForm("Webdesign Stunde") });
    await owner.mutation(api.products.update, { id: p.id, version: 1, values: productForm("Webdesign Std.") });
    await owner.mutation(api.products.archive, { id: p.id });
    const q = await owner.mutation(api.products.create, { values: productForm("Kabel") });
    await owner.mutation(api.products.remove, { id: q.id });
    expect(await outboxTypes(t)).toEqual([
      "product.created",
      "product.updated",
      "product.archived",
      "product.created",
      "product.deleted",
    ]);
    const [created] = await outboxOf(t, "product.created");
    expect(objectOf(created)).toMatchObject({
      id: `prd_${p.id}`,
      object: "product",
      number: "ART-00001",
      active: true,
    });
    expect(changedFields((await outboxOf(t, "product.updated"))[0])).toContain("name");
  });
});

describe("F01 settings, F08 periods and filings (05 §5.3)", () => {
  test("API-030 settings.company/tax.updated carry the changed field names; saving number ranges emits settings.number_range.updated", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await subscribeHook(owner, ["settings.company.updated", "settings.tax.updated", "settings.number_range.updated"]);
    await t.model(OWNER_CTX, (ctx) =>
      patchCompanyProfile(ctx, { name: "Muster Consulting e.K." }, { action: "settings.company.update" }),
    );
    await t.model(OWNER_CTX, (ctx) =>
      patchCompanyProfile(
        ctx,
        { taxationMethod: [{ validFrom: "2026-01-01", method: "ist" }] },
        { action: "settings.tax.update" },
      ),
    );
    await owner.mutation(api.settings.saveNumberRanges, { values: { ranges: [CONTACT_RANGE] } });
    expect(await outboxTypes(t)).toEqual([
      "settings.company.updated",
      "settings.tax.updated",
      "settings.number_range.updated",
    ]);
    expect((await outboxOf(t, "settings.tax.updated"))[0]?.previous).toEqual({ changed_fields: ["taxationMethod"] });
    expect(objectOf((await outboxOf(t, "settings.number_range.updated"))[0])).toMatchObject({ ranges: ["contact"] });
  });

  test("API-030 a UStVA record emits tax_filing.submitted and period.locked; „abweichend übermittelt“ also tax_filing.correction_required", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    await post(t, invoiceEvent(customer, "d9", "2026-09-10", 100_000));
    const u = await t.asUser("owner");
    await subscribeHook(u, ["tax_filing.submitted", "tax_filing.correction_required", "period.locked"]);
    const view = await u.query(api.taxes.ustva, { period: "2026-09" });
    await u.mutation(api.taxes.recordFilingSubmission, {
      form: "ustva",
      period: "2026-09",
      submittedOn: "2026-10-09",
      transferTicket: "et123456789012345678",
      crossCheckCents: (view.sheet?.totalCents ?? 0) + 100,
      sheetHash: view.guide?.sheetHash ?? "",
      valuesDifferReason: "Kz 83 in ELSTER abweichend eingegeben",
    });
    const all = await outboxTypes(t);
    expect(all.slice(0, 2)).toEqual(["tax_filing.submitted", "tax_filing.correction_required"]);
    const locked = await outboxOf(t, "period.locked");
    expect(locked.length).toBeGreaterThan(0);
    expect(objectOf(locked.at(-1))).toMatchObject({ object: "period", period: "2026-09", reason: "ustva_submitted" });
    expect(objectOf((await outboxOf(t, "tax_filing.submitted"))[0])).toMatchObject({
      object: "tax_filing",
      kind: "ustva",
      period: "2026-09",
      submitted_values_differ: true,
    });
  });
});

describe("F09 jobs and F11 time (05 §5.3)", () => {
  test("API-030 export.completed and job.failed for background jobs (no error text in the payload)", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await subscribeHook(owner, ["export.completed", "job.failed"]);
    const ok = await t.model(OWNER_CTX, (ctx) =>
      createJob(ctx, { kind: "csv_export", label: "Kontakte CSV", params: {}, total: 1 }),
    );
    await t.model(OWNER_CTX, (ctx) => advanceJob(ctx, ok, { status: "running" }));
    await t.model(OWNER_CTX, (ctx) => finishJob(ctx, ok, { name: "kontakte.csv", sha256: "a".repeat(64), bytes: 10 }));
    const bad = await t.model(OWNER_CTX, (ctx) =>
      createJob(ctx, { kind: "csv_export", label: "Produkte CSV", params: {}, total: 1 }),
    );
    await t.model(OWNER_CTX, (ctx) => failJob(ctx, bad, "Fehler bei Kunde Erika"));
    expect(await outboxTypes(t)).toEqual(["export.completed", "job.failed"]);
    expect(objectOf((await outboxOf(t, "export.completed"))[0])).toMatchObject({
      id: `job_${ok}`,
      kind: "csv_export",
      status: "done",
      result_sha256: "a".repeat(64),
    });
    expect(JSON.stringify(await outbox(t))).not.toContain("Erika");
  });

  test("API-030 time_entry.created and project.budget_threshold (once per threshold), no descriptions", async () => {
    const t = makeT();
    const s = await setupInvoicing(t);
    const { personId } = await b2bBuyer(s.owner);
    await subscribeHook(s.owner, ["time_entry.created", "project.budget_threshold"]);
    const { id: projectId } = await s.owner.mutation(api.projects.create, {
      values: {
        ...emptyProjectForm(),
        name: "Relaunch",
        hourlyRate: "90,00",
        contactId: personId,
        budgetKind: "hours",
        budgetValue: "10",
      },
    });
    const log = (date: string, duration: string) =>
      s.owner.mutation(api.timeEntries.create, {
        values: { ...emptyTimeEntryForm(date), duration, description: "Konzept für Erika", projectId },
      });
    await log("2026-10-01", "8h");
    await log("2026-10-02", "1h");
    expect(await outboxTypes(t)).toEqual(["time_entry.created", "project.budget_threshold", "time_entry.created"]);
    expect(objectOf((await outboxOf(t, "project.budget_threshold"))[0])).toMatchObject({
      id: `prj_${projectId}`,
      threshold_bp: 8000,
    });
    expect(objectOf((await outboxOf(t, "time_entry.created"))[0])).toMatchObject({
      object: "time_entry",
      duration_minutes: 480,
    });
    expect(JSON.stringify(await outbox(t))).not.toContain("Erika");
  });
});

describe("F12 security and privacy events (AUD-015, EC-186)", () => {
  test("AUD-015 a failed integrity run emits integrity.check_failed; it reaches `*` endpoints", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await subscribeHook(owner, ["*"]);
    await owner.action(api.webhooks.create, {
      values: { url: "https://n8n.example.org/hook", events: ["invoice.paid"] },
    });
    await t.asSystem("cron.integrity.verify").model((ctx) =>
      recordIntegrityRun(ctx, {
        scope: "full",
        lastVerifiedSeq: 4,
        findings: [{ kind: "hash_mismatch", severity: "error", detail: "seq 5", firstBrokenSeq: 5 }],
      }),
    );
    const [ev] = await outboxOf(t, "integrity.check_failed");
    expect(objectOf(ev)).toMatchObject({
      object: "integrity_run",
      findings: [{ kind: "hash_mismatch", first_broken_seq: 5 }],
    });
    const deliveries = await t.run((ctx) => ctx.db.query("webhookDeliveries").collect());
    expect(deliveries.map((d) => d.type)).toEqual(["integrity.check_failed"]); // only the `*` endpoint
  });

  test("EC-186 revoking an API key emits api_key.revoked to `*` endpoints", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await subscribeHook(owner, ["*"]);
    const key = await t.asApiKey(["contacts:read"], { name: "Website" });
    const keyRow = await t.run(async (ctx) =>
      ctx.db
        .query("apiKeys")
        .withIndex("by_prefix", (q) => q.eq("prefix", key.prefix))
        .unique(),
    );
    await owner.mutation(api.apiKeys.revoke, { keyId: keyRow?._id as Id<"apiKeys">, reason: "geleakt" });
    const [ev] = await outboxOf(t, "api_key.revoked");
    expect(objectOf(ev)).toMatchObject({ id: key.prefix, object: "api_key", name: "Website" });
    expect(JSON.stringify(ev)).not.toContain(key.key);
  });

  test("API-030 member.invited and member.removed carry the role, never the e-mail address", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await subscribeHook(owner, ["member.invited", "member.removed"]);
    await owner.mutation(api.invites.create, { email: "neu@example.test", role: "viewer" });
    const viewer = await t.asUser("viewer");
    await owner.mutation(api.members.disable, { memberId: viewer.memberId as Id<"members">, reason: "ausgeschieden" });
    expect(await outboxTypes(t)).toEqual(["member.invited", "member.removed"]);
    expect(objectOf((await outboxOf(t, "member.invited"))[0])).toMatchObject({ object: "invite", role: "viewer" });
    expect(objectOf((await outboxOf(t, "member.removed"))[0])).toMatchObject({ role: "viewer", reason: "disabled" });
    expect(JSON.stringify(await outbox(t))).not.toContain("example.test");
  });

  test("API-030 an overdue DSGVO request emits dsgvo.request_overdue once; a stale backup emits backup.stale", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await subscribeHook(owner, ["dsgvo.request_overdue", "backup.stale"]);
    await owner.mutation(api.dsgvo.create, {
      subject: { name: "Erika Mustermann", email: "erika@example.test" },
      kind: "access",
      channel: "email",
      receivedAt: "2026-10-01",
    });
    vi.setSystemTime(new Date("2026-11-03T08:00:00Z"));
    await t.mutation(internal.dsgvo.deadlinesCron, { force: true });
    await t.mutation(internal.dsgvo.deadlinesCron, { force: true });
    await t.mutation(internal.backups.recordCheck, { status: "error", detail: "Letzte Sicherung älter als 26 h" });
    expect(await outboxTypes(t)).toEqual(["dsgvo.request_overdue", "backup.stale"]);
    expect(objectOf((await outboxOf(t, "dsgvo.request_overdue"))[0])).toMatchObject({ due_at: "2026-11-02" });
    expect(JSON.stringify(await outbox(t))).not.toContain("Erika");
  });
});
