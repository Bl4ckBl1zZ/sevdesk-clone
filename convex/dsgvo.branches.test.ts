import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DSGVO_MESSAGES } from "../src/domain/privacy/dsgvo";
import { api, internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import { createValues, personForm, setupCatalog } from "./catalog.fixtures";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { accessExportData, responseLetter, startAccessExport } from "./model/dsgvo";
import { makeT, type TestT } from "./test.setup";

/** F12 PRV-010…PRV-014 / F02 CON-162…CON-165 — the refusals and optional paths of the DSGVO register and flows. */

const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);
async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}
const ghost = <T extends TableNames>(table: T) => `${"9".repeat(32 - table.length)}${table}` as Id<T>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function ownerWithContact(t: TestT, over: Parameters<typeof personForm>[2] = {}) {
  const owner = await setupCatalog(t);
  const created = await owner.mutation(api.contacts.create, {
    values: createValues(personForm("Paula", "Prospekt", over), { email: "paula@example.test" }),
  });
  return { owner, contactId: created.id as Id<"contacts"> };
}

const request = (owner: Awaited<ReturnType<TestT["asUser"]>>, args: Record<string, unknown> = {}) =>
  owner.mutation(api.dsgvo.create, {
    subject: { name: "Erika Muster" },
    kind: "access",
    channel: "email",
    receivedAt: "2026-10-12",
    ...args,
  } as never) as Promise<Id<"dsgvoRequests">>;

describe("DSGVO register refusals (PRV-010)", { timeout: 60_000 }, () => {
  test("PRV-010 a request needs a contact or a name, a valid past receipt date and an existing contact", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    expect(messageOf(await catching(request(owner, { subject: { name: "   " } })))).toBe(DSGVO_MESSAGES.subjectMissing);
    expect(messageOf(await catching(request(owner, { subject: undefined })))).toBe(DSGVO_MESSAGES.subjectMissing);
    const future = await catching(request(owner, { receivedAt: "2026-10-13" }));
    expect(errorCode(future)).toBe("invalid_input");
    expect(messageOf(future)).toBe("Bitte ein gültiges Eingangsdatum (nicht in der Zukunft) angeben.");
    expect(messageOf(await catching(request(owner, { receivedAt: "12.10.2026" })))).toBe(
      "Bitte ein gültiges Eingangsdatum (nicht in der Zukunft) angeben.",
    );
    const missing = await catching(request(owner, { contactId: ghost("contacts") }));
    expect(errorCode(missing)).toBe("not_found");
    expect(messageOf(missing)).toBe("Kontakt nicht gefunden.");
  });

  test("PRV-010 name, e-mail and notes are trimmed; an empty e-mail and empty notes are not stored", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const a = await request(owner, {
      subject: { name: "  Erika Muster ", email: "  erika@example.test " },
      notes: `  ${"n".repeat(2100)}  `,
    });
    const b = await request(owner, { subject: { name: "Max", email: "   " }, notes: "   " });
    const [ra, rb] = await t.run(async (ctx) => [await ctx.db.get(a), await ctx.db.get(b)]);
    expect(ra?.subject).toEqual({ name: "Erika Muster", email: "erika@example.test" });
    expect(ra?.notes?.length).toBe(2000);
    expect(rb?.subject).toEqual({ name: "Max" });
    expect(rb?.notes).toBeUndefined();
  });

  test("E-PRV-15 identity check needs a method; rejection needs a reason; finished requests cannot move or be extended", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const id = await request(owner);
    expect(messageOf(await catching(owner.mutation(api.dsgvo.verify, { id, method: "  " })))).toBe(
      "Bitte die Art der Identitätsprüfung angeben.",
    );
    await owner.mutation(api.dsgvo.setRequestStatus, { id, to: "in_progress" });
    expect(messageOf(await catching(owner.mutation(api.dsgvo.setRequestStatus, { id, to: "rejected" })))).toBe(
      DSGVO_MESSAGES.rejectionReason,
    );
    await owner.mutation(api.dsgvo.setRequestStatus, {
      id,
      to: "rejected",
      rejectionReason: "  offensichtlich unbegründet  ",
    });
    const r = await t.run((ctx) => ctx.db.get(id));
    expect(r).toMatchObject({ status: "rejected", rejectionReason: "offensichtlich unbegründet" });
    expect(r?.doneAt).toBeTypeOf("number");
    const again = await catching(owner.mutation(api.dsgvo.setRequestStatus, { id, to: "in_progress" }));
    expect(errorCode(again)).toBe("illegal_transition");
    expect(messageOf(again)).toBe(DSGVO_MESSAGES.transition);
    const ext = await catching(
      owner.mutation(api.dsgvo.extend, { id, months: 1, reason: "umfangreich", noticeSentOn: "2026-10-12" }),
    );
    expect(errorCode(ext)).toBe("illegal_transition");
    const unknown = await catching(owner.query(api.dsgvo.letter, { id: ghost("dsgvoRequests") }));
    expect(errorCode(unknown)).toBe("not_found");
    expect(messageOf(unknown)).toBe("Anfrage nicht gefunden.");
  });

  test("E-PRV-12 the list sorts by due date, names the contact and shows no stage for finished requests; the cron warns at due − 7", async () => {
    const t = makeT();
    const { owner, contactId } = await ownerWithContact(t);
    const later = await request(owner, { receivedAt: "2026-10-12" });
    const early = await request(owner, { contactId, subject: undefined, kind: "objection", receivedAt: "2026-09-16" });
    const done = await request(owner, { receivedAt: "2026-09-01", subject: { name: "Fertig" } });
    await owner.mutation(api.dsgvo.setRequestStatus, { id: done, to: "rejected", rejectionReason: "Doppelt" });
    const rows = await owner.query(api.dsgvo.list, {});
    expect(rows.map((r) => r.id)).toEqual([done, early, later]);
    expect(rows[1]).toMatchObject({ subject: "Paula Prospekt", contactId, dueAt: "2026-10-16", stage: "due7" });
    expect(rows[0]).toMatchObject({ stage: "none", overdue: false, identityVerified: null, extension: null });

    expect(await t.mutation(internal.dsgvo.deadlinesCron, {})).toBeNull(); // skipped under IS_TEST
    expect(await t.mutation(internal.dsgvo.deadlinesCron, { force: true })).toBe(1);
    const ntf = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(ntf.find((n) => n.kind === "dsgvo.deadline")?.title).toBe(
      "DSGVO-Anfrage von Paula Prospekt: Frist 16.10.2026",
    );
    // the contact disappears (complete erasure elsewhere): the register keeps a neutral label
    await t.run(async (ctx) => {
      const r = await ctx.db.get(early);
      expect(r?.remindedStage).toBe("due7");
    });
  });
});

