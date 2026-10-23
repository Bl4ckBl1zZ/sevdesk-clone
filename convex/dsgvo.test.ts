import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatCents } from "../src/domain/money/format";
import { ABLAUFHEMMUNG_ITEMS, PURGE_PHRASE } from "../src/domain/privacy/purge";
import { clearInvariantTarget } from "../test/invariants";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createValues, personForm } from "./catalog.fixtures";
import { dunningSetup } from "./dunning.fixtures";
import { enc, ingest } from "./inbox.fixtures";
import { finalizedInvoice, invoiceValues, settle } from "./invoices.fixtures";
import { memoryCheckpointObjects } from "./lib/checkpointStore";
import { makeT } from "./test.setup";

/** F12 PRV-010…PRV-014, F02 CON-162…CON-165, DSGVO-02/03, EC-180: register, erasure, restriction, access export. */

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}
const CHECKLIST = Object.fromEntries(ABLAUFHEMMUNG_ITEMS.map((i) => [i.id, true]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
  memoryCheckpointObjects.clear();
});
afterEach(() => {
  vi.useRealTimers();
  memoryCheckpointObjects.clear();
});

describe("F12 §5.4 erasure and subject edge cases", { timeout: 60_000 }, () => {
  test("E-PRV-10 erasure for a contact with open receivables: restricted, the owner is warned, dunning stays possible", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const owner = s.owner;
    const id = await owner.mutation(api.dsgvo.create, {
      contactId: s.contactId,
      kind: "erasure",
      channel: "email",
      receivedAt: "2026-10-12",
    });
    const p = await owner.query(api.dsgvo.preview, { contactId: s.contactId });
    expect(p.openReceivablesCents).toBeGreaterThan(0);
    expect(p.receivablesNotice).toBe(
      `Offene Forderungen (${formatCents(p.openReceivablesCents)} €) dürfen weiter verfolgt werden (Art. 18 Abs. 2 DSGVO).`,
    );
    await owner.mutation(api.dsgvo.verify, { id, method: "Rückruf unter bekannter Nummer" });
    await owner.mutation(api.dsgvo.execute, { id });
    const c = await t.run((ctx) => ctx.db.get(s.contactId));
    expect(c?.dsgvo?.restrictedAt).toBeTypeOf("number");
    // the claim may still be pursued: a reminder for the open invoice can be created and finalised
    vi.setSystemTime(new Date("2026-10-19T08:00:00Z"));
    const later = await t.asUser("owner", { existingUserId: owner.userId });
    const { id: reminderId } = await later.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    await later.mutation(api.dunning.finalize, { id: reminderId as Id<"salesDocuments"> });
    const reminder = await t.run((ctx) => ctx.db.get(reminderId as Id<"salesDocuments">));
    expect(reminder).toMatchObject({ type: "reminder", status: "finalized" });
    // … while a new invoice for the restricted contact stays blocked (E-PRV-11)
    expect(
      dataOf(await catching(later.mutation(api.invoices.createDraft, { values: invoiceValues(s.contactId) }))).message,
    ).toBe("Kontakt ist gesperrt (DSGVO Art. 18) und kann nicht verwendet werden.");
  });

  test("E-PRV-16 a data subject who is no contact is registered freely and found by e-mail across contacts, channels and the inbox", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    await f.owner.mutation(api.contacts.saveChannel, {
      contactId: f.orgId,
      values: {
        type: "email",
        value: "Erika.Muster@Lieferant.example",
        label: "Ansprechpartnerin",
        isPrimary: false,
        isInvoiceEmail: false,
      },
    });
    // a supplier e-mail that names her as contact person
    const { id: itemId } = await ingest(t, f.owner, [{ bytes: enc("%PDF-1.4 Rechnung"), name: "rechnung.pdf" }]);
    await t.run((ctx) =>
      ctx.db.patch(itemId, {
        from: "buchhaltung@lieferant.example",
        mailText: "Ansprechpartnerin: erika.muster@lieferant.example",
      }),
    );
    clearInvariantTarget(); // the mail fields are seeded directly

    const reqId = await f.owner.mutation(api.dsgvo.create, {
      subject: { name: "Erika Muster", email: "erika.muster@lieferant.example" },
      kind: "access",
      channel: "email",
      receivedAt: "2026-10-12",
    });
    expect((await f.owner.query(api.dsgvo.list, {})).find((r) => r.id === reqId)).toMatchObject({
      subject: "Erika Muster",
      contactId: null,
    });
    const hits = await f.owner.query(api.dsgvo.searchSubject, { email: " ERIKA.MUSTER@lieferant.example " });
    expect(hits.map((h) => h.kind).sort()).toEqual(["contactChannel", "inboxItem"]);
    expect(hits.find((h) => h.kind === "contactChannel")?.contactId).toBe(f.orgId);
    expect(await f.owner.query(api.dsgvo.searchSubject, { email: "niemand@example.test" })).toEqual([]);
    const bookkeeper = await t.asUser("bookkeeper");
    expect(
      dataOf(await catching(bookkeeper.query(api.dsgvo.searchSubject, { email: "erika.muster@lieferant.example" })))
        .code,
    ).toBe("forbidden_role");
  });
});

