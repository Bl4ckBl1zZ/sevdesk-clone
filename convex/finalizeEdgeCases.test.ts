import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import { normalizeNumber } from "../src/domain/numbering/format";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BERLIN, createValues, orgForm, personForm } from "./catalog.fixtures";
import { b2bBuyer, finalizedInvoice, INVOICE_RANGE, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert, auditedPatch } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { assignCounterNumber } from "./model/numberRanges";
import { loadDocumentContext } from "./model/salesDocuments";
import { makeT, type TestT } from "./test.setup";

/**
 * F04 §5.2 edge cases of the finalisation pipeline, numbering, dispatch and the Storno against the database
 * (T-EC-001…116, convex part). The commit transaction re-reads everything (EC-004); errors before it consume no number.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const findingCodes = (e: unknown) => ((dataOf(e).findings ?? []) as { code: string }[]).map((f) => f.code);
const doc = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => {
    const d = await ctx.db.get(id);
    if (!d) throw new Error("missing");
    return d;
  });
const invoiceNumbers = (t: TestT) =>
  t.run(async (ctx) =>
    (await ctx.db.query("numberRegister").collect()).filter((r) => r.docType === "invoice").map((r) => r.number),
  );
const snapshotOf = async (t: TestT, id: Id<"salesDocuments">) => {
  const d = await doc(t, id);
  const s = await t.run((ctx) => (d.snapshotId ? ctx.db.get(d.snapshotId) : null));
  return JSON.parse(s?.json ?? "null") as DocumentSnapshot;
};
const OWNER_ACTOR = (actor: string) => ({ actor, role: "owner", channel: "ui" }) as const;

describe("commit re-validation (EC-DOC-01, EC-DOC-02, EC-DOC-08)", () => {
  test("EC-DOC-01 T-EC-001 company data changed between preview and commit → nothing committed; the commit reads fresh data", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    expect((await owner.query(api.invoices.finalizeCheck, { id }))?.check?.canFinalize).toBe(true);
    // the managing director is removed while the preview is open
    await t.model(OWNER_ACTOR(owner.actor), (ctx) =>
      patchCompanyProfile(ctx, { representatives: [] }, { action: "settings.company.update" }),
    );
    const r = await t.mutation(internal.invoices.commit, {
      actorContext: OWNER_ACTOR(owner.actor),
      id,
      version: 1,
      validation: "not_required",
    });
    expect(r.status).toBe("invalid");
    expect((r as { findings: { code: string }[] }).findings.map((f) => f.code)).toContain("geschaeftsbrief_incomplete");
    const d = await doc(t, id);
    expect(d.status).toBe("draft");
    expect(d.snapshotId).toBeUndefined();
    expect(await invoiceNumbers(t)).toEqual([]);
    expect(await t.run(async (ctx) => (await ctx.db.query("documentSnapshots").collect()).length)).toBe(0);
  });

  test("EC-DOC-02 T-EC-002 the contact switched to consumer after the preview → revalidation, nothing committed; a VAT-ID edit lands in the snapshot", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const person = await owner.mutation(api.contacts.create, {
      values: createValues(personForm("Paul", "Pauschal"), { address: { ...BERLIN }, email: "paul@example.org" }),
    });
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(person.id) });
    const preview = await owner.query(api.invoices.finalizeCheck, { id });
    expect(preview?.check?.taxCase).toBe("domestic");
    const c = await owner.query(api.contacts.get, { id: person.id as Id<"contacts"> });
    await owner.mutation(api.contacts.update, {
      id: person.id as Id<"contacts">,
      version: c?.contact.version ?? 1,
      values: personForm("Paul", "Pauschal", { isConsumer: true }),
    });
    const r = await t.mutation(internal.invoices.commit, {
      actorContext: OWNER_ACTOR(owner.actor),
      id,
      version: 1,
      validation: "not_required",
      expected: { taxCase: "domestic", buyerIsConsumer: false },
    });
    expect(r.status).toBe("invalid");
    expect((r as { findings: { code: string }[] }).findings.map((f) => f.code)).toEqual([
      "contact_changed_since_preview",
    ]);
    expect((await doc(t, id)).status).toBe("draft");
    expect(await invoiceNumbers(t)).toEqual([]);

    // a change that keeps tax case and price display: the commit uses the data it read (never a mixed snapshot)
    const { orgId, personId } = await b2bBuyer(owner);
    const second = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const org = await owner.query(api.contacts.get, { id: orgId });
    await owner.mutation(api.contacts.update, {
      id: orgId,
      version: org?.contact.version ?? 1,
      values: orgForm("Beispiel Kunde GmbH", { number: "K-10023", vatId: "DE136695976" }),
    });
    const ok = await t.mutation(internal.invoices.commit, {
      actorContext: OWNER_ACTOR(owner.actor),
      id: second.id,
      version: 1,
      validation: "not_required",
      expected: { taxCase: "domestic", buyerIsConsumer: false },
    });
    expect(ok.status).toBe("finalized");
    expect((await snapshotOf(t, second.id)).buyer.vatId).toBe("DE136695976");
    await settle(t);
  });

  test("EC-DOC-08 T-EC-008 the default range deactivated before the commit → number_range_missing, nothing committed", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    expect((await owner.query(api.invoices.finalizeCheck, { id }))?.check?.canFinalize).toBe(true);
    await t.model(OWNER_ACTOR(owner.actor), async (ctx) => {
      const range = (await ctx.db.query("numberRanges").collect()).find((r) => r.docTypes.includes("invoice"));
      if (!range) throw new Error("no range");
      await auditedPatch(
        ctx,
        "numberRanges",
        range._id,
        { active: false, isDefault: false },
        { action: "settings.number_range.deactivate", label: range.name },
      );
    });
    const r = await t.mutation(internal.invoices.commit, {
      actorContext: OWNER_ACTOR(owner.actor),
      id,
      version: 1,
      validation: "not_required",
    });
    expect((r as { findings: { code: string }[] }).findings.map((f) => f.code)).toContain("number_range_missing");
    const e = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x: unknown) => x);
    expect(findingCodes(e)).toContain("number_range_missing");
    expect((await doc(t, id)).status).toBe("draft");
  });
});

describe("numbering (EC-DOC-05, 06, 07, 09, 10)", () => {
  test("EC-DOC-05 T-EC-005 1,000 finalisation transactions on one counter yield 1,000 unique, consecutive numbers", {
    timeout: 120_000,
  }, async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const numbers = await Promise.all(
      Array.from({ length: 1_000 }, (_, i) =>
        t.model(
          OWNER_ACTOR(owner.actor),
          async (ctx) =>
            (
              await assignCounterNumber(ctx, {
                docType: "invoice",
                date: { year: 2026, month: 10 },
                documentId: `doc-${i}`,
                action: "document.finalize",
              })
            ).number,
        ),
      ),
    );
    expect(new Set(numbers).size).toBe(1_000);
    const counters = numbers.map((n) => Number(n.slice("RE-2026-".length))).sort((a, b) => a - b);
    expect(counters[0]).toBe(1);
    expect(counters.at(-1)).toBe(1_000);
    expect(counters.every((c, i) => c === i + 1)).toBe(true);
    expect(await invoiceNumbers(t)).toHaveLength(1_000);
  });

  test("EC-DOC-06 T-EC-006 RE-2026-9999 is followed by RE-2026-10000; the range warns from 90 %", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.settings.saveNumberRanges, {
      values: { ranges: [{ ...INVOICE_RANGE, next: 9_999, nextReason: "Übernahme aus Altsystem" }] },
    });
    const ranges = await owner.query(api.settings.listNumberRanges, {});
    expect(ranges.find((r) => r.docTypes.includes("invoice"))?.capacityWarning).toBe(
      "Der Zähler erreicht bald 9999; danach werden die Nummern eine Stelle länger.",
    );
    const { personId } = await b2bBuyer(owner);
    const a = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const b = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    expect((await owner.action(api.invoices.finalize, { id: a.id, version: 1 })).number).toBe("RE-2026-9999");
    expect((await owner.action(api.invoices.finalize, { id: b.id, version: 1 })).number).toBe("RE-2026-10000");
    expect(new Set((await invoiceNumbers(t)).map(normalizeNumber)).size).toBe(2);
    await settle(t);
  });

  test("EC-DOC-07 T-EC-007 a format changed mid-year applies to future finalisations only", async () => {
    const t = makeT();
    const { owner, id, personId } = await finalizedInvoice(t);
    await owner.mutation(api.settings.saveNumberRanges, {
      values: { ranges: [{ ...INVOICE_RANGE, format: "RG{YYYY}-{#####}", next: 2 }] },
    });
    const next = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    expect((await owner.action(api.invoices.finalize, { id: next.id, version: 1 })).number).toBe("RG2026-00002");
    expect((await doc(t, id)).number).toBe("RE-2026-0001");
    expect((await snapshotOf(t, id)).number).toBe("RE-2026-0001");
    await settle(t);
  });

  test("EC-DOC-09 T-EC-009 a 2026-12-31 draft finalised on 2027-01-02 takes the 2027 counter; backdated to 2026-12-30 it continues 2026", async () => {
    const t = makeT();
    vi.setSystemTime(new Date("2026-12-31T10:00:00Z"));
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const values = invoiceValues(personId, { supplyDate: { kind: "date", date: "2026-12-30" as CalendarDate } });
    const first = await owner.mutation(api.invoices.createDraft, { values });
    expect((await owner.action(api.invoices.finalize, { id: first.id, version: 1 })).number).toBe("RE-2026-0001");
    const a = await owner.mutation(api.invoices.createDraft, { values });
    const b = await owner.mutation(api.invoices.createDraft, { values });
    vi.setSystemTime(new Date("2027-01-02T10:00:00Z"));
    const fresh = await t.asUser("owner", { existingUserId: owner.userId });
    const r = await fresh.action(api.invoices.finalize, { id: a.id, version: 1 });
    expect(r.number).toBe("RE-2027-0001");
    expect((await doc(t, a.id)).documentDate).toBe("2027-01-02");
    const back = await fresh.action(api.invoices.finalize, { id: b.id, version: 1, documentDate: "2026-12-30" });
    expect(back.number).toBe("RE-2026-0002");
    expect((await doc(t, b.id)).documentDate).toBe("2026-12-30");
    await settle(t);
  });

  test("EC-DOC-10 T-EC-010 a rendered number that collides with an imported sevdesk number → number_conflict, counter unchanged", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await t.model(OWNER_ACTOR(owner.actor), (ctx) =>
      auditedInsert(
        ctx,
        "numberRegister",
        {
          number: "RE-2026-0001",
          normalized: normalizeNumber("RE-2026-0001"),
          docType: "invoice",
          assignedAt: Date.now(),
          status: "issued",
          imported: true,
        },
        { action: "document.import", label: "RE-2026-0001" },
      ),
    );
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const e = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("number_conflict");
    expect((await doc(t, id)).status).toBe("draft");
    const range = (await owner.query(api.settings.listNumberRanges, {})).find((r) => r.docTypes.includes("invoice"));
    expect(range?.next).toBe(1);
  });
});

describe("finalisation details (EC-DOC-18, 46, 86, 97, 106)", () => {
  test("EC-DOC-18 T-EC-018 a supply older than 6 months is finalised; the audit entry notes the delay", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t, { supplyDate: { kind: "date", date: "2026-03-01" as CalendarDate } });
    expect((await doc(t, id)).status).toBe("finalized");
    const entries = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("auditLog")
          .withIndex("by_entity", (q) => q.eq("entity.table", "salesDocuments").eq("entity.id", id))
          .collect()
      ).filter((e) => e.action === "document.finalize"),
    );
    expect(entries.some((e) => /mehr als 6 Monate zurück \(Leistungsdatum 2026-03-01\)/.test(e.reason ?? ""))).toBe(
      true,
    );
  });

  test("EC-DOC-46 T-EC-046 a 0-€ standard invoice is finalised with total_zero and is paid at finalisation", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const base = invoiceValues(personId);
    const values = { ...base, lines: base.lines.map((l) => ({ ...l, unitPriceMicros: 0 })) };
    const { id } = await owner.mutation(api.invoices.createDraft, { values });
    const check = await owner.query(api.invoices.finalizeCheck, { id });
    expect(check?.check?.findings.find((f) => f.code === "total_zero")?.severity).toBe("W");
    await owner.action(api.invoices.finalize, { id, version: 1 });
    expect(await doc(t, id)).toMatchObject({ status: "finalized", paymentStatus: "paid", openAmountCents: 0 });
    await settle(t);
  });

  test("EC-DOC-86 the ER-03 context of a 2027 draft carries the running 2026 total as provisional when no figure is confirmed", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedInvoice(t);
    vi.setSystemTime(new Date("2027-02-01T10:00:00Z"));
    const fresh = await t.asUser("owner", { existingUserId: owner.userId });
    const { id } = await fresh.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { supplyDate: { kind: "date", date: "2027-01-31" as CalendarDate } }),
    });
    const company = await t.run(async (ctx) => {
      const d = await ctx.db.get(id);
      if (!d) throw new Error("missing");
      return (await loadDocumentContext(ctx, d, Date.now())).ctx.company;
    });
    expect(company.priorYearTurnover.find((x) => x.year === 2026)).toEqual({
      year: 2026,
      amountCents: 100_000,
      provisional: true,
    });
  });

  test("EC-DOC-97 T-EC-097 a closed bank account: issued documents keep the IBAN, drafts switch to the new default", async () => {
    const t = makeT();
    const { owner, id, personId, bankAccount } = await finalizedInvoice(t);
    const draft = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const second = (await owner.mutation(api.settings.addBankAccount, {
      values: {
        name: "Neues Konto",
        iban: "DE02 1203 0000 0000 2020 51",
        bic: "",
        accountHolder: "Muster Design GmbH",
        currency: "EUR",
      },
    })) as Id<"bankAccounts">;
    await owner.mutation(api.settings.setDefaultBankAccount, { bankAccountId: second });
    await owner.mutation(api.settings.archiveBankAccount, { bankAccountId: bankAccount });
    expect((await snapshotOf(t, id)).payment.bankAccount?.iban).toBe("DE89370400440532013000");
    await owner.action(api.invoices.finalize, { id: draft.id, version: 1 });
    expect((await snapshotOf(t, draft.id)).payment.bankAccount?.iban).toBe("DE02120300000000202051");
    await settle(t);
  });

  test("EC-DOC-106 T-EC-106 a draft of an archived contact is finalised with the warning „Kontakt ist archiviert“", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const person = await owner.mutation(api.contacts.create, {
      values: createValues(personForm("Anna", "Archiv"), { address: { ...BERLIN }, email: "anna@example.org" }),
    });
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(person.id) });
    await owner.mutation(api.contacts.archive, { id: person.id as Id<"contacts"> });
    const check = await owner.query(api.invoices.finalizeCheck, { id });
    expect(check?.check?.findings.find((f) => f.code === "contact_archived")).toMatchObject({
      severity: "W",
      message: "Kontakt ist archiviert.",
    });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    const s = await snapshotOf(t, id);
    expect(s.buyer).toMatchObject({ name: "Anna Archiv", address: { street: BERLIN.street, city: BERLIN.city } });
    await settle(t);
  });
});

describe("validator and artifacts (EC-DOC-81, EC-DOC-83)", () => {
  test("EC-DOC-81 T-EC-081 the e-invoice validator is unavailable: an XML invoice is refused before the commit; one without XML is finalised", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    vi.stubEnv("EINVOICE_TOOLS_URL", "https://einvoice-tools.test.local");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    const xml = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const e = await owner.action(api.invoices.finalize, { id: xml.id, version: 1 }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("dependency_unavailable");
    expect(await invoiceNumbers(t)).toEqual([]);
    const pdf = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { einvoiceFormat: "none" }),
    });
    expect((await owner.action(api.invoices.finalize, { id: pdf.id, version: 1 })).number).toBe("RE-2026-0001");
    expect((await doc(t, pdf.id)).einvoice).toMatchObject({ format: "none", validation: "not_required" });
  });

  test("EC-DOC-83 T-EC-083 archived artifacts are never regenerated (e.g. after a KoSIT bundle update)", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const before = (await owner.query(api.invoices.get, { id }))?.artifacts.map((a) => [a._id, a.sha256]);
    const e = await owner.mutation(api.invoices.retryArtifacts, { id }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("conflict");
    const after = (await owner.query(api.invoices.get, { id }))?.artifacts.map((a) => [a._id, a.sha256]);
    expect(after).toEqual(before);
    expect((await doc(t, id)).artifactStatus).toBe("ready");
  });
});

describe("dispatch (EC-DOC-112)", () => {
  test("EC-DOC-112 T-EC-112 an exported but unmarked invoice stays finalized: badge exported, no Zugang", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    await owner.action(api.documentArtifacts.exportFiles, { id, request: { entry: "default" } });
    const d = await doc(t, id);
    expect(d.status).toBe("finalized");
    expect(d.zugang).toBeUndefined();
    expect(d.sentOn).toBeUndefined();
    const row = (await owner.query(api.invoices.list, { paginationOpts: { numItems: 10, cursor: null } })).page[0];
    expect(row?.displayStatus.label).toBe("Nicht versendet");
    expect(row?.exported).toBe(true);
  });
});