describe("data subject search (E-PRV-16)", { timeout: 60_000 }, () => {
  test("E-PRV-16 an invalid address is refused; the e-invoice address (EM) of a contact is found", async () => {
    const t = makeT();
    const f = await finalizedInvoice(t);
    expect(messageOf(await catching(f.owner.query(api.dsgvo.searchSubject, { email: "kein-at" })))).toBe(
      "Bitte eine gültige E-Mail-Adresse angeben.",
    );
    const em = await f.owner.mutation(api.contacts.create, {
      values: createValues(
        personForm("Eva", "Einvoice", { electronicAddressScheme: "EM", electronicAddressValue: "Eva@Example.test" }),
      ),
    });
    const hits = await f.owner.query(api.dsgvo.searchSubject, { email: "eva@example.test" });
    expect(hits.find((h) => h.kind === "contact")).toMatchObject({ id: em.id, contactId: em.id });
    expect(hits.find((h) => h.kind === "contact")?.label).toContain("Eva Einvoice");
  });
});

describe("erasure / restriction refusals and variants (PRV-011, PRV-012)", { timeout: 60_000 }, () => {
  test("PRV-011 execute only for erasure/restriction requests of a contact, with identity, while open", async () => {
    const t = makeT();
    const { owner, contactId } = await ownerWithContact(t);
    const access = await request(owner, { contactId });
    expect(messageOf(await catching(owner.mutation(api.dsgvo.execute, { id: access })))).toBe(
      "Nur für Löschungs- oder Einschränkungsanfragen.",
    );
    const free = await request(owner, { kind: "erasure" });
    expect(messageOf(await catching(owner.mutation(api.dsgvo.execute, { id: free })))).toBe(
      "Die Anfrage ist keinem Kontakt zugeordnet.",
    );
    const done = await request(owner, { contactId, kind: "erasure" });
    await owner.mutation(api.dsgvo.verify, { id: done, method: "Rückruf" });
    await owner.mutation(api.dsgvo.setRequestStatus, { id: done, to: "done" });
    const err = await catching(owner.mutation(api.dsgvo.execute, { id: done }));
    expect(errorCode(err)).toBe("illegal_transition");
    expect(errorCode(await catching(owner.query(api.dsgvo.preview, { contactId: ghost("contacts") })))).toBe(
      "not_found",
    );
  });

  test("PRV-012 a restriction keeps all data, only restricts the contact; a later erasure deletes the restricted prospect completely", async () => {
    const t = makeT();
    const seeded = await ownerWithContact(t, {
      notes: "Bevorzugt Rückruf",
      birthday: "1980-05-01",
    });
    let owner = seeded.owner;
    const contactId = seeded.contactId;
    const restriction = await request(owner, { contactId, subject: undefined, kind: "restriction" });
    await owner.mutation(api.dsgvo.verify, { id: restriction, method: "Rückruf" });
    await owner.mutation(api.dsgvo.setRequestStatus, { id: restriction, to: "in_progress" });
    const res = await owner.mutation(api.dsgvo.execute, { id: restriction });
    expect(res).toMatchObject({ deleted: 0, contactDeleted: false });
    const c = await t.run((ctx) => ctx.db.get(contactId));
    expect(c).toMatchObject({ notes: "Bevorzugt Rückruf", birthday: "1980-05-01" });
    const restrictedAt = c?.dsgvo?.restrictedAt;
    expect(restrictedAt).toBeTypeOf("number");
    expect(c?.dsgvo?.deletionRequestedAt).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(restriction)))?.status).toBe("in_progress");
    expect(await owner.query(api.dsgvo.letter, { id: restriction })).toContain("eingeschränkt (Art. 18 DSGVO)");

    // the restricted prospect has no retained record: an erasure now deletes it completely
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
    owner = await t.asUser("owner", { existingUserId: owner.userId }); // fresh session for the erase re-auth
    const erasure = await request(owner, { contactId, subject: undefined, kind: "erasure" });
    await owner.mutation(api.dsgvo.verify, { id: erasure, method: "Rückruf" });
    const p = await owner.query(api.dsgvo.preview, { contactId });
    expect(p.clearFields).toEqual(expect.arrayContaining(["notes", "birthday"]));
    expect(p.receivablesNotice).toBeNull();
    expect(await owner.mutation(api.dsgvo.execute, { id: erasure })).toMatchObject({ contactDeleted: true });
    const req = await t.run((ctx) => ctx.db.get(erasure));
    expect(req?.erasure).toMatchObject({ contactDeleted: true, restricted: 0 });
    expect(req?.erasure?.scheduledPurgeAt).toBeUndefined();
    // the register keeps a neutral label once the contact is gone; the letter says everything was deleted
    const row = (await owner.query(api.dsgvo.list, {})).find((r) => r.id === erasure);
    expect(row?.subject).toBe("Kontakt");
    const letter = await owner.query(api.dsgvo.letter, { id: erasure });
    expect(letter).toContain("Ihre Daten wurden vollständig gelöscht");
    expect(letter).toContain("Sehr geehrte(r) Kontakt");
  });

  test("PRV-011 contact activities with attachments are erased together with their files (a missing file is skipped)", async () => {
    const t = makeT();
    const { owner, contactId } = await ownerWithContact(t);
    const kept = await t.run((ctx) => ctx.storage.store(new Blob(["Notiz"])));
    const lost = await t.run((ctx) => ctx.storage.store(new Blob(["weg"])));
    await t.run((ctx) => ctx.storage.delete(lost));
    const file = (storageId: Id<"_storage">) => ({
      storageId,
      sha256: "00",
      bytes: 5,
      mime: "text/plain",
      name: "n.txt",
    });
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "contactActivities",
        { contactId, kind: "note", text: "Gespräch", attachments: [file(kept), file(lost)], actor: OWNER.actor },
        { action: "contact.activity.create" },
      ),
    );
    const id = await request(owner, { contactId, subject: undefined, kind: "erasure" });
    await owner.mutation(api.dsgvo.verify, { id, method: "Rückruf" });
    const res = await owner.mutation(api.dsgvo.execute, { id });
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(await t.run((ctx) => ctx.db.system.get(kept))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("contactActivities").collect())).toEqual([]);
  });
});