describe("receivable letters and learned bank aliases in the DSGVO flows (PRV-011, PRV-013)", {
  timeout: 60_000,
}, () => {
  test("PRV-011 PRV-013 a customer's account statement is retained (letters6) and exported as PDF; the learned bank alias is erased", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const contactId = f.personId as Id<"contacts">;
    await f.owner.mutation(api.payments.recordForInvoice, {
      documentId: f.id as Id<"salesDocuments">,
      source: { kind: "cash" },
      date: "2026-10-12",
      amountCents: 50_000,
    });
    const { letterId } = await f.owner.action(api.payments.letter, {
      request: { kind: "account_statement", contactId, from: "2026-10-01", to: "2026-10-12" },
    });
    const aliasId = await t.run((ctx) =>
      ctx.db.insert("contactAliases", {
        contactId,
        token: "erika muster",
        iban: "DE02120300000000202051",
        source: "match_confirmed",
        createdAt: Date.now(),
      }),
    );
    clearInvariantTarget(); // the BNK-048 alias is seeded directly

    const p = await f.owner.query(api.dsgvo.preview, { contactId });
    expect(p.restrict).toContainEqual(
      expect.objectContaining({
        kind: "receivableLetter",
        id: letterId,
        retentionClass: "letters6",
        retentionUntil: "2032-12-31",
      }),
    );
    expect(p.deleteNow).toContainEqual(expect.objectContaining({ kind: "contactAliases", id: aliasId }));

    // Art. 15: the letter PDF and its metadata are part of the access export
    const access = await f.owner.mutation(api.dsgvo.create, {
      contactId,
      kind: "access",
      channel: "email",
      receivedAt: "2026-10-12",
    });
    const { jobId } = await f.owner.mutation(api.dsgvo.startExport, { id: access });
    await settle(t);
    const job = await t.run((ctx) => ctx.db.get(jobId as Id<"jobs">));
    const buf = await t.run(async (ctx) =>
      (await ctx.storage.get(job?.resultStorageId as Id<"_storage">))?.arrayBuffer(),
    );
    const zip = unzipSync(new Uint8Array(buf as ArrayBuffer));
    expect(new TextDecoder().decode(zip["belege/Kontoauszug-2026-10-12.pdf"]?.subarray(0, 5))).toBe("%PDF-");
    const daten = JSON.parse(new TextDecoder().decode(zip["daten.json"]));
    expect(daten.letters).toEqual([
      expect.objectContaining({
        id: letterId,
        kind: "account_statement",
        date: "2026-10-12",
        title: "Kontoauszug",
        sentOn: null,
      }),
    ]);

    // Art. 17: the alias goes now, the letter stays restricted until its retention ends
    const erasure = await f.owner.mutation(api.dsgvo.create, {
      contactId,
      kind: "erasure",
      channel: "email",
      receivedAt: "2026-10-12",
    });
    await f.owner.mutation(api.dsgvo.verify, { id: erasure, method: "Rückruf unter bekannter Nummer" });
    await f.owner.mutation(api.dsgvo.execute, { id: erasure });
    expect(await t.run((ctx) => ctx.db.get(aliasId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(letterId))).not.toBeNull();
  });

  test("PRV-011 learned supplier defaults, duplicate hints, merge undo data, a recurring supplier voucher (with its reference file) and a running timer are erased; a manual entry naming the contact is retained (books10)", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const contactId = f.personId as Id<"contacts">;
    const referenceId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["%PDF-1.4 Mietvertrag"], { type: "application/pdf" })),
    );
    const seeded = await t.run(async (ctx) => ({
      profile: await ctx.db.insert("supplierProfiles", {
        key: "erika muster",
        contactId,
        lastAccount: "4930",
        uses: 3,
        accountStreak: 3,
        updatedAt: Date.now(),
      }),
      dismissed: await ctx.db.insert("dismissedDuplicates", {
        a: contactId,
        b: f.orgId as Id<"contacts">,
        at: Date.now(),
        actor: f.owner.actor,
      }),
      timer: await ctx.db.insert("runningTimer", { startedAt: Date.now(), contactId, startedVia: "ui" }),
      merge: await ctx.db.insert("contactMerges", {
        winnerId: contactId,
        loserId: f.orgId as Id<"contacts">,
        moved: [],
        fieldChoices: {},
        restore: { winner: { notes: "alte Notiz zu Erika" }, loserStatus: "archived" },
        at: Date.now(),
        actor: f.owner.actor,
      }),
      recurring: await ctx.db.insert("recurringVouchers", {
        name: "Miete Muster",
        template: {
          direction: "expense",
          kind: "standard",
          supplierContactId: contactId,
          currency: "EUR",
          priceMode: "gross",
          taxRule: "no_input_vat",
          lines: [{ account: "4210", amountCents: 50_000, vatRateBp: 0 }],
        },
        interval: "P1M",
        firstDate: "2026-11-01",
        nextDate: "2026-11-01",
        active: true,
        createAs: "draft",
        referenceFile: {
          storageId: referenceId,
          sha256: "0".repeat(64),
          bytes: 22,
          mime: "application/pdf",
          name: "mietvertrag.pdf",
        },
        lastGeneratedIds: [],
        actor: f.owner.actor,
        version: 1,
      }),
      manual: await ctx.db.insert("manualEntries", {
        date: "2026-10-12",
        text: "Ausbuchung Kleinbetrag",
        lines: [
          { account: "1400", debitCents: 0, creditCents: 100, contactId },
          { account: "6930", debitCents: 100, creditCents: 0 },
        ],
        attachments: [],
        recordedAt: Date.now(),
        actor: f.owner.actor,
      }),
    }));
    clearInvariantTarget(); // seeded directly

    const p = await f.owner.query(api.dsgvo.preview, { contactId });
    expect(p.deleteNow.map((i) => i.kind)).toEqual(
      expect.arrayContaining([
        "supplierProfiles",
        "dismissedDuplicates",
        "runningTimer",
        "contactMerges",
        "recurringVouchers",
      ]),
    );
    expect(p.restrict).toContainEqual(
      expect.objectContaining({
        kind: "manualEntry",
        id: seeded.manual,
        retentionClass: "books10",
        retentionUntil: "2036-12-31",
      }),
    );
    const id = await f.owner.mutation(api.dsgvo.create, {
      contactId,
      kind: "erasure",
      channel: "email",
      receivedAt: "2026-10-12",
    });
    await f.owner.mutation(api.dsgvo.verify, { id, method: "Rückruf unter bekannter Nummer" });
    await f.owner.mutation(api.dsgvo.execute, { id });
    for (const gone of [seeded.profile, seeded.dismissed, seeded.timer, seeded.merge, seeded.recurring]) {
      expect(await t.run((ctx) => ctx.db.get(gone))).toBeNull();
    }
    expect(await t.run((ctx) => ctx.storage.get(referenceId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(seeded.manual))).not.toBeNull();
  });
});