describe("access export and letters (PRV-013, PRV-014)", { timeout: 60_000 }, () => {
  test("PRV-013 the export runs only for access/portability requests of a contact; a running request stays in progress", async () => {
    const t = makeT();
    const { owner, contactId } = await ownerWithContact(t);
    const erasure = await request(owner, { contactId, kind: "erasure" });
    expect(messageOf(await catching(owner.mutation(api.dsgvo.startExport, { id: erasure })))).toBe(
      "Nur für Auskunfts- oder Übertragbarkeitsanfragen.",
    );
    const free = await request(owner, { kind: "portability" });
    expect(messageOf(await catching(owner.mutation(api.dsgvo.startExport, { id: free })))).toBe(
      "Die Anfrage ist keinem Kontakt zugeordnet.",
    );
    const access = await request(owner, { contactId, kind: "portability" });
    await owner.mutation(api.dsgvo.setRequestStatus, { id: access, to: "in_progress" });
    const jobId = await t.model(OWNER, (ctx) => startAccessExport(ctx, access));
    expect((await t.run((ctx) => ctx.db.get(jobId)))?.label).toBe("DSGVO-Auskunft Paula Prospekt");
    const audits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((e) => e.action === "dsgvo.request.in_progress"),
    );
    expect(audits).toHaveLength(1); // only the manual move, not a second one by the export
    expect(await owner.query(api.dsgvo.resultUrl, { id: access })).toBeNull();
    // a prospect without documents or letters: the export data has empty lists
    const data = await t.run((ctx) => accessExportData(ctx, access));
    expect(data?.documents).toEqual([]);
    expect(data?.letters).toEqual([]);
  });

  test("PRV-014 the letter falls back to „Ihr Unternehmen“ without a company profile and names a free subject", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const id = await request(owner, { kind: "rectification", subject: { name: "Max Frei" } });
    const letter = await t.run((ctx) => responseLetter(ctx, id));
    expect(letter).toContain("Sehr geehrte(r) Max Frei");
    expect(letter).toContain("Ihr Unternehmen");
    expect(await owner.query(api.dsgvo.letter, { id })).toBe(letter);
  });
});