describe("DSGVO register (PRV-010)", { timeout: 60_000 }, () => {
  test("PRV-010 E-PRV-12 E-PRV-13 E-PRV-15 a request is due in one month, extensions need a notice date, completion needs identity, overdue notifies", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const id = await f.owner.mutation(api.dsgvo.create, {
      subject: { name: "Erika Mustermann", email: "erika@example.test" },
      kind: "access",
      channel: "email",
      receivedAt: "2026-10-01",
    });
    let [row] = await f.owner.query(api.dsgvo.list, {});
    expect(row).toMatchObject({ dueAt: "2026-11-02", status: "open", kindLabel: "Auskunft (Art. 15)" }); // 01.11. is a Sunday
    expect(dataOf(await catching(f.owner.mutation(api.dsgvo.setRequestStatus, { id, to: "done" }))).message).toBe(
      "Identität der anfragenden Person ist nicht bestätigt.",
    );
    expect(
      dataOf(
        await catching(f.owner.mutation(api.dsgvo.extend, { id, months: 2, reason: "umfangreich", noticeSentOn: "" })),
      ).message,
    ).toBe("Bitte Datum der Mitteilung an die betroffene Person angeben (Art. 12 Abs. 3 DSGVO).");
    await f.owner.mutation(api.dsgvo.extend, { id, months: 1, reason: "umfangreich", noticeSentOn: "2026-10-10" });
    [row] = await f.owner.query(api.dsgvo.list, {});
    expect(row).toMatchObject({ status: "extended", dueAt: "2026-12-01" });

    vi.setSystemTime(new Date("2026-12-02T08:00:00Z"));
    expect(await t.mutation(internal.dsgvo.deadlinesCron, { force: true })).toBe(1);
    const ntf = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(ntf.find((n) => n.kind === "dsgvo.overdue")).toMatchObject({
      severity: "error",
      title: "DSGVO-Anfrage von Erika Mustermann ist seit 01.12.2026 überfällig.",
    });
    expect(await t.mutation(internal.dsgvo.deadlinesCron, { force: true })).toBe(0); // once per stage
    const owner = await t.asUser("owner", { existingUserId: f.owner.userId });
    [row] = await owner.query(api.dsgvo.list, {});
    expect(row?.overdue).toBe(true);
    await owner.mutation(api.dsgvo.verify, { id, method: "Rückruf unter bekannter Nummer" });
    await owner.mutation(api.dsgvo.setRequestStatus, { id, to: "done" });
  });

  test("CON-165 DSGVO actions are owner-only: bookkeeper → forbidden_role, API key / MCP → forbidden_scope", async () => {
    const t = makeT();
    await t.asUser("owner");
    const args = {
      subject: { name: "X" },
      kind: "erasure" as const,
      channel: "email" as const,
      receivedAt: "2026-10-01",
    };
    const bk = await t.asUser("bookkeeper");
    expect(dataOf(await catching(bk.mutation(api.dsgvo.create, args))).code).toBe("forbidden_role");
    const key = await t.asApiKey(["contacts:write", "settings:write", "settings:read"]);
    expect(dataOf(await catching(key.mutation(api.dsgvo.create, args))).code).toBe("forbidden_scope");
    const mcp = await t.asMcp(["contacts:write"]);
    expect(dataOf(await catching(mcp.mutation(api.dsgvo.create, args))).code).toBe("forbidden_scope");
    // the register itself is readable with settings:read (F12 §7), never the auditor
    expect(await key.query(api.dsgvo.list, {})).toEqual([]);
    const auditor = await t.asUser("auditor", { auditor: { purpose: "Az 1", fiscalYears: [2026] } });
    expect(dataOf(await catching(auditor.query(api.dsgvo.list, {}))).code).toBe("forbidden_role");
  });
});

describe("erasure and restriction (PRV-011, PRV-012, DSGVO-02, CON-162, EC-180)", { timeout: 60_000 }, () => {
  test("DSGVO-02 CON-162 PRV-011 PRV-012 EC-180 E-PRV-09 E-PRV-11 notes and drafts go, the contact is restricted with the purge date, new documents are blocked, lists hide it", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const contactId = f.personId;
    await f.owner.mutation(api.contacts.addActivity, {
      contactId,
      values: { kind: "note", text: "Rückruf erbeten", dueOn: "" },
    } as never);
    const draft = await f.owner.mutation(api.invoices.createDraft, { values: invoiceValues(contactId) });
    const id = await f.owner.mutation(api.dsgvo.create, {
      contactId,
      kind: "erasure",
      channel: "email",
      receivedAt: "2026-10-10",
    });

    const p = await f.owner.query(api.dsgvo.preview, { contactId });
    expect(p.deleteNow.map((x) => x.kind)).toEqual(expect.arrayContaining(["contactActivities", "salesDocuments"]));
    expect(p.restrict.map((x) => x.kind)).toEqual(expect.arrayContaining(["salesDocument", "journalEntry"]));
    // 2026 invoice → 2035-01-01 (8 y), its journal entry → 2037-01-01 (10 y) — staged purge (F12 open item 4)
    expect(p.byClass).toMatchObject({ vouchers8: "2035-01-01", books10: "2037-01-01" });
    expect(p.scheduledPurgeAt).toBe("2037-01-01");
    expect(p.deleteContact).toBe(false);

    expect(dataOf(await catching(f.owner.mutation(api.dsgvo.execute, { id }))).message).toBe(
      "Identität der anfragenden Person ist nicht bestätigt.",
    );
    await f.owner.mutation(api.dsgvo.verify, { id, method: "E-Mail von der bekannten Adresse" });
    const r = await f.owner.mutation(api.dsgvo.execute, { id });
    expect(r).toMatchObject({ contactDeleted: false, scheduledPurgeAt: "2037-01-01" });
    expect(await t.run((ctx) => ctx.db.get(draft.id as Id<"salesDocuments">))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(f.id as Id<"salesDocuments">))).not.toBeNull(); // retained
    const c = await t.run((ctx) => ctx.db.get(contactId));
    expect(c?.dsgvo).toMatchObject({ scheduledPurgeAt: "2037-01-01" });
    expect(c?.dsgvo?.restrictedAt).toBeTypeOf("number");
    // bucket-1 deletions are audited with a hash only (no note text in the log)
    const log = JSON.stringify(await t.run((ctx) => ctx.db.query("auditLog").collect()));
    const eraseEntries = (await t.run((ctx) => ctx.db.query("auditLog").collect())).filter(
      (e) => e.action === "dsgvo.erase",
    );
    expect(eraseEntries.length).toBeGreaterThan(0);
    expect(JSON.stringify(eraseEntries)).not.toContain("Rückruf erbeten");
    expect(log).toContain("contentSha256");

    // E-PRV-11 / PRV-012: no new documents, hidden from lists and pickers
    expect(
      dataOf(await catching(f.owner.mutation(api.invoices.createDraft, { values: invoiceValues(contactId) }))).message,
    ).toBe("Kontakt ist gesperrt (DSGVO Art. 18) und kann nicht verwendet werden.");
    const listed = await f.owner.query(api.contacts.list, { paginationOpts: { numItems: 50, cursor: null } });
    expect(listed.page.map((x) => x._id)).not.toContain(contactId);
    // REST/MCP: invisible; GET by id → 410 minimal data unless audit:read
    const key = await t.asApiKey(["contacts:read"]);
    expect(await key.query(api.contactsApi.get, { id: contactId })).toBeNull();
    expect(await key.query(api.contactsApi.restrictedInfo, { id: contactId })).toMatchObject({
      restricted: true,
      number: c?.number,
    });
    const auditKey = await t.asApiKey(["contacts:read", "audit:read"]);
    expect((await auditKey.query(api.contactsApi.get, { id: contactId }))?.contact._id).toBe(contactId);
    // the letter explains the retention (Art. 17 Abs. 3 lit. b)
    const letter = await f.owner.query(api.dsgvo.letter, { id });
    expect(letter).toContain("Art. 17 Abs. 3 lit. b DSGVO");
    expect(letter).toContain("01.01.2037");
  });

  test("E-PRV-18 a prospect without documents is deleted completely (hash-audited, key shredded)", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const p = await f.owner.mutation(api.contacts.create, {
      values: createValues(personForm("Paula", "Prospekt"), { email: "paula@example.test" }),
    });
    const contactId = p.id as Id<"contacts">;
    const id = await f.owner.mutation(api.dsgvo.create, {
      contactId,
      kind: "erasure",
      channel: "phone",
      receivedAt: "2026-10-11",
    });
    await f.owner.mutation(api.dsgvo.verify, { id, method: "Rückruf" });
    expect(await f.owner.mutation(api.dsgvo.execute, { id })).toMatchObject({ contactDeleted: true });
    expect(await t.run((ctx) => ctx.db.get(contactId))).toBeNull();
    const del = (await t.run((ctx) => ctx.db.query("auditLog").collect())).find(
      (e) => e.action === "dsgvo.erase" && e.entity.table === "contacts",
    );
    expect(JSON.stringify(del?.diff)).not.toContain("Prospekt");
  });

  test("CON-163 PRV-007 at the purge date the restricted contact is anonymised by the manual purge; journal lines lose the link", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const contactId = f.personId;
    const id = await f.owner.mutation(api.dsgvo.create, {
      contactId,
      kind: "erasure",
      channel: "email",
      receivedAt: "2026-10-10",
    });
    await f.owner.mutation(api.dsgvo.verify, { id, method: "E-Mail" });
    await f.owner.mutation(api.dsgvo.execute, { id });

    vi.setSystemTime(new Date("2037-01-02T10:00:00Z"));
    const owner = await t.asUser("owner", { existingUserId: f.owner.userId });
    const w = await owner.query(api.retention.worklist, {});
    expect(w.contacts).toContainEqual(
      expect.objectContaining({ id: contactId, scheduledPurgeAt: "2037-01-01", blockedBy: 0 }),
    );
    await owner.mutation(api.retention.startPurge, {
      classes: ["vouchers8", "books10", "contacts"],
      years: [],
      checklist: CHECKLIST,
      phrase: PURGE_PHRASE,
    });
    await settle(t);
    const c = await t.run((ctx) => ctx.db.get(contactId));
    expect(c?.displayName).toBe(`Gelöschter Kontakt ${c?.number}`);
    expect(c?.firstName).toBeUndefined();
    const key = await t.run((ctx) =>
      ctx.db
        .query("contactKeys")
        .withIndex("by_contact", (q) => q.eq("contactId", contactId))
        .first(),
    );
    if (key) expect(key.shreddedAt).toBeTypeOf("number");
    const lines = await t.run((ctx) =>
      ctx.db
        .query("journalLines")
        .withIndex("by_contact", (q) => q.eq("contactId", contactId))
        .collect(),
    );
    expect(lines).toEqual([]);
    const tomb = await t.run((ctx) =>
      ctx.db
        .query("purgeTombstones")
        .withIndex("by_record", (q) => q.eq("table", "contacts").eq("recordId", contactId))
        .first(),
    );
    expect(tomb?.label).toBe(c?.number);
  });
});

describe("access export (PRV-013, CON-164, DSGVO-03)", { timeout: 60_000 }, () => {
  test("PRV-013 CON-164 DSGVO-03 E-PRV-17 the ZIP holds daten.json, the invoice PDFs and auskunft.pdf; third-party e-mails are masked; audited", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    const contactId = f.personId;
    await f.owner.mutation(api.contacts.addActivity, {
      contactId,
      values: { kind: "note", text: "CC an kollegin@fremd.test", dueOn: "" },
    } as never);
    const id = await f.owner.mutation(api.dsgvo.create, {
      contactId,
      kind: "access",
      channel: "email",
      receivedAt: "2026-10-10",
    });
    const { jobId } = await f.owner.mutation(api.dsgvo.startExport, { id });
    await settle(t);
    const job = await t.run((ctx) => ctx.db.get(jobId as Id<"jobs">));
    expect(job?.status).toBe("done");
    const buf = await t.run(async (ctx) =>
      (await ctx.storage.get(job?.resultStorageId as Id<"_storage">))?.arrayBuffer(),
    );
    const zip = unzipSync(new Uint8Array(buf as ArrayBuffer));
    const daten = JSON.parse(new TextDecoder().decode(zip["daten.json"]));
    expect(daten.art).toBe("Art. 15 DSGVO");
    expect(daten.documents.map((d: { number: string }) => d.number)).toContain(f.number);
    expect(JSON.stringify(daten)).toContain("k***@fremd.test");
    expect(JSON.stringify(daten)).not.toContain("kollegin@fremd.test");
    expect(Object.keys(zip).some((k) => k.startsWith("belege/") && k.endsWith(".pdf"))).toBe(true);
    expect(new TextDecoder().decode(zip["auskunft.pdf"]?.subarray(0, 5))).toBe("%PDF-");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((e) => e.action === "export.dsgvo")?.actor).toBe(f.owner.actor);
  });
});
